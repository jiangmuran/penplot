"""TaskRunner: CPU work in sandboxed forkserver worker processes (03 §2.7).

Workers are long-lived and reused (see worker.py) so font/numpy/trace caches
survive between tasks; ≤N concurrent (≤1 while a job streams), FIFO.
Progress comes back over a Pipe (rate-limited in the child); cancel =
terminate(). Results are small dicts; big outputs go to files.
mode='thread' runs kinds in threads (tests/debug; cancel is cooperative).
"""
import asyncio
import collections
import itertools
import logging
import multiprocessing as mp
import threading
import time

from ..errors import ApiError

log = logging.getLogger('penplot.web.tasks')
_ids = itertools.count(1)
PRELOAD = ['penplot.layout', 'penplot.gcode', 'penplot.psf', 'penplot.geometry', 'penplot.compose',
           'penplot.web.tasks.kinds']


# per-request ids that do not change what is computed (render results go to <out_dir>/<rid>)
_VOLATILE = ('rid', 'out_dir')
# kinds whose identical requests share one task across slots/clients, and whose
# finished result (a render dir) is reused while it still exists
SHARED_KINDS = {'render_project', 'render_text'}
REUSE_DONE_S = 600


def _args_key(kind, args):
    import json
    try:
        if isinstance(args, dict):
            args = {k: v for k, v in args.items() if k not in _VOLATILE}
        return kind + json.dumps(args, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return None


def _result_alive(t):
    import os
    out = (t.args or {}).get('out_dir') if isinstance(t.args, dict) else None
    return bool(out) and os.path.isfile(os.path.join(out, 'result.json'))


class Task:
    def __init__(self, kind, args=None, fn=None, slot=None, on_done=None):
        self.id = 't%d%s' % (next(_ids), '%03x' % (int(time.time() * 1000) % 4096))
        self.kind = kind
        self.args = args
        self.fn = fn
        self.slot = slot
        self.on_done = on_done
        self.state = 'queued'
        self.progress = 0.0
        self.message = ''
        self.result = None
        self.error = None
        self.created_at = time.time()
        self.started_at = None
        self.finished_at = None
        self.done_ev = threading.Event()
        self.proc = None
        self.cancel_flag = False
        self.riders = 1            # requests waiting on this task (shared identical renders)
        self.key = None

    def to_dict(self, with_result=True):
        return {'id': self.id, 'kind': self.kind, 'state': self.state, 'progress': round(self.progress, 3),
                'message': self.message, 'result': self.result if with_result else None, 'error': self.error,
                'created_at': self.created_at, 'started_at': self.started_at,
                'finished_at': self.finished_at, 'slot': self.slot}


class _Worker:
    MAX_TASKS = 200            # recycle now and then (leaks, fragmentation)
    MAX_RSS_MB = 450.0         # a worker that grew this big is not reused

    def __init__(self, mpctx):
        from .worker import worker_main
        self.conn, child = mpctx.Pipe(duplex=True)
        self.proc = mpctx.Process(target=worker_main, args=(child,), daemon=True)
        self.proc.start()
        child.close()
        self.served = 0

    def alive(self):
        return self.proc is not None and self.proc.is_alive()

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass
        if self.proc is not None and self.proc.is_alive():
            self.proc.terminate()
            self.proc.join(2)


class TaskRunner:
    def __init__(self, ctx, workers=2, mode='process'):
        self.ctx = ctx
        self.workers = workers
        self.mode = mode
        self.tasks = collections.OrderedDict()
        self.queue = collections.deque()
        self.running = set()
        self._lock = threading.RLock()
        self._mpctx = None
        self._local = []
        self._idle = []            # idle Worker objects (process mode)

    def start(self):
        import os
        for k in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
            os.environ.setdefault(k, '1')        # inherited by the forkserver and every child
        if self.mode == 'process':
            try:
                self._mpctx = mp.get_context('forkserver')
                self._mpctx.set_forkserver_preload(PRELOAD)
            except ValueError:
                self._mpctx = mp.get_context('spawn')
            threading.Thread(target=self._prewarm, daemon=True, name='task-prewarm').start()

    def _prewarm(self):
        """Start one idle worker at boot so the first render does not pay the
        process start-up; failures are harmless (a worker is made on demand)."""
        try:
            w = _Worker(self._mpctx)
            self._give_back(w, 0.0)
        except Exception:
            log.debug('prewarm failed', exc_info=True)

    def stop(self):
        with self._lock:
            for t in list(self.running):
                self._kill(t)
            self.queue.clear()
            idle, self._idle = self._idle, []
        for w in idle:
            w.close()

    # ------------------------------------------------------------ api
    def limit(self):
        try:
            j = self.ctx.jobs.active
            if j is not None and j.status in ('running', 'preparing'):
                return 1
        except AttributeError:
            pass
        return self.workers

    def submit(self, kind, args, slot=None, on_done=None, quiet=False):
        """Run penplot.web.tasks.kinds.KINDS[kind](args, progress) in a child."""
        t = Task(kind, args, slot=slot, on_done=on_done)
        t.quiet = quiet            # no WS task events (e.g. font samples: many, tiny)
        with self._lock:
            if kind in SHARED_KINDS and slot:
                # Only slot-tagged (live preview) requests share: their callers read the rid
                # from the task result, whereas e.g. RenderService.rerender() picks its own rid.
                # Identical render (same doc/profile/fonts/files; only rid differs) from any
                # client/slot: ride on the queued/running one, or reuse a recent result. A page
                # reload or a second tab used to re-render the same page from scratch (~75 s
                # for a 4 400-stroke SVG on the board) while hogging a worker.
                t.key = key = _args_key(kind, args)
                if key is not None:
                    now = time.time()
                    for o in reversed(self.tasks.values()):
                        if o.key != key:
                            continue
                        if o.state in ('queued', 'running'):
                            o.riders += 1
                            self._supersede(slot, keep=o)
                            return o
                        if (o.state == 'done' and o.finished_at and now - o.finished_at < REUSE_DONE_S
                                and _result_alive(o)):
                            self._supersede(slot, keep=o)
                            return o
            if slot:
                # Superseding policy (live preview while typing): drop older *queued*
                # renders of this slot, but let a *running* one finish. Killing the
                # running render on every new request starves the slot on slow boards
                # (render ≈ 2 s on the A53 > edit interval) and the UI never gets a
                # result ("渲染中" forever). An identical request rides on the
                # running/queued task instead of starting another one.
                key = t.key if t.key is not None else _args_key(kind, args)
                for o in list(self.tasks.values()):
                    if o.slot != slot or o.state not in ('queued', 'running'):
                        continue
                    if key is not None and (o.key or _args_key(o.kind, o.args)) == key:
                        o.riders += 1
                        return o
                    if o.state == 'queued':
                        self._release(o)
            self.tasks[t.id] = t
            if not quiet:
                # real work (renders, job prep) jumps ahead of queued background
                # font samples, which a picker may request by the dozen
                for i, q in enumerate(self.queue):
                    if getattr(q, 'quiet', False):
                        self.queue.insert(i, t)
                        break
                else:
                    self.queue.append(t)
            else:
                self.queue.append(t)
            self._gc()
        self._publish(t)
        self._pump()
        return t

    def submit_local(self, kind, fn, on_done=None):
        """In-process thread task (I/O bound: font reindex)."""
        t = Task(kind, fn=fn, on_done=on_done)
        with self._lock:
            self.tasks[t.id] = t
        th = threading.Thread(target=self._run_local, args=(t,), daemon=True)
        th.start()
        return t

    def get(self, task_id):
        t = self.tasks.get(task_id)
        if t is None:
            raise ApiError(404, 'not_found', '任务不存在或已过期')
        return t

    def list(self, state=None):
        return [t.to_dict(with_result=False) for t in reversed(self.tasks.values())
                if state is None or t.state == state][:100]

    def active_list(self):
        return [t.to_dict(with_result=False) for t in self.tasks.values() if t.state in ('queued', 'running')]

    def cancel(self, task_id):
        t = self.get(task_id)
        with self._lock:
            self._release(t)
        self._pump()
        return t

    def _release(self, t):
        """One requester gives up on t; cancel it only when nobody else waits on it."""
        t.riders = max(0, t.riders - 1)
        if t.riders == 0:
            self._cancel(t)

    def _supersede(self, slot, keep):
        """Drop this slot's older queued requests (as a new submit in the slot would)."""
        if not slot:
            return
        for o in list(self.tasks.values()):
            if o is not keep and o.slot == slot and o.state == 'queued':
                self._release(o)

    async def wait(self, t, timeout):
        """-> result dict, or None if still running after timeout. Raises on failure."""
        if not t.done_ev.is_set() and timeout > 0:
            await asyncio.get_running_loop().run_in_executor(None, t.done_ev.wait, timeout)
        if not t.done_ev.is_set():
            return None
        if t.state == 'done':
            return t.result
        if t.state == 'cancelled':
            raise ApiError(409, 'cancelled', '任务已被取消（被新的渲染取代？）', {'task_id': t.id})
        err = t.error or {}
        code = err.get('code', 'task_failed')
        status = {'font_not_found': 404, 'file_not_found': 404, 'not_found': 404,
                  'feature_unavailable': 501, 'bad_element': 400, 'bad_input': 400, 'unsafe_gcode': 400,
                  'too_large': 413, 'zip_bomb': 413, 'bad_bundle': 400, 'bad_table': 400, 'bad_image': 400,
                  'bad_svg': 400, 'bad_dxf': 400, 'out_of_memory': 413, 'bad_gcode': 400}.get(code, 500)
        raise ApiError(status, code, err.get('message', '任务失败'), err.get('detail'))

    # ------------------------------------------------------------ internals
    def _gc(self):
        while len(self.tasks) > 200:
            k, old = next(iter(self.tasks.items()))
            if old.state in ('queued', 'running'):
                break
            self.tasks.pop(k)

    def _cancel(self, t):
        if t.state == 'queued':
            try:
                self.queue.remove(t)
            except ValueError:
                pass
            self._done(t, 'cancelled')
        elif t.state == 'running':
            t.cancel_flag = True
            self._kill(t)

    def _kill(self, t):
        p = t.proc
        if p is not None and p.is_alive():
            p.terminate()

    QUIET_LANE = 1     # quiet tasks (font samples, ~0.1 s each) that may run beyond limit()

    def _next_runnable(self):
        """Heavy tasks obey limit(); quiet ones may also use their own lane, so a picker's font
        samples are not stuck behind a 10–75 s page render (each waiting <img> holds one of the
        browser's 6 connections, which stalled every other request of the app — 09-perf)."""
        limit = self.limit()
        n_quiet = sum(1 for r in self.running if getattr(r, 'quiet', False))
        n_all = len(self.running)
        for t in self.queue:
            if n_all < limit:
                return t
            if getattr(t, 'quiet', False) and n_quiet < self.QUIET_LANE:
                return t
        return None

    def _pump(self):
        with self._lock:
            while self.queue:
                t = self._next_runnable()
                if t is None:
                    break
                self.queue.remove(t)
                self.running.add(t)
                t.state = 'running'
                t.started_at = time.time()
                threading.Thread(target=self._run, args=(t,), daemon=True, name='task-' + t.id).start()
                self._publish(t)

    def _run(self, t):
        try:
            if self.mode == 'process':
                self._run_process(t)
            else:
                self._run_thread(t)
        except Exception as e:
            log.exception('task %s', t.id)
            if not t.done_ev.is_set():
                self._done(t, 'failed', error={'code': 'task_failed', 'message': str(e), 'detail': None})
        finally:
            with self._lock:
                self.running.discard(t)
            self._pump()

    def _take_worker(self):
        with self._lock:
            while self._idle:
                w = self._idle.pop()
                if w.alive():
                    return w
                w.close()
        return _Worker(self._mpctx)

    def _give_back(self, w, rss):
        if not w.alive() or w.served >= _Worker.MAX_TASKS or rss > _Worker.MAX_RSS_MB:
            w.close()
            return
        with self._lock:
            if len(self._idle) < max(1, self.workers):
                self._idle.append(w)
                return
        w.close()

    def _run_process(self, t):
        if t.cancel_flag:
            self._done(t, 'cancelled')
            return
        w = self._take_worker()
        t.proc = w.proc
        if t.cancel_flag:            # cancelled while starting
            w.close()
            self._done(t, 'cancelled')
            return
        try:
            w.conn.send(('run', t.kind, t.args))
        except (OSError, EOFError, ValueError) as e:
            w.close()
            raise RuntimeError('worker unavailable: %s' % e)
        result = None
        error = None
        rss = None
        last_pub = 0.0
        while True:
            try:
                if w.conn.poll(0.2):
                    msg = w.conn.recv()
                    if msg[0] == 'progress':
                        t.progress, t.message = msg[1], msg[2]
                        if time.time() - last_pub > 0.25:
                            last_pub = time.time()
                            self._publish(t)
                    elif msg[0] == 'result':
                        result = msg[1]
                    elif msg[0] == 'error':
                        error = msg[1]
                    elif msg[0] == 'idle':
                        rss = msg[1]
                        break
                elif not w.alive():
                    break
            except (EOFError, OSError):
                break
        w.served += 1
        if rss is not None and not t.cancel_flag:
            self._give_back(w, rss)
        else:
            exitcode = w.proc.exitcode
            w.close()
            if error is None and result is None and not t.cancel_flag:
                error = {'code': 'task_crashed', 'message': '子进程异常退出（内存不足？）退出码 %s' % exitcode,
                         'detail': None}
        if t.cancel_flag:
            self._done(t, 'cancelled')
        elif result is not None:
            self._done(t, 'done', result=result)
        else:
            self._done(t, 'failed', error=error)

    def _run_thread(self, t):
        from . import kinds

        def progress(f, msg=''):
            if t.cancel_flag:
                raise kinds.Cancelled()
            t.progress, t.message = f, msg
        try:
            res = kinds.KINDS[t.kind](t.args, progress)
            if t.cancel_flag:
                self._done(t, 'cancelled')
            else:
                self._done(t, 'done', result=res)
        except kinds.Cancelled:
            self._done(t, 'cancelled')
        except Exception as e:
            self._done(t, 'failed', error=kinds.error_dict(e))

    def _run_local(self, t):
        t.state = 'running'
        t.started_at = time.time()
        self._publish(t)
        try:
            res = t.fn(lambda f, m='': setattr(t, 'progress', f))
            self._done(t, 'done', result=res if isinstance(res, dict) else {'value': res})
        except Exception as e:
            from . import kinds
            self._done(t, 'failed', error=kinds.error_dict(e))

    def _done(self, t, state, result=None, error=None):
        if t.on_done is not None and state == 'done':
            try:
                r2 = t.on_done(result)
                if r2 is not None:
                    result = r2
            except Exception as e:
                log.exception('on_done %s', t.id)
                state, error = 'failed', {'code': 'task_failed', 'message': str(e), 'detail': None}
        t.state = state
        t.result = result
        t.error = error
        t.progress = 1.0 if state == 'done' else t.progress
        t.finished_at = time.time()
        if state == 'failed':
            log.warning('task %s (%s) failed: %s', t.id, t.kind, error)
        t.done_ev.set()
        self._publish(t)

    def _publish(self, t):
        if getattr(t, 'quiet', False):
            return
        d = {'task_id': t.id, 'kind': t.kind, 'state': t.state, 'progress': round(t.progress, 3),
             'message': t.message, 'result': t.result if t.state == 'done' else None, 'error': t.error}
        try:
            self.ctx.bus.publish_threadsafe('task', d)
        except Exception:
            pass
