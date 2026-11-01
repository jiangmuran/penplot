"""Jobs: DB rows + the one active JobRunner (03 §2.3)."""
import asyncio
import logging
import os
import secrets
import threading
import time

from ...gcode import analyze_gcode
from ...layout import OriginSpec
from ...machine import Sender
from ..db import jdump, jload
from ..errors import ApiError, not_found

log = logging.getLogger('penplot.web.jobs')

ACTIVE = ('preparing', 'running', 'paused', 'stopping')
TERMINAL = ('done', 'failed', 'aborted')
PLANNER_BLOCKS = 15


class ActiveJob:
    """In-memory state of the job that owns the stream."""

    def __init__(self, row, lines, analysis):
        self.id = row['id']
        self.row = row
        self.status = row['status']
        self.lines = lines
        self.analysis = analysis
        self.sender = None
        self.started = None
        self.paused_at = None
        self.paused_total = 0.0
        self.pause_mode = None
        self.pause_pos = None         # wpos captured before the first manual move while paused
        self.moved = False
        self.end_reason = None        # set before abort: estop / user_stop / shutdown
        self.errors = []
        self.last_ckpt = 0.0
        self.origin_epoch = None
        self.stop_on_error = True
        self.finishing = False

    def elapsed(self, now=None):
        if not self.started:
            return 0.0
        now = now or time.time()
        paused = self.paused_total + ((now - self.paused_at) if self.paused_at else 0.0)
        return max(0.0, now - self.started - paused)


