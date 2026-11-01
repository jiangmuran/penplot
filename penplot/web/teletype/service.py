"""TeletypeService: the paper terminal as a first-class machine holder.

Drives the plotter THROUGH MachineService (its controller, write lock and
cmd-thread). While a session exists it holds the machine like a job:
jobs cannot start, manual moves are allowed only when nothing is
streaming, e-stop always works (halt_abort / after_halt hooks).

Typing mode writes with the session font (any library stroke font, or the
built-in monospace one), CJK / full-width characters take two cells.
Terminal mode always draws with the built-in ASCII font and keeps the old
full-width -> ASCII mapping: PTY output is laid out by programs for a
wcwidth terminal of `cols` columns and arrives at shell speed (a hanzi is
~10 pen lifts against ~1.2 for the mono font, so the backlog guard would
drop most of it), and readline / progress-bar redraws are overstruck per
cell, which only stays legible with single-stroke glyphs.

Status events (topic `teletype`, see schemas.ws.TeletypeEvent) carry the
session id; GET /teletype/state (= WS hello snapshot.teletype) has every
field the events update, so a client can resync at any time.
"""
import asyncio
import collections
import logging
import secrets
import threading
import time

from ..errors import ApiError
from . import font
from .glyphs import MONO, Glyphs, load_blocking
from .paper import Paper, layout_preview, num
from .stream import Streamer
from .tty import TtyFilter

log = logging.getLogger('penplot.web.teletype')
PTY_ROWS = 30


class Session:
    def __init__(self, sid, cfg, owner):
        self.id = sid
        self.cfg = cfg
        self.owner = owner
        self.mode = 'type'
        self.started_at = time.time()
        self.streamer = None
        self.paper = None
        self.tty = None
        self.pty = None
        self.paused = False
        self.origin_ok = True
        self.typed_log = ''
        self.pty_log = collections.deque()
        self.pty_log_len = 0
        self.lock = threading.RLock()
        self.last_pen = None
        self.glyphs = None              # Glyphs of the chosen font (paper.glyphs = current page)


