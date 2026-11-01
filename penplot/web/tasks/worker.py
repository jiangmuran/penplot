# -*- coding: utf-8 -*-
"""Long-lived task worker processes.

A fresh child per task paid the full warm-up every time (open a big .gfont
≈ 2 s on the A53, import numpy ≈ 0.6 s, trace caches empty). A worker now
serves many tasks and keeps those caches; the sandbox is the same as before
(nice 15, oom_score_adj 500, RLIMIT_AS). Cancel still kills the process that
runs the task; the runner then starts a fresh worker for the next one.

Protocol over one duplex Pipe:
  parent -> worker: ('run', kind, args)
  worker -> parent: ('progress', f, msg)* then ('result', res) | ('error', err),
                    then ('idle', rss_mb)
"""
import os
import time


def _sandbox():
    for k in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
        os.environ[k] = '1'
    try:
        os.nice(15)
    except OSError:
        pass
    try:
        with open('/proc/self/oom_score_adj', 'w') as f:
            f.write('500')
    except OSError:
        pass
    try:
        import resource
        lim = int(os.environ.get('PENPLOT_TASK_RLIMIT_MB', '700')) * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (lim, lim))
    except (ImportError, ValueError, OSError):
        pass


def rss_mb():
    try:
        with open('/proc/self/statm') as f:
            return int(f.read().split()[1]) * os.sysconf('SC_PAGE_SIZE') / 1048576.0
    except (OSError, ValueError, IndexError):
        return 0.0


def worker_main(conn):
    _sandbox()
    from .kinds import KINDS, error_dict
    while True:
        try:
            msg = conn.recv()
        except (EOFError, OSError):
            return
        if not msg or msg[0] != 'run':
            return
        _, kind, args = msg
        last = [0.0]

        def progress(f, m=''):
            now = time.time()
            if now - last[0] >= 0.25:
                last[0] = now
                try:
                    conn.send(('progress', float(f), m))
                except Exception:
                    pass
        try:
            res = KINDS[kind](args, progress)
            conn.send(('result', res))
        except MemoryError:
            conn.send(('error', {'code': 'out_of_memory', 'message': '内存不足（图片太大？）', 'detail': None}))
        except BaseException as e:  # noqa
            try:
                conn.send(('error', error_dict(e)))
            except Exception:
                return
        try:
            conn.send(('idle', rss_mb()))
        except Exception:
            return