class JobService:
    def __init__(self, ctx):
        self.ctx = ctx
        self.db = ctx.db
        self.cfg = ctx.cfg
        self.bus = ctx.bus
        self.active = None
        self._lock = threading.RLock()
        os.makedirs(self.cfg.jobs_dir, exist_ok=True)

    @property
    def m(self):
        return self.ctx.machine

    # ------------------------------------------------------------ startup / shutdown
    def recover(self):
        rows = self.db.all('SELECT * FROM jobs WHERE status IN (%s)' % ','.join('?' * len(ACTIVE)), ACTIVE)
        for r in rows:
            log.warning('job %s was %s at startup -> failed(process_crash)', r['id'], r['status'])
            self._set_status(r['id'], r['status'], 'failed', 'process_crash',
                             finished_at=time.time(), publish=False)

    async def shutdown(self):
        a = self.active
        if a is None:
            return
        self.bus.publish('notice', {'level': 'warning', 'code': 'shutdown', 'message': '服务正在停止'})
        if a.status in ('running', 'paused') and a.sender is not None:
            a.end_reason = 'shutdown'
            await asyncio.get_running_loop().run_in_executor(None, self._stop_blocking, a)
            end = time.time() + 30
            while self.active is a and time.time() < end:
                await asyncio.sleep(0.2)
        if self.active is a:
            self._finish(a, 'aborted', 'shutdown')

    # ------------------------------------------------------------ rows -> API
    def _row(self, job_id):
        r = self.db.one('SELECT * FROM jobs WHERE id=?', (job_id,))
        if not r:
            raise not_found('任务')
        return r

    def to_api(self, r):
        a = self.active if self.active is not None and self.active.id == r['id'] else None
        total = r['total_lines'] or 0
        acked = r['acked_line'] or 0
        sent = acked
        elapsed = r['elapsed_s'] or 0.0
        eta = None
        status = r['status']
        errors = jload(r['errors'], [])
        if a is not None:
            status = a.status
            if a.sender is not None:
                acked = a.sender.acked_line
                sent = a.sender.sent_line
            elapsed = a.elapsed()
            eta = self._eta(a, acked, elapsed)
            errors = errors + a.errors
        elif status == 'queued':
            eta = r['est_s'] * float(self.ctx.settings.value('eta_factor', 1.0))
        retry = None
        if status in ('failed', 'aborted') and acked > 0:
            retry = max(1, acked - PLANNER_BLOCKS)
        return {
            'id': r['id'], 'name': r['name'], 'status': status, 'reason': r['reason'],
            'batch_id': r['batch_id'], 'seq': r['seq'], 'source': jload(r['source'], {}),
            'profile_id': r['profile_id'], 'overrides': jload(r['overrides'], {}) or {},
            'total_lines': total, 'acked_line': acked, 'sent_line': sent,
            'percent': round(100.0 * acked / total, 1) if total else (100.0 if status == 'done' else 0.0),
            'est_s': r['est_s'] or 0.0, 'elapsed_s': round(elapsed, 1),
            'eta_s': round(eta, 1) if eta is not None else None, 'errors': errors[-50:],
            'origin': jload(r['origin']), 'bbox': jload(r['bbox']),
            'out_of_work_area': bool(r['out_of_work_area']),
            'created_at': r['created_at'], 'started_at': r['started_at'], 'finished_at': r['finished_at'],
            'pause_mode': a.pause_mode if a is not None and a.status == 'paused' else None,
            'can_retry_from': retry,
            'issues': jload(r.get('issues'), []) or [],
        }

    def _eta(self, a, acked, elapsed):
        an = a.analysis
        T = an.est_s
        Ta = an.time_until(acked)
        if elapsed >= 30 and Ta > 1.0:
            k = max(0.5, min(3.0, elapsed / Ta))
        else:
            k = float(self.ctx.settings.value('eta_factor', 1.0))
        return max(0.0, (T - Ta) * k)

    def get(self, job_id):
        return self.to_api(self._row(job_id))

    def list(self, status=None, batch_id=None, limit=100):
        q = 'SELECT * FROM jobs WHERE 1=1'
        args = []
        if status:
            st = [s for s in status.split(',') if s]
            q += ' AND status IN (%s)' % ','.join('?' * len(st))
            args += st
        if batch_id:
            q += ' AND batch_id=?'
            args.append(batch_id)
        q += ' ORDER BY created_at DESC, seq ASC LIMIT ?'
        args.append(int(limit))
        return [self.to_api(r) for r in self.db.all(q, args)]

    def current(self):
        a = self.active
        if a is None:
            return None
        return self.get(a.id)

    def progress(self):
        a = self.active
        if a is None or a.sender is None:
            return None
        s = a.sender
        el = a.elapsed()
        c = self.m.ctrl
        r = a.row
        return {'job_id': a.id, 'line_acked': s.acked_line, 'line_sent': s.sent_line,
                'total': r['total_lines'],
                'percent': round(100.0 * s.acked_line / r['total_lines'], 1) if r['total_lines'] else 0.0,
                'elapsed_s': round(el, 1), 'eta_s': round(self._eta(a, s.acked_line, el), 1),
                'wpos': [round(v, 3) for v in c.wpos] if c and getattr(c, 'wpos', None) else None,
                'page': (jload(r['source'], {}) or {}).get('page'),
                'batch_seq': r['seq'] if r['batch_id'] else None}

    def checkpoint(self, force=False):
        a = self.active
        if a is None or a.sender is None:
            return
        now = time.time()
        if force or now - a.last_ckpt >= 15:
            a.last_ckpt = now
            self.db.execute('UPDATE jobs SET acked_line=?, elapsed_s=? WHERE id=?',
                            (a.sender.acked_line, a.elapsed(now), a.id))

    # ------------------------------------------------------------ transitions
    def _set_status(self, job_id, frm, to, reason=None, publish=True, **cols):
        sets = ['status=?', 'reason=?']
        args = [to, reason]
        for k, v in cols.items():
            sets.append('%s=?' % k)
            args.append(v)
        args.append(job_id)
        self.db.execute('UPDATE jobs SET %s WHERE id=?' % ', '.join(sets), args)
        self.db.execute('INSERT INTO job_events(job_id,ts,from_state,to_state,detail) VALUES(?,?,?,?,?)',
                        (job_id, time.time(), frm, to, reason))
        if publish:
            self._publish(job_id, frm, to, reason)

    def _publish(self, job_id, frm, to, reason=None):
        try:
            job = self.get(job_id) if to != 'deleted' else None
        except ApiError:
            job = None
        self.bus.publish_threadsafe('job', {'job_id': job_id, 'from': frm, 'to': to, 'reason': reason,
                                            'job': job})

    def _transition(self, a, to, reason=None, **cols):
        with self._lock:
            frm = a.status
            if frm == to:
                return
            a.status = to
            self._set_status(a.id, frm, to, reason, **cols)

    def _finish(self, a, to, reason=None):
        with self._lock:
            if self.active is not a or a.status in TERMINAL:
                return
            s = a.sender
            acked = s.acked_line if s else a.row['acked_line']
            frm = a.status
            a.status = to
            el = a.elapsed()
            errs = jload(a.row['errors'], []) + a.errors
            self.active = None
            if s is not None:
                s.detach()
            pend = getattr(self.m, 'pending_profile', None)
            if pend is not None:
                self.m.pending_profile = None
                self.m.load_profile(pend)
            self._set_status(a.id, frm, to, reason, finished_at=time.time(), acked_line=acked,
                             elapsed_s=el, errors=jdump(errs[-50:]))
        if to == 'done' and a.analysis.est_s > 30 and el > 0:
            old = float(self.ctx.settings.value('eta_factor', 1.0))
            k = max(0.5, min(3.0, el / a.analysis.est_s))
            self.ctx.settings.set_value('eta_factor', round(0.7 * old + 0.3 * k, 3))
        log.info('job %s -> %s (%s)', a.id, to, reason)
        self._attention_finish(a, to, reason)
        if to == 'done':
            self._maybe_auto_advance(a)

    def _attention_finish(self, a, to, reason):
        name = a.row['name']
        bid = a.row['batch_id']
        nxt = None
        if bid:
            nxt = self.db.one("SELECT id, seq, name FROM jobs WHERE batch_id=? AND status='queued' ORDER BY seq LIMIT 1",
                              (bid,))
        if to == 'done':
            if nxt and not self.ctx.settings.value('batch_auto_advance', False):
                self.ctx.attention('paper_change', '「%s」写完了，换上下一张纸后继续（第 %d 张）' % (name, nxt['seq']),
                                   'warning', 'paper', job_id=a.id, batch_id=bid, next_job_id=nxt['id'])
            else:
                self.ctx.attention('job_done', '「%s」写完了' % name, 'info', 'done', job_id=a.id, batch_id=bid)
        elif to == 'failed':
            msg = {'serial_lost': '串口断开', 'process_crash': '服务异常重启', 'gcode_error': '固件拒绝了一行 G 代码',
                   'alarm_locked': '机器处于报警锁定'}.get(reason, reason or '')
            if reason and reason.startswith('alarm:'):
                msg = '机器报警（%s）' % reason.upper()
            self.ctx.attention('job_failed', '「%s」失败：%s' % (name, msg), 'error', 'error', job_id=a.id, reason=reason)
        elif to == 'aborted' and reason == 'estop':
            self.ctx.attention('estop', '已急停：「%s」' % name, 'error', 'error', job_id=a.id)

    def _maybe_auto_advance(self, a):
        bid = a.row['batch_id']
        if not bid or not self.ctx.settings.value('batch_auto_advance', False):
            return
        nxt = self.db.one("SELECT id FROM jobs WHERE batch_id=? AND status='queued' ORDER BY seq LIMIT 1", (bid,))
        if nxt and self.m.loop:
            delay = float((jload(a.row['overrides'], {}) or {}).get('pause_between_pages_s') or 0)

            async def go():
                await asyncio.sleep(delay)
                try:
                    await self.start(nxt['id'], None)
                except ApiError as e:
                    log.warning('auto-advance: %s', e.message)
            asyncio.run_coroutine_threadsafe(go(), self.m.loop)

    # ------------------------------------------------------------ create
    async def create(self, body, actor='-'):
        src = body.source
        prof = self.ctx.profiles.get(body.profile_id) if body.profile_id else self.ctx.profiles.active()
        overrides = body.overrides.model_dump(exclude_none=True) if body.overrides else {}
        pages = []      # [(gcode_text, source_dict, name_suffix)]
        name = body.name
        if src.file_id:
            f = self.ctx.files.get(src.file_id)
            if f['kind'] != 'gcode':
                raise ApiError(400, 'bad_source', '只能从 G 代码文件创建任务（其它文件请放进工程渲染）')
            pages.append((None, {'file_id': src.file_id}, '', self.ctx.files.blob_path(f)))
            name = name or f['name']
        elif src.render_id or src.project_id:
            rid = src.render_id
            if rid and overrides and self.ctx.render.overrides_affect_gcode(overrides, rid):
                rid = await self.ctx.render.rerender(rid, overrides)
            if not rid:
                from ..schemas import RenderRequest
                req = RenderRequest(variables=src.variables or {}, overrides=body.overrides,
                                    profile_id=body.profile_id)
                task = await asyncio.get_running_loop().run_in_executor(
                    None, self.ctx.render.submit_project, src.project_id, req, None)
                res = await self.ctx.tasks.wait(task, 130)
                if res is None:
                    self.ctx.tasks.cancel(task.id)
                    raise ApiError(503, 'render_timeout', '渲染超时（页面太复杂？）')
                rid = res['rid']
            rr = self.ctx.render.get(rid)
            idxs = [src.page] if src.page is not None else [p['index'] for p in rr['pages']]
            if (overrides.get('multi_page') or 'separate_jobs') == 'first_only':
                idxs = idxs[:1]
            for i in idxs:
                path = self.ctx.render.gcode_path(rid, i)
                s = {'render_id': rid, 'page': i, 'project_id': rr.get('project_id') or src.project_id,
                     'rev': rr.get('project_rev'), 'variables': src.variables, 'batch_row': src.batch_row}
                pages.append((None, s, ' 第%d页' % (i + 1) if len(idxs) > 1 else '', path))
            if not name:
                name = rr.get('name') or ('工程 %s' % (rr.get('project_id') or '')).strip() or '渲染'
        else:
            raise ApiError(400, 'bad_source', 'source 需要 file_id、render_id 或 project_id')
        copies = int(overrides.get('copies') or 1)
        if copies > 1 and (overrides.get('copy_mode') or 'repeat_same') == 'repeat_same':
            pages = [(g, s, suf + ('（%d/%d）' % (k + 1, copies)), sp) for g, s, suf, sp in pages for k in range(copies)]
        batch_id = 'b' + secrets.token_hex(4) if len(pages) > 1 else None
        ids = []
        for seq, (text, s, suffix, sp) in enumerate(pages, 1):
            ids.append(await self._insert(text, s, (name or '任务') + suffix, prof, overrides, batch_id, seq,
                                          src_path=sp))
        if body.start:
            return await self.start(ids[0], None, actor=actor,
                                    allow_out_of_bounds=bool(getattr(body, 'allow_out_of_bounds', False)))
        return self.get(ids[0])

    async def _insert(self, text, source, name, prof, overrides, batch_id=None, seq=1, src_path=None,
                      origin_extra=None):
        """Sanitize + analyse in a task child (P1/P10), store the clean G-code, insert the row."""
        jid = 'j' + secrets.token_hex(4)
        path = os.path.join(self.cfg.jobs_dir, jid + '.gcode')
        tmp = None
        if src_path is None:
            tmp = path + '.raw'
            with open(tmp, 'w', encoding='utf-8', newline='') as fh:
                fh.write(text)
            src_path = tmp
        task = self.ctx.tasks.submit('prepare_job_gcode', {'src': src_path, 'dst': path, 'profile_doc': prof['doc'],
                                                           'overrides': overrides,
                                                           'apply_placement': bool(source.get('file_id'))})
        try:
            a = await self.ctx.tasks.wait(task, 300)
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        if a is None:
            self.ctx.tasks.cancel(task.id)
            raise ApiError(503, 'analysis_timeout', 'G 代码分析超时（文件太大？）')
        snap = dict(prof['doc'])
        snap['_overrides'] = overrides
        now = time.time()
        org = OriginSpec.coerce(a['origin']).__dict__
        org.update(origin_extra or {})
        issues = a.get('issues') or []
        self.db.execute(
            'INSERT INTO jobs(id,batch_id,seq,name,source,profile_id,overrides,profile_snapshot,status,total_lines,'
            'est_s,origin,bbox,out_of_work_area,issues,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (jid, batch_id, seq, name[:200], jdump(source), prof['id'], jdump(overrides), jdump(snap), 'queued',
             a['lines'], a['est_s'], jdump(org), jdump(a['travel_bbox'] or a['bbox']),
             1 if issues else 0, jdump(issues), now))
        self._publish(jid, None, 'queued')
        return jid

    async def patch(self, job_id, body):
        r = self._row(job_id)
        if r['status'] != 'queued':
            raise ApiError(409, 'bad_state', '只有排队中的任务可以修改')
        if body.name:
            self.db.execute('UPDATE jobs SET name=? WHERE id=?', (body.name[:200], job_id))
        if body.overrides is not None:
            ov = body.overrides.model_dump(exclude_none=True)
            src = jload(r['source'], {})
            if src.get('render_id') and self.ctx.render.overrides_affect_gcode(ov, src['render_id']):
                rid = await self.ctx.render.rerender(src['render_id'], ov)
                src['render_id'] = rid
                prof = self.ctx.profiles.get(r['profile_id']) if r['profile_id'] else self.ctx.profiles.active()
                task = self.ctx.tasks.submit('prepare_job_gcode', {
                    'src': self.ctx.render.gcode_path(rid, src.get('page') or 0),
                    'dst': os.path.join(self.cfg.jobs_dir, job_id + '.gcode'), 'profile_doc': prof['doc'],
                    'overrides': ov})
                a = await self.ctx.tasks.wait(task, 300)
                if a is None:
                    raise ApiError(503, 'analysis_timeout', 'G 代码分析超时')
                self.db.execute('UPDATE jobs SET source=?, total_lines=?, est_s=?, bbox=?, issues=?, '
                                'out_of_work_area=? WHERE id=?',
                                (jdump(src), a['lines'], a['est_s'], jdump(a['travel_bbox'] or a['bbox']),
                                 jdump(a['issues']), 1 if a['issues'] else 0, job_id))
            self.db.execute('UPDATE jobs SET overrides=? WHERE id=?', (jdump(ov), job_id))
        self._publish(job_id, 'queued', 'queued')
        return self.get(job_id)

    def delete(self, job_id):
        r = self._row(job_id)
        if r['status'] in ACTIVE:
            raise ApiError(409, 'job_active', '任务进行中，不能删除')
        self.db.execute('DELETE FROM jobs WHERE id=?', (job_id,))
        self.db.execute('DELETE FROM job_events WHERE job_id=?', (job_id,))
        for ext in ('.gcode', '.gcode.an.pkl'):
            try:
                os.unlink(os.path.join(self.cfg.jobs_dir, job_id + ext))
            except OSError:
                pass
        self._publish(job_id, r['status'], 'deleted')

    def gcode_path(self, job_id):
        r = self._row(job_id)
        p = os.path.join(self.cfg.jobs_dir, job_id + '.gcode')
        if not os.path.exists(p):
            raise not_found('任务 G 代码')
        return p, '%s.gcode' % r['name']

    def log(self, job_id, since_seq, limit):
        self._row(job_id)
        return self.m.log_slice(since_seq, limit)

    def batch(self, batch_id):
        jobs = self.list(batch_id=batch_id, limit=10000)
        if not jobs:
            raise not_found('批次')
        jobs.sort(key=lambda j: j['seq'])
        nxt = next((j['id'] for j in jobs if j['status'] == 'queued'), None)
        return {'id': batch_id, 'jobs': jobs, 'next_job_id': nxt}

    async def start_next(self, batch_id, actor='-'):
        b = self.batch(batch_id)
        if not b['next_job_id']:
            raise ApiError(409, 'batch_done', '批次中没有排队的任务')
        return await self.start(b['next_job_id'], None, actor=actor)

    def delete_batch(self, batch_id):
        for j in self.batch(batch_id)['jobs']:
            if j['status'] not in ACTIVE:
                self.delete(j['id'])

    # ------------------------------------------------------------ start
    async def start(self, job_id, set_zero=None, actor='-', allow_out_of_bounds=False, pen_up_confirmed=False):
        a = self.active
        if a is not None:
            if a.id == job_id:
                return self.get(job_id)          # idempotent
            raise ApiError(409, 'job_active', '已有任务在进行', {'job_id': a.id})
        r = self._row(job_id)
        if r['status'] != 'queued':
            raise ApiError(409, 'bad_state', '任务状态为 %s，不能开始（可用重试）' % r['status'])
        m = self.m
        m.require_connected()
        tt = getattr(self.ctx, 'teletype', None)
        if tt is not None and tt.session is not None:
            raise ApiError(409, 'teletype_active', '电传打字机会话占用着机器，请先结束会话')
        if m.estopping:
            raise ApiError(409, 'machine_busy', '急停处理中')
        snap = jload(r['profile_snapshot'], {})
        ov = jload(r['overrides'], {}) or {}
        issues = jload(r.get('issues'), []) or []
        if (r['out_of_work_area'] or issues) and not allow_out_of_bounds:
            wa = snap.get('work_area') or {}
            raise ApiError(409, 'out_of_work_area', '这个任务不安全，已阻止开始：%s。请调整位置/纸张，'
                           '或由管理员选择「仍要打印」' % ('；'.join(issues) or '超出工作区'),
                           {'bbox': jload(r['bbox']), 'work_area': wa, 'issues': issues})
        if allow_out_of_bounds and (r['out_of_work_area'] or issues):
            self.ctx.db.audit(actor, 'job_start_out_of_bounds', {'job_id': job_id, 'issues': issues})
        org = jload(r['origin'], {}) or {}
        if set_zero is None:
            set_zero = org.get('set_zero_at_start')
        if set_zero is None:
            set_zero = bool((snap.get('settings') or {}).get('autoSetZero', True))
        if not set_zero and not m.origin_valid:
            raise ApiError(409, 'origin_invalid', '原点无效：请先设零，或开始时设零')
        need_epoch = org.get('require_epoch')
        if need_epoch is not None:
            if set_zero:
                raise ApiError(409, 'origin_invalid', '续写任务不能重新设零（会写偏）')
            if need_epoch != m.origin_epoch or not m.origin_valid:
                raise ApiError(409, 'origin_invalid', '原点在原任务之后变过（设零/复位/重连），不能从中间续写；'
                               '只能从头开始', {'expected_epoch': need_epoch, 'epoch': m.origin_epoch})
        # Z joins the start-time zero when the operator confirmed the pen is up, or
        # the profile says so (settings.zeroZAtStart: the pen is always parked up
        # at the start point). Otherwise P6 holds: Z is never zeroed implicitly.
        zero_z = bool(pen_up_confirmed) or bool((snap.get('settings') or {}).get('zeroZAtStart', False))
        if set_zero and not m.z_valid and not zero_z:
            raise ApiError(409, 'pen_unknown', '笔的高度未知（刚连接/复位过）：先把笔抬到抬笔位，然后「设为原点」'
                           '（含 Z），再开始', {'hint': 'POST /machine/zero {"axes":"xyz"} with the pen up'})
        path = os.path.join(self.cfg.jobs_dir, job_id + '.gcode')
        loop = asyncio.get_running_loop()
        text, an = await loop.run_in_executor(None, self._load_job_analysis, path, m.mc)
        lines = [ln.strip() for ln in text.split('\n') if ln.strip()]
        with self._lock:
            if self.active is not None:
                raise ApiError(409, 'job_active', '已有任务在进行', {'job_id': self.active.id})
            a = ActiveJob(r, lines, an)
            a.zero_z = zero_z
            a.stop_on_error = ov.get('stop_on_error', True) is not False
            from ..printcfg import effective
            a.mc, _o, _org = effective({k: v for k, v in snap.items() if k != '_overrides'}, {}, ov)
            self.active = a
            self._transition(a, 'preparing')
        self.ctx.db.audit(actor, 'job_start', {'job_id': job_id})
        try:
            await loop.run_in_executor(m._exec, self._prepare_blocking, a, set_zero)
        except ApiError as e:
            self._finish(a, 'failed', e.code)
            raise
        except Exception as e:
            log.exception('prepare')
            self._finish(a, 'failed', 'prepare_failed')
            raise ApiError(500, 'prepare_failed', '准备失败：%s' % e)
        return self.get(job_id)

    @staticmethod
    def _load_job_analysis(path, mc, text=None):
        """-> (gcode text, GcodeAnalysis). Uses the analysis the prepare task saved
        next to the job file (<job>.gcode.an.pkl); re-analyses only if it is missing
        or older than the G-code (legacy jobs)."""
        if text is None:
            with open(path, encoding='utf-8', errors='replace') as fh:
                text = fh.read()
        pkl = path + '.an.pkl'
        try:
            if os.path.getmtime(pkl) >= os.path.getmtime(path):
                import pickle
                with open(pkl, 'rb') as f:
                    an = pickle.load(f)
                if getattr(an, 'times', None) is not None:
                    return text, an
        except (OSError, EOFError, ImportError, AttributeError, ValueError):
            pass
        except Exception:
            log.warning('job analysis cache unreadable: %s', pkl, exc_info=True)
        return text, analyze_gcode(text, mc)

    def _prepare_blocking(self, a, set_zero):
        m = self.m
        c = m.ctrl
        if c is None or not c.connected:
            raise ApiError(503, 'not_connected', '机器未连接')
        if a.end_reason:          # e-stop during preparing
            raise ApiError(409, a.end_reason, '已中止')
        st = c.query_status(2.0) if hasattr(c, 'query_status') else 'Idle'
        if st and st.startswith('Alarm'):
            raise ApiError(409, 'alarm_locked', '机器处于报警锁定状态，请先解锁')
        if set_zero:
            # P6: XY only, unless Z was explicitly allowed (pen confirmed up /
            # profile zeroZAtStart): then the current Z (pen at rest) becomes Z0
            zero_z = getattr(a, 'zero_z', False)
            if not m.z_valid and not zero_z:
                raise ApiError(409, 'pen_unknown', '笔的高度未知，请先抬笔并设零（含 Z）')
            if zero_z:
                ok = c.set_zero('xyz')
                if ok:
                    m.z_valid = True
                    m.pen_state = 'up'
            else:
                c.set_pen(True)
                ok = c.set_zero('xy')
            if not ok:
                raise ApiError(409, 'zero_failed', '设零失败')
            m.origin_valid = True
            m.origin_epoch += 1
        a.origin_epoch = m.origin_epoch
        org = jload(a.row['origin'], {}) or {}
        org['epoch'] = m.origin_epoch
        self.db.execute('UPDATE jobs SET origin=? WHERE id=?', (jdump(org), a.id))
        if not c.pen_cmd_for(a.mc, True) or not c.send(c.pen_cmd_for(a.mc, True), True):
            raise ApiError(409, 'pen_failed', '抬笔失败')
        if a.end_reason:
            raise ApiError(409, a.end_reason, '已中止')
        s = Sender(c, stop_on_error=a.stop_on_error, machine=a.mc, allow_dollar=False)
        s.on_complete = lambda: self._on_complete(a)
        s.on_error = lambda cmd, reply: self._on_error(a, cmd, reply)
        s.load_commands(a.lines)
        a.sender = s
        a.started = time.time()
        self._transition(a, 'running', started_at=a.started)
        s.start()

    # ------------------------------------------------------------ stream callbacks (RX thread)
    def _on_error(self, a, cmd, reply):
        s = a.sender
        line = s.error_lines[-1] if s and s.error_lines and cmd is not None else None
        e = {'line': line, 'cmd': cmd, 'reply': reply, 'ts': time.time()}
        if cmd is not None:
            a.errors.append(e)
            self.bus.publish_threadsafe('error', {'job_id': a.id, 'line': line, 'cmd': cmd, 'reply': reply})
            self.ctx.attention('gcode_error', '第 %s 行被固件拒绝（%s）' % (line, reply), 'error', 'error',
                               job_id=a.id, line=line)

    def _on_complete(self, a):
        if a.finishing:
            return
        a.finishing = True
        # finish off the RX thread: waiting for Idle must not block it
        threading.Thread(target=self._complete_blocking, args=(a,), daemon=True).start()

    def _complete_blocking(self, a):
        s = a.sender
        m = self.m
        if a.end_reason == 'estop':
            return          # finish_estop() does it
        if s.lost:
            self._finish(a, 'failed', 'serial_lost')
            return
        if s.alarm:
            code = m.ctrl.alarm_code if m.ctrl else None
            self._finish(a, 'failed', 'alarm:%s' % (code if code is not None else '?'))
            return
        # last ok = accepted into the planner: wait until the moves are done
        if a.status != 'stopping' and not s.stopped:
            pass
        ok = self._wait_idle(a, 600)
        if a.end_reason == 'estop' or self.active is not a:
            return
        if not ok and m.ctrl is not None and not m.ctrl.connected:
            self._finish(a, 'failed', 'serial_lost')
        elif s.errors and a.stop_on_error:
            self._finish(a, 'failed', 'gcode_error')
        elif s.stopped:
            self._finish(a, 'aborted', a.end_reason or 'user_stop')
        else:
            self._finish(a, 'done')

    def _wait_idle(self, a, timeout):
        c = self.m.ctrl
        if c is not None and not hasattr(c, 'wait_status'):
            return c.connected and c.wait_idle(timeout)     # Marlin: M400; EBB/base: True
        end = time.time() + timeout
        while time.time() < end:
            if c is None or not c.connected or a.end_reason == 'estop':
                return False
            seq = c.status_seq
            if not c.wait_status(seq, 1.0):
                try:
                    c.write_realtime(b'?')
                except Exception:
                    return False
                continue
            st = c.state or ''
            if st.startswith('Idle'):
                return True
            if st.startswith('Alarm'):
                return False
        return False

    # ------------------------------------------------------------ control
    def _need(self, job_id, *states):
        a = self.active
        if a is None or a.id != job_id:
            r = self._row(job_id)
            raise ApiError(409, 'bad_state', '任务未在进行（%s）' % r['status'], {'status': r['status']})
        if states and a.status not in states:
            raise ApiError(409, 'bad_state', '当前状态 %s 不支持此操作' % a.status, {'status': a.status})
        return a

    async def pause(self, job_id, mode='soft'):
        a = self._need(job_id)
        if a.status == 'paused':
            return self.get(job_id)
        a = self._need(job_id, 'running')
        with self._lock:
            if mode == 'hold':
                self.m.rt(b'!')
                a.sender.pause(lift=False)
            else:
                a.sender.pause(lift=True)
            a.pause_mode = mode
            a.paused_at = time.time()
            a.pause_pos = None
            a.moved = False
            self._transition(a, 'paused', mode)
        return self.get(job_id)

    def note_manual_move(self):
        """Called before a jog/goto while a job is paused: remember where to return."""
        a = self.active
        if a is not None and a.status == 'paused' and a.pause_pos is None:
            c = self.m.ctrl
            if c is not None and getattr(c, 'wpos', None):
                a.pause_pos = tuple(c.wpos)
            a.moved = True

    async def resume(self, job_id):
        a = self._need(job_id)
        if a.status == 'running':
            return self.get(job_id)
        a = self._need(job_id, 'paused')
        prefix = None
        if a.moved and a.pause_pos is not None:
            prefix = ['G90', 'G0 X%.3fY%.3f' % (a.pause_pos[0], a.pause_pos[1])]
        with self._lock:
            if a.pause_mode == 'hold':
                self.m.rt(b'~')
            a.paused_total += time.time() - (a.paused_at or time.time())
            a.paused_at = None
            a.sender.resume(prefix=prefix)
            a.pause_mode = None
            self._transition(a, 'running')
        return self.get(job_id)

    async def stop(self, job_id):
        a = self._need(job_id)
        if a.status == 'stopping':
            return self.get(job_id)
        if a.status == 'preparing':
            a.end_reason = 'user_stop'
            return self.get(job_id)
        a = self._need(job_id, 'running', 'paused')
        a.end_reason = 'user_stop'
        if a.paused_at:
            a.paused_total += time.time() - a.paused_at
            a.paused_at = None
        self._transition(a, 'stopping', 'user_stop')
        await asyncio.get_running_loop().run_in_executor(None, self._stop_blocking, a)
        return self.get(job_id)

    def _stop_blocking(self, a):
        c = self.m.ctrl
        if a.pause_mode == 'hold' and c is not None:
            # planner still holds pen-down moves: flush with a reset after the
            # hold completed (position kept), then lift and go home
            self.m.estopping = True
            try:
                s = a.sender
                a.finishing = True
                s.abort()
                end = time.time() + 1.5
                while time.time() < end:
                    st = c.query_status(0.15) or ''
                    if st.startswith(('Hold:0', 'Idle')):
                        break
                b = self.m._banners
                c.soft_reset()
                end = time.time() + 3
                while time.time() < end and self.m._banners == b:
                    time.sleep(0.02)
                st = c.query_status(1.0) or ''
                if st.startswith('Alarm'):
                    c.unlock()
                    self.m._invalidate_origin()
                else:
                    c.set_pen(True)
                    c.go_home()
            finally:
                self.m.estopping = False
            self._wait_idle(a, 60)
            self._finish(a, 'aborted', a.end_reason or 'user_stop')
            return
        a.sender.stop()

    # ------------------------------------------------------------ e-stop hooks (estop thread)
    def estop_abort_sender(self):
        a = self.active
        if a is None:
            return
        a.end_reason = 'estop'
        if a.sender is not None:
            a.sender.abort()

    def finish_estop(self):
        a = self.active
        if a is not None:
            self._finish(a, 'aborted', 'estop')

    def abort_active(self, reason):
        a = self.active
        if a is not None:
            a.end_reason = reason
            if a.sender is not None:
                a.sender.abort()
            self._finish(a, 'aborted', reason)

    # ------------------------------------------------------------ retry
    async def retry(self, job_id, from_line=None):
        r = self._row(job_id)
        if r['status'] in ACTIVE:
            raise ApiError(409, 'job_active', '任务仍在进行')
        path = os.path.join(self.cfg.jobs_dir, job_id + '.gcode')
        with open(path, encoding='utf-8', errors='replace') as fh:
            text = fh.read()
        prof = self.ctx.profiles.get(r['profile_id']) if r['profile_id'] and \
            self.db.one('SELECT id FROM profiles WHERE id=?', (r['profile_id'],)) else self.ctx.profiles.active()
        ov = jload(r['overrides'], {}) or {}
        src = jload(r['source'], {})
        if not from_line or from_line <= 1:
            jid = await self._insert(None, src, r['name'], prof, ov, r['batch_id'], r['seq'], src_path=path)
            return self.get(jid)
        if not self.m.origin_valid:
            raise ApiError(409, 'origin_invalid', '原点已失效，不能从中间继续（请重新设零后从头开始）')
        if 'G20' in text.upper().replace(' ', ''):
            raise ApiError(400, 'inch_retry_unsupported', '英制（G20）G 代码不支持从中间续写，只能从头开始')
        from ..printcfg import effective
        mc, _o, _org = effective(prof['doc'], {}, ov)
        an = self._load_job_analysis(path, mc, text)[1]
        lines = [ln.strip() for ln in text.split('\n') if ln.strip()]
        if from_line > len(lines):
            raise ApiError(400, 'bad_line', '行号超出范围')
        x, y, z, absolute = an.state_at(from_line - 1)
        g = mc.grbl
        pen_down = bool(an.pen[from_line - 2]) if from_line >= 2 and an.pen else False
        from ...machine.grbl import jnum
        up = 'G1G90 Z%sF%d' % (jnum(g.zOff), g.zSpeed) if g.type == 'Stepper' else 'M5'
        dn = 'G1G90 Z%sF%d' % (jnum(g.zOn), g.zSpeed) if g.type == 'Stepper' else 'M3S%d' % g.laserS
        pre = [up, 'G21', 'G90', 'F%d' % mc.settings.feedRate,
               'G0 X%.3fY%.3fF%d' % (x, y, mc.settings.jogSpeed)]
        if pen_down:
            pre.append(dn)
        if not absolute:
            pre.append('G91')
        body = '\r\n'.join(pre + lines[from_line - 1:]) + '\r\n'
        src = dict(src)
        src['retry_of'] = job_id
        src['from_line'] = from_line
        org = jload(r['origin'], {}) or {}
        epoch = org.get('epoch')
        if epoch is None or epoch != self.m.origin_epoch:
            raise ApiError(409, 'origin_invalid', '原点在原任务之后变过（设零/复位/重连），不能从中间续写；只能从头开始')
        jid = await self._insert(body, src, '%s（从第 %d 行）' % (r['name'], from_line), prof, ov,
                                 r['batch_id'], r['seq'],
                                 origin_extra={'set_zero_at_start': False, 'require_epoch': epoch})
        return self.get(jid)

    async def frame(self, job_id, body):
        r = self._row(job_id)
        if r['status'] != 'queued':
            raise ApiError(409, 'bad_state', '只能对排队中的任务走边框')
        bb = jload(r['bbox'])
        if not bb:
            raise ApiError(400, 'no_bbox', '任务没有绘制内容')
        if not self.m.origin_valid:
            # the job will zero here at start anyway: zero now so the frame matches
            snap = jload(r['profile_snapshot'], {})
            if (snap.get('settings') or {}).get('autoSetZero', True):
                await self.m.zero('xy' if self.m.z_valid else 'xyz')
        await self.m.frame(bb, body.feed, body.z, body.corners_only)
        return self.get(job_id)