class TeletypeService:
    def __init__(self, ctx):
        self.ctx = ctx
        self.session = None
        self._pty_clients = set()       # asyncio.Queue per PTY websocket
        self._loop = None
        self._acks = []
        self._ack_lock = threading.Lock()

    @property
    def m(self):
        return self.ctx.machine

    def settings(self):
        d = {'terminal_enabled': False, 'terminal_user': None, 'terminal_shell': None}
        d.update(self.ctx.settings.value('teletype', {}) or {})
        return d

    def _emit(self, kind, **data):
        if kind == 'need_paper' and data.get('on'):
            self.ctx.attention('paper_change', '电传打字：第 %s 页写满，换纸后点「已换纸」' % data.get('page'),
                               'warning', 'paper', session_id=self.session.id if self.session else None)
        data['kind'] = kind
        if self.session:
            data['session_id'] = self.session.id
        if kind == 'ack':
            # acks come one per char from the serial thread: batch them (~20/s)
            # so a pasted paragraph doesn't overflow the WS queue (-> gap)
            with self._ack_lock:
                self._acks.append(data['id'])
                first = len(self._acks) == 1
            if first:
                loop = self.ctx.bus.loop
                if loop is not None and not loop.is_closed():
                    try:
                        loop.call_soon_threadsafe(loop.call_later, 0.05, self._flush_acks, data.get('session_id'))
                    except RuntimeError:
                        pass
            return
        self.ctx.bus.publish_threadsafe('teletype', data)

    def _flush_acks(self, sid=None):
        with self._ack_lock:
            ids, self._acks = self._acks, []
        if ids:
            self.ctx.bus.publish('teletype', {'kind': 'ack', 'ids': ids, 'id': ids[-1], 'session_id': sid,
                                              'queued': self.session.paper.queued if self.session and self.session.paper else 0})

    # ------------------------------------------------------------ session
    def _cfg(self, body):
        g = self.m.mc.grbl
        pw, ph = 210.0, 297.0
        if body.paper is not None:
            pp = self.ctx.papers.resolve(body.paper.model_dump())
            from ...compose import paper_dims
            pw, ph = paper_dims(pp)
        if body.paper_w_mm:
            pw = float(body.paper_w_mm)
        if body.paper_h_mm:
            ph = float(body.paper_h_mm)
        z_down = float(body.z_down if body.z_down is not None else g.zOn)
        z_up = float(body.z_up if body.z_up is not None else g.zOff)
        z_up = max(0.0, min(z_up, z_down))
        return dict(char_h=float(body.char_h), cell_w=0.8, line_h=1.6, paper_w=pw, paper_h=ph,
                    margin=float(body.margin), feed=int(body.feed), z_down=z_down, z_up=z_up,
                    z_speed=int(body.z_speed or g.zSpeed), max_backlog=int(body.max_backlog),
                    font_id=body.font_id or 'mono', letter_spacing=body.letter_spacing,
                    line_spacing=body.line_spacing)

    async def _load_glyphs(self, font_id):
        """Load + measure a library font off the event loop (FontIndex LRU +
        glyphs._MEASURED cache: a second session with the same font is free)."""
        if not font_id or font_id == 'mono':
            return Glyphs(MONO)
        prim = await asyncio.get_running_loop().run_in_executor(None, load_blocking, self.ctx.fonts, font_id)
        return Glyphs(prim)

    @staticmethod
    def _sync_ratios(cfg, geo):
        cfg['cell_w'] = round(geo['cw'] / geo['h'], 4)
        cfg['line_h'] = round(geo['lh'] / geo['h'], 4)

    async def create(self, body, p):
        if self.session is not None:
            if self.session.owner['id'] == p.user_id:
                return self.state()
            raise ApiError(409, 'teletype_active', '已有电传会话（%s）' % self.session.owner['username'])
        if self.ctx.jobs.active is not None:
            raise ApiError(409, 'job_active', '任务进行中，不能开始电传会话', {'job_id': self.ctx.jobs.active.id})
        m = self.m
        m.require_free()
        if body.mode == 'term':
            self._check_terminal(p)
        cfg = self._cfg(body)
        glyphs = await self._load_glyphs(cfg['font_id'])
        if self.session is not None:          # someone else won the race while the font loaded
            raise ApiError(409, 'teletype_active', '已有电传会话（%s）' % self.session.owner['username'])
        s = Session('tt' + secrets.token_hex(4), cfg, p.user_dict())
        s.glyphs = glyphs
        set_zero = True if body.set_zero is None else body.set_zero
        if not set_zero and not m.origin_valid:
            raise ApiError(409, 'origin_invalid', '原点无效：请先设零，或 set_zero=true')
        self._loop = asyncio.get_running_loop()
        await m.call(self._prepare_blocking, s, set_zero)
        self.session = s
        self.ctx.db.audit(p.actor, 'teletype_start', {'session': s.id, 'mode': body.mode})
        if body.mode == 'term':
            self._start_pty(p)
            s.mode = 'term'
        self._emit('snapshot', state=self.state())
        m._publish_status(True)
        return self.state()

    def _prepare_blocking(self, s, set_zero):
        m = self.m
        c = m.ctrl
        if hasattr(c, 'query_status'):
            st = c.query_status(2.0) or ''
            if st.startswith('Alarm'):
                raise ApiError(409, 'alarm_locked', '机器处于报警锁定状态，请先解锁')
        c.send('G21 G90', True)
        if set_zero:
            if not m.z_valid:
                raise ApiError(409, 'pen_unknown', '笔的高度未知：先把笔抬起并「设为原点」（含 Z）')
            c.set_pen(True)
            ok = c.set_zero('xy')
            if not ok:
                raise ApiError(409, 'zero_failed', '设零失败')
            m.origin_valid = True
            m.origin_epoch += 1
        c.send('G1 Z%s F%d' % (num(s.cfg['z_up']), s.cfg['z_speed']), True)
        s.streamer = Streamer(c, on_ack=lambda tag: s.paper.ack(tag) if isinstance(tag, int) else None,
                              on_error=lambda cmd, reply: self._emit('error', cmd=cmd, reply=reply))
        s.paper = Paper(s.cfg, s.streamer, self._emit, s.glyphs)
        self._sync_ratios(s.cfg, s.paper.geo)
        s.tty = TtyFilter(s.paper.geo['cols'])

    def _need(self):
        if self.session is None:
            raise ApiError(409, 'no_session', '没有电传会话')
        return self.session

    async def close(self, p, force=False):
        s = self._need()
        if s.owner['id'] != p.user_id and not p.is_admin:
            raise ApiError(403, 'forbidden', '只有会话所有者或管理员可以结束会话')
        m = self.m

        def run():
            if s.streamer is not None and s.streamer.pending() and m.connected:
                m.estopping = True
                try:
                    m.halt_blocking()
                finally:
                    m.estopping = False
            if m.connected and m.origin_valid:
                m.ctrl.set_pen(True)
                m.ctrl.go_home()
        try:
            if m.connected:
                await asyncio.get_running_loop().run_in_executor(m._exec, run)
        finally:
            self._teardown()
        self.ctx.db.audit(p.actor, 'teletype_stop', {'session': s.id})
        self.ctx.bus.publish('teletype', {'kind': 'closed', 'session_id': s.id})
        m._publish_status(True)
        return {'active': False}

    def _teardown(self):
        s = self.session
        if s is None:
            return
        if s.streamer is not None:
            s.streamer.close()
        if s.pty is not None:
            s.pty.stop()
        self.session = None

    def busy_reason(self):
        s = self.session
        if s is None:
            return None
        if s.streamer is not None and (s.streamer.pending() or s.paused):
            return 'teletype'
        c = self.m.ctrl
        st = (getattr(c, 'state', '') if c is not None else '') or ''
        if hasattr(c, 'query_status') and not st.startswith('Idle'):
            return 'teletype'
        return None

    def _guard_write(self, s):
        if s.streamer is not None and s.streamer.lost:
            self._teardown()
            raise ApiError(503, 'machine_disconnected', '串口断开，电传会话已结束')
        if not s.origin_ok:
            raise ApiError(409, 'origin_invalid', '原点已失效：抬笔并重新设零后点「设为原点」')

    # ------------------------------------------------------------ typing
    def keys(self, data, p=None):
        s = self._need()
        if s.mode == 'term':
            if s.pty is None:
                raise ApiError(409, 'no_terminal', '终端没有运行')
            if p is None:
                raise ApiError(403, 'forbidden', '终端输入需要管理员身份')
            self._check_terminal(p)      # admin, enabled, and never from the internet
            s.pty.write(data)
            return {'ok': True, 'echo': ''}
        self._guard_write(s)
        out, echo = [], []
        i = 0
        while i < len(data):
            ch = data[i]
            if ch == '\x1b':                   # arrow keys etc: ignore
                j = i + 1
                if j < len(data) and data[j] in '[O':
                    j += 1
                    while j < len(data) and not ('\x40' <= data[j] <= '\x7e'):
                        j += 1
                i = j + 1
                continue
            if ch in '\r\n':
                out.append('\n')
                echo.append('\r\n')
            elif ch in '\x7f\b':
                out.append('\b')
                echo.append('\b')
            elif ch == '\t':
                out.append('\t')
                echo.append('\t')
            elif ch >= ' ':
                # the font's own glyph when it has one (，。 in a CJK font);
                # ASCII for full-width punctuation only the mono font can draw
                for c in s.paper.glyphs.prepare(ch):
                    out.append(c)
                    echo.append(c)
            i += 1
        with s.lock:
            if not s.paper.typewrite(''.join(out)):
                raise ApiError(409, 'need_paper', '纸写满了，换纸后调用 /teletype/newpage')
            e = ''.join(echo)
            s.typed_log = (s.typed_log + e)[-20000:]
        self._emit('typed', data=e)
        return {'ok': True, 'echo': e}

    def newpage(self):
        s = self._need()
        with s.lock:
            s.paper.new_sheet()
            self._sync_ratios(s.cfg, s.paper.geo)
            self._apply_cols(s)
            if s.mode == 'term' and not s.paper.chars:
                s.paper.apply(s.tty.reprint_line())
        return self.state()

    async def action(self, a, p, args=None):
        s = self._need()
        m = self.m
        args = args or {}
        if a == 'pause':
            m.rt(b'!')
            s.paused = True
        elif a == 'resume':
            m.rt(b'~')
            s.paused = False
        elif a == 'stop':
            def run():
                m.estopping = True
                try:
                    m.halt_blocking()
                finally:
                    m.estopping = False
                self.after_halt('stop')
            await asyncio.get_running_loop().run_in_executor(m._exec, run)
            s.paused = False
        elif a == 'change_paper':
            s.paper.change_paper()
        elif a == 'set_origin':
            if s.streamer.pending():
                raise ApiError(409, 'machine_busy', '正在书写')
            await m.zero('xy' if m.z_valid else 'xyz')
            s.origin_ok = True
        elif a == 'home':
            s.streamer.queue(s.paper.park_cmds())
        elif a == 'pen_up':
            s.streamer.queue(['G90 G1 Z%s F%d' % (num(s.cfg['z_up']), s.cfg['z_speed'])])
        elif a == 'mode':
            await self.set_mode(args.get('mode', 'type'), p)
        elif a == 'interrupt':
            if s.pty is not None:
                s.pty.write('\x03')
        elif a == 'settings':
            fid = args.get('font_id')
            if fid is not None and (fid or 'mono') != s.cfg.get('font_id'):
                s.glyphs = await self._load_glyphs(fid)
                s.cfg['font_id'] = s.glyphs.font_id
            self._settings(s, args)
        else:
            raise ApiError(400, 'bad_action', '未知操作 %s' % a)
        self._emit('state', state=self.state(brief=True))
        return self.state()

    def _settings(self, s, body):
        lim = {'feed': (100, 20000), 'z_up': (0, 20), 'z_down': (0, 20), 'max_backlog': (50, 100000),
               'char_h': (1, 30), 'margin': (0, 100), 'paper_w': (10, 2000), 'paper_h': (10, 2000),
               'letter_spacing': (-5, 20), 'line_spacing': (0.8, 5)}
        for k, (lo, hi) in lim.items():
            if k not in body:
                continue
            v = body[k]
            if v is None:
                if k in ('letter_spacing', 'line_spacing'):
                    s.cfg[k] = None             # back to auto
                continue
            try:
                v = float(v)
            except (TypeError, ValueError):
                raise ApiError(422, 'validation_error', '%s 必须是数字' % k)
            if not lo <= v <= hi:
                raise ApiError(422, 'validation_error', '%s 超出范围 %s–%s' % (k, lo, hi))
            s.cfg[k] = int(v) if k in ('feed', 'max_backlog') else v
        s.cfg['z_up'] = max(0.0, min(s.cfg['z_up'], s.cfg['z_down']))
        with s.lock:
            if s.glyphs is not None and s.glyphs is not s.paper.glyphs:
                s.paper.next_glyphs = s.glyphs      # takes effect on an empty page / the next sheet
            if not (s.paper.chars or s.paper.col or s.paper.row):
                s.paper.reset_page()
                self._sync_ratios(s.cfg, s.paper.geo)
                self._apply_cols(s)
                self._emit('snapshot', state=self.state())

    def _apply_cols(self, s):
        cols = s.paper.geo['cols']
        if cols != s.tty.cols:
            s.tty.resize(cols)
            if s.pty:
                s.pty.resize(cols=cols)
            self._emit('cols', cols=cols)

    # ------------------------------------------------------------ terminal mode
    def _check_terminal(self, p):
        if not self.settings().get('terminal_enabled'):
            raise ApiError(403, 'terminal_disabled', '终端模式已关闭（设置 teletype.terminal_enabled）')
        if not p.is_admin:
            raise ApiError(403, 'forbidden', '终端模式只对管理员开放')
        if (p.extra or {}).get('remote'):
            raise ApiError(403, 'terminal_remote', '终端模式只能在局域网内使用（公网访问已禁用）')

    async def set_mode(self, mode, p):
        s = self._need()
        if mode not in ('type', 'term'):
            raise ApiError(400, 'bad_mode', '模式只能是 type / term')
        if mode == s.mode:
            return
        if mode == 'term':
            self._check_terminal(p)
            if s.pty is None:
                self._start_pty(p)
        with s.lock:
            s.mode = mode
            s.paper.newline_if_needed()
            if mode == 'term':
                s.paper.apply(s.tty.reprint_line())
        self._emit('mode', mode=mode)

    def _start_pty(self, p):
        from .pty import Pty
        s = self.session
        st = self.settings()
        s.pty = Pty(self._on_pty, s.paper.geo['cols'], PTY_ROWS, user=st.get('terminal_user'),
                    shell=st.get('terminal_shell'))
        s.pty.start()
        self.ctx.db.audit(p.actor, 'terminal_start', {'session': s.id, 'run_as': s.pty.run_as})

    def _on_pty(self, text):
        s = self.session
        if s is None:
            return
        with s.lock:
            s.pty_log.append(text)
            s.pty_log_len += len(text)
            while s.pty_log_len > 200000 and len(s.pty_log) > 1:
                s.pty_log_len -= len(s.pty_log.popleft())
            ops = s.tty.feed(text)               # always: keeps the line model
            if s.mode == 'term' and s.origin_ok and not (s.streamer and s.streamer.lost):
                s.paper.apply(ops)
        data = text.encode('utf-8')
        loop = self._loop
        for q in list(self._pty_clients):
            if loop is not None:
                loop.call_soon_threadsafe(q.put_nowait, data)

    def pty_attach(self, q):
        s = self._need()
        if s.pty is None:
            raise ApiError(409, 'no_terminal', '终端没有运行（切换到终端模式）')
        self._loop = asyncio.get_running_loop()
        self._pty_clients.add(q)
        with s.lock:
            return ''.join(s.pty_log).encode('utf-8')

    def pty_detach(self, q):
        self._pty_clients.discard(q)

    def pty_input(self, data):
        s = self._need()
        if s.pty is None:
            raise ApiError(409, 'no_terminal', '终端没有运行')
        s.pty.write(data)

    def pty_resize(self, rows):
        s = self._need()
        if s.pty is not None:
            s.pty.resize(rows=rows)

    # ------------------------------------------------------------ halt hooks (machine thread)
    def halt_abort(self):
        s = self.session
        if s is None or s.streamer is None:
            return
        ids = [t for t in s.streamer.flush() if isinstance(t, int)]
        with s.lock:
            s.paper.dropped(ids)

    def after_halt(self, reason):
        s = self.session
        if s is None:
            return
        with s.lock:
            s.paper.newline_if_needed()
            s.tty.mark_printed()               # don't overstrike what was dropped
        s.paused = False
        if not self.m.origin_valid:
            s.origin_ok = False
        self._emit('halted', reason=reason, origin_ok=s.origin_ok)

    def tick(self):
        """Poller (loop thread): pen position / pending as `pen` events, on change."""
        s = self.session
        c = self.m.ctrl
        if s is None or c is None:
            return
        if s.streamer is not None and s.streamer.lost:
            self._emit('closed', reason='serial_lost')
            self._teardown()
            return
        pen = self._pen(s)
        cur = (pen['pos'] and tuple(pen['pos']), pen['pending'], pen['state'], pen['paused'], pen['queued'])
        if cur != s.last_pen:
            s.last_pen = cur
            self._emit('pen', **pen)

    def _pen(self, s):
        """Live machine view of the session (pen event == state['pen'])."""
        c = self.m.ctrl
        w = getattr(c, 'wpos', None) if c is not None else None
        st = ((getattr(c, 'state', '') or '') if c is not None else '')
        return {'pos': [round(w[0], 2), round(w[1], 2), round(w[2], 2)] if w else None,
                'pending': s.streamer.pending() if s.streamer else 0,
                'queued': s.paper.queued if s.paper else 0,
                'state': st,
                # a feed hold from elsewhere (console '!') is a pause too
                'paused': bool(s.paused or st.startswith('Hold')),
                'connected': bool(c is not None and c.connected)}

    # ------------------------------------------------------------ state
    def state(self, brief=False):
        s = self.session
        st = self.settings()
        if s is None:
            return {'active': False, 'terminal_enabled': bool(st.get('terminal_enabled'))}
        out = {'active': True, 'session_id': s.id, 'mode': s.mode, 'owner': s.owner, 'started_at': s.started_at,
               'cfg': dict(s.cfg), 'cols': s.paper.geo['cols'], 'rows': s.paper.geo['rows'], 'pty_rows': PTY_ROWS,
               'pending': s.streamer.pending() if s.streamer else 0, 'paused': s.paused,
               'need_paper': s.paper.need_paper, 'origin_ok': s.origin_ok,
               'terminal_enabled': bool(st.get('terminal_enabled')), 'pty_running': s.pty is not None,
               'page': s.paper.page, 'queued': s.paper.queued, 'written': s.paper.written,
               'row': s.paper.row, 'col': s.paper.col,
               'font': s.paper.font_info(), 'next_font': s.paper.next_glyphs.info() if s.paper.next_glyphs else None,
               'missing': list(s.paper.missing), 'pen': self._pen(s)}
        out['paused'] = out['pen']['paused']
        if not brief:
            out['paper'] = s.paper.snapshot()
            out['typed_log'] = s.typed_log
        return out

    @staticmethod
    def font_json():
        return font.as_json()

    async def preview(self, body):
        """Sample text laid out with the given (or the session's) settings:
        geometry, chars and glyph paths exactly as a session would draw them."""
        s = self.session
        base = dict(s.cfg) if s else {'char_h': 3.0, 'paper_w': 210.0, 'paper_h': 297.0, 'margin': 8.0,
                                      'font_id': 'mono', 'letter_spacing': None, 'line_spacing': None}
        d = body.model_dump(exclude_unset=True)
        text = d.pop('text', None)
        for k, v in d.items():
            base[k] = v
        if base.get('font_id') in (None, ''):
            base['font_id'] = 'mono'
        if s and base['font_id'] == s.cfg.get('font_id') and s.glyphs is not None:
            glyphs = Glyphs(s.glyphs.primary)
        else:
            glyphs = await self._load_glyphs(base['font_id'])
        if text is None:
            text = ('你好，世界！Hello, world. 0123' if glyphs.cjk
                    else 'Hello, world! 0123456789 The quick brown fox.')
        return layout_preview(text, base, glyphs)
