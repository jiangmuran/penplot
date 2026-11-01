# -*- coding: utf-8 -*-
"""Controller base + command Sender (machine.c / machine.h port).

Live commands are sent with '\\n' termination (machine.c.a). File export
uses '\\r\\n' inside the file - see penplot.gcode.
"""
import threading
import time


import re as _re

_COMMENT_PAREN = _re.compile(r'\([^)]*\)')
REALTIME_CHARS = set('!~?\x18')
# any byte line_problem() objects to (realtime chars, control / non-ASCII); the per-char loop only runs on a hit
_BAD_CHAR = _re.compile('[^\x20-\x7e]|[!~?]')


class UnsafeGcode(ValueError):
    """A line would carry bytes GRBL treats as realtime commands (or non-ASCII)."""

    def __init__(self, line_no, line, reason):
        super().__init__('line %s: %s (%r)' % (line_no, reason, line[:60]))
        self.line_no = line_no
        self.line = line
        self.reason = reason


def strip_comments(line):
    """Remove ';...' and '(...)' comments (GRBL parses realtime bytes even
    inside comments, so comments must never be streamed)."""
    line = line.split(';', 1)[0]
    if '(' in line:
        line = _COMMENT_PAREN.sub('', line)
        if '(' in line:                       # unterminated '(' comment
            line = line.split('(', 1)[0]
    return line.strip()


def line_problem(line, allow_dollar=True):
    """None if the (comment-free) line is safe to stream, else a zh-CN reason."""
    if _BAD_CHAR.search(line) is None:
        if not allow_dollar and line.startswith('$'):
            return '任务里不允许 $ 系统命令（会改写 EEPROM 或复位）'
        return None
    for ch in line:
        o = ord(ch)
        if ch in REALTIME_CHARS:
            return '含有实时控制字符 %r（会让 GRBL 暂停/恢复/复位）' % ch
        if o < 0x20 or o > 0x7e:
            return '含有非 ASCII 字节 U+%04X（GRBL 会当作实时命令或丢弃）' % o
    if not allow_dollar and line.startswith('$'):
        return '任务里不允许 $ 系统命令（会改写 EEPROM 或复位）'
    return None


def sanitize_line(line, line_no=None, allow_dollar=True):
    """Comment-free, safe line ('' for comment-only lines); raises UnsafeGcode."""
    clean = strip_comments(line)
    if clean:
        why = line_problem(clean, allow_dollar)
        if why:
            raise UnsafeGcode(line_no, line, why)
    return clean


class FirmwareEvent:
    def __init__(self, type_, data=None):
        self.type = type_
        self.data = data


class MachineController:
    """Abstract firmware controller (machine.c)."""

    # RX buffer capacity in characters used by the Sender flow control:
    # GRBL=100, Marlin=96, EBB=-1 (one command at a time). See machine *.d().
    RX_CAPACITY = 96
    LINE_ENDING = '\n'
    # True when the firmware answers a rejected line with 'error...' INSTEAD
    # of 'ok' (GRBL). Marlin prints 'Error:' and then still sends 'ok'/'Resend',
    # so there the error line must not consume a pending command.
    ERROR_IS_RESPONSE = False

    def __init__(self, machine, on_event=None, on_log=None):
        self.machine = machine
        self.ser = None
        self.connected = False
        self.firmware_version = ''
        self.port_name = ''
        self.baud = 115200
        self._listeners = [on_event] if on_event else []
        self._on_log = on_log or (lambda msg: None)
        self._rx_thread = None
        self._rx_buffer = ''
        self._stop = False
        self.status = ''
        self.pen_up_state = True
        self._wlock = threading.Lock()     # every ser.write goes through it
        self.disconnect_reason = None
        self._reset_on_open = True

    def add_event_listener(self, fn):
        """Register an extra event callback (several may coexist)."""
        if fn not in self._listeners:
            self._listeners.append(fn)

    def remove_event_listener(self, fn):
        if fn in self._listeners:
            self._listeners.remove(fn)

    # ------------------------------------------------------------ connect
    def open(self, port: str, baud: int = 115200, exclusive: bool = True,
             reset: bool = True, write_timeout: float = 1.0, ser=None) -> bool:
        """Open the port and start the RX thread.

        exclusive: TIOCEXCL (a second opener gets EBUSY).
        reset: firmware soft reset after opening (GRBL 0x18). The web
        service attaches with reset=False so the MCU state is kept when
        the port open does not toggle DTR.
        ser: an already-open serial-like object (FakeGrbl / tests).
        """
        self.port_name = port
        self.baud = baud
        self._reset_on_open = reset
        if ser is None:
            import serial
            kw = dict(timeout=0.05, write_timeout=write_timeout)
            if exclusive:
                kw['exclusive'] = True
            try:
                ser = serial.Serial(port, baud, **kw)
            except TypeError:          # pyserial < 3.3: no exclusive kw
                kw.pop('exclusive', None)
                ser = serial.Serial(port, baud, **kw)
        self.ser = ser
        self._rx_buffer = ''
        self.disconnect_reason = None
        self._stop = False
        self._rx_thread = threading.Thread(target=self._rx_loop, daemon=True)
        self._rx_thread.start()
        self._on_connect(port, baud)
        return True

    def close(self):
        self._stop = True
        if self._rx_thread and self._rx_thread is not threading.current_thread():
            self._rx_thread.join(timeout=1.0)
        if self.ser:
            try:
                self.ser.close()
            except Exception:
                pass
            self.ser = None
        was = self.connected
        self.connected = False
        if was or self.disconnect_reason is None:
            self.disconnect_reason = self.disconnect_reason or 'closed'
            self._emit(FirmwareEvent('disconnected', self.disconnect_reason))

    @property
    def rx_alive(self) -> bool:
        return bool(self._rx_thread and self._rx_thread.is_alive())

    def _write(self, data: bytes):
        """Single write path (line commands and realtime bytes)."""
        ser = self.ser
        if ser is None:
            raise RuntimeError('machine not connected')
        try:
            with self._wlock:
                ser.write(data)
        except Exception as e:
            self._lost('write error: %s' % e)
            raise

    def write_realtime(self, b: bytes):
        """Realtime byte(s): bypass every queue, only the write lock."""
        self._write(bytes(b))

    def _lost(self, reason):
        """The device vanished (unplug, I/O error)."""
        if not self.connected and self.disconnect_reason:
            return
        self.connected = False
        self.disconnect_reason = reason
        self._stop = True
        self._log('serial lost: %s' % reason)
        self._emit(FirmwareEvent('disconnected', reason))

    def _on_connect(self, port, baud):
        self.connected = True
        self._emit(FirmwareEvent('connected', port))

    # ------------------------------------------------------------ rx
    def _rx_loop(self):
        while not self._stop:
            try:
                ser = self.ser
                if ser is None or not ser.is_open:
                    if not self._stop:
                        self._lost('port closed')
                    break
                n = ser.in_waiting
                if n:
                    data = ser.read(n)
                    try:
                        self._rx_buffer += data.decode('utf-8', 'replace')
                    except Exception:
                        continue
                    while '\n' in self._rx_buffer:
                        line, self._rx_buffer = self._rx_buffer.split('\n', 1)
                        line = line.strip('\r').strip()
                        if line:
                            self.handle_line(line)
                else:
                    time.sleep(0.01)
            except Exception as e:
                self._log('rx error: %s' % e)
                if not self._stop:
                    self._lost('rx error: %s' % e)
                break

    def _emit(self, ev):
        for fn in list(self._listeners):
            try:
                fn(ev)
            except Exception:
                pass

    def _log(self, msg):
        self._on_log(msg)

    # ------------------------------------------------------------ tx
    def send(self, cmd: str, wait_ok: bool = False, timeout: float = 10.0):
        """machine.c.a(String, boolean).

        With wait_ok the reply listener is registered BEFORE the write, so a
        fast 'ok' can no longer slip past it (that used to cost a full
        timeout). Returns True on 'ok', False on 'error'/alarm/timeout.
        """
        if self.ser is None:
            raise RuntimeError('machine not connected')
        waiter = self._reply_waiter() if wait_ok else None
        self._log('>>> %s' % cmd)
        self._write((cmd + '\n').encode('utf-8'))
        self.track_sent(cmd)
        if waiter is None:
            return True
        return waiter(timeout)

    def _reply_waiter(self):
        ev = threading.Event()
        result = {'ok': False}

        def h(e):
            if e.type == 'ok':
                result['ok'] = True
                ev.set()
            elif e.type in ('error', 'alarm') and self.ERROR_IS_RESPONSE:
                ev.set()
        self.add_event_listener(h)

        def wait(timeout):
            try:
                ev.wait(timeout)
            finally:
                self.remove_event_listener(h)
            return result['ok']
        return wait

    def wait_idle(self, timeout: float = 600.0) -> bool:
        """Block until buffered motion has finished. Firmware specific;
        the base implementation cannot tell and returns True at once."""
        return True

    def track_sent(self, cmd):
        pass

    def handle_line(self, line: str):
        self._log('<<< %s' % line)
        # raw tap ($$ capture, [MSG:], log ring) before any dispatch
        self._emit(FirmwareEvent('line', line))
        if self._dispatch(line):
            return
        if line.lower() == 'ok' or line == 'OK':
            self._emit(FirmwareEvent('ok'))
        elif line.startswith('error'):
            self._emit(FirmwareEvent('error', line))

    def _dispatch(self, line) -> bool:
        return False

    # ------------------------------------------------------------ actions
    def set_pen(self, up: bool):
        ok = self.send(self.pen_cmd(up), True)
        self.pen_up_state = up
        return ok

    def home_cmd(self) -> str:
        return ''

    def pen_cmd(self, up: bool) -> str:
        raise NotImplementedError

    def pen_cmd_for(self, machine, up: bool) -> str:
        """pen_cmd() computed from another MachineConfig (a job's snapshot)."""
        saved = self.machine
        try:
            self.machine = machine
            return self.pen_cmd(up)
        finally:
            self.machine = saved

    def go_home(self):
        raise NotImplementedError

    def set_zero(self):
        raise NotImplementedError

    def jog(self, dx, dy, dz=0.0, speed=None):
        raise NotImplementedError

    def home_axes(self):
        raise NotImplementedError

    def unlock(self):
        pass

    def sleep(self):
        raise NotImplementedError

    def reset_zero_tracking(self):
        pass


class Sender:
    """machine.h port: queue + character-count flow control.

    Flow control: every streamed line occupies len(cmd)+1 bytes of the
    firmware RX buffer until its reply arrives. `_rx_chars` is the exact sum
    of those bytes for the commands still awaiting a reply; a reply frees
    only the bytes of the line it answers (FIFO). (The original reset the
    counter to 0 on every 'ok', which over-fills the RX buffer whenever more
    than one line is in flight.)

    Errors: on firmware where 'error' replaces 'ok' (GRBL) the error consumes
    the pending line. With stop_on_error=True (default) the job is stopped
    (pen up, then home); otherwise it is recorded and streaming continues.
    An ALARM always aborts: the firmware locks and would reject everything.
    A serial disconnect aborts too (`lost` is set).

    Counters (O(1), safe to read from any thread):
      total      number of source lines (non-empty lines given to load_*)
      sent_line  1-based source line index of the last line written
      acked_line 1-based source line index of the last line answered
      acked/sent number of replies / writes including injected commands
    Injected commands (prefix/suffix, pause pen-up, resume pen-down,
    insert_front, stop sequence) carry no source line.
    on_progress(fraction) is called from the RX thread after writes; it must
    be O(1).
    """

    def __init__(self, controller: MachineController, single_step=None,
                 stop_on_error=True, machine=None, allow_dollar=True):
        """machine: the job's own MachineConfig (snapshot + overrides). Pen
        commands injected on pause/resume/stop and the pen tracking use it,
        so a profile edit mid-job or a pen_*_z override cannot desync them."""
        self.c = controller
        self.m = machine or controller.machine
        self.allow_dollar = allow_dollar
        self.single_step = single_step if single_step is not None \
            else self.m.settings.singleStep
        self.stop_on_error = stop_on_error
        self.queue = []            # list of (cmd, line_no or None)
        self.pending = []          # sent, awaiting reply: (cmd, line_no, nbytes)
        self._qsrc = []            # parallel to queue: source line index or None
        self._psrc = []            # parallel to pending
        self._history = []         # every command ever queued, for Marlin resend
        self.errors = []           # [(cmd, reply)]
        self.error_lines = []      # [source line or None] parallel to errors
        self.alarm = None
        self.lost = None
        self.stopped = False
        self.running = False
        self.paused = False
        self.use_line_numbers = False
        self._pause_flush = False     # injected pen-up still to be sent
        self._stream_pen_down = False  # pen state as streamed so far
        self._was_pen_down = False
        self._lock = threading.RLock()
        self._sent_count = 0
        self._rx_chars = 0
        self.total = 0
        self.sent_line = 0
        self.acked_line = 0
        self.acked = 0
        self.on_progress = None
        self.on_complete = None
        self.on_error = None       # fn(cmd, reply)
        controller.add_event_listener(self._handle_event)

    def detach(self):
        self.c.remove_event_listener(self._handle_event)

    # ------------------------------------------------------------ build
    def clear(self):
        with self._lock:
            self.queue.clear()
            self._qsrc.clear()
            self.pending.clear()
            self._psrc.clear()
            self._history.clear()
            self.errors.clear()
            self.error_lines.clear()
            self.alarm = None
            self.lost = None
            self.stopped = False
            self.running = False
            self.paused = False
            self._pause_flush = False
            self._stream_pen_down = False
            self._rx_chars = 0
            self._sent_count = 0
            self.total = 0
            self.sent_line = 0
            self.acked_line = 0
            self.acked = 0

    def load_commands(self, cmds, line_numbers=False, prefix=None, suffix=None,
                      first_line=1):
        """h.a(String[]) / h.a(String) - split by \\n, trim, skip empty.

        first_line: source index of the first non-empty line (retry-from-line
        jobs keep the original numbering)."""
        self.clear()
        self.use_line_numbers = line_numbers
        if prefix:
            for c in prefix:
                c = sanitize_line(c, 'prefix')
                if c:
                    self._add(c, 0)
        n = 1
        src = first_line
        for k, line in enumerate(cmds, 1):
            line = sanitize_line(line, k, self.allow_dollar)
            if not line:
                continue
            self._add(line, n if line_numbers else None, src)
            n += 1
            src += 1
        self.total = src - 1
        if suffix:
            for c in suffix:
                c = sanitize_line(c, 'suffix')
                if c:
                    self._add(c, 0)

    def load_gcode_text(self, text):
        self.load_commands(text.split('\n'))

    def load_sd_upload(self, text, name):
        """h.a(String,String): M110 N0, M28 name.gco ... M29 with checksums."""
        self.clear()
        self.use_line_numbers = True
        self._add('M110 N0', 0)
        self._add('M28 %s.gco' % name, 0)
        n = 1
        for line in text.split('\n'):
            line = line.strip()
            if not line:
                continue
            self._add(line, n, n)
            n += 1
        self.total = n - 1
        self._add('M29', 0)

    def _add(self, cmd, line_no, src=None):
        if self.use_line_numbers and line_no is not None and line_no > 0:
            cmd = marlin_line(cmd, line_no)
        self.queue.append((cmd, line_no))
        self._qsrc.append(src)
        self._history.append((cmd, line_no))

    def _pen(self, up):
        try:
            return self.c.pen_cmd_for(self.m, up) if self.m is not self.c.machine else self.c.pen_cmd(up)
        except NotImplementedError:
            return ''

    def insert_front(self, cmds):
        """Queue commands to go out next (e.g. return to the pause point)."""
        cmds = [sanitize_line(c, 'insert') for c in cmds]
        with self._lock:
            for c in reversed([c for c in cmds if c]):
                self.queue.insert(0, (c, None))
                self._qsrc.insert(0, None)

    @property
    def remaining(self) -> int:
        return len(self.queue)

    # ------------------------------------------------------------ run
    def start(self):
        with self._lock:
            if self.running:
                return
            self.running = True
            self.paused = False
        self._fill()

    def stop(self):
        """machine/h.g(): drop queue, then pen-up + home/paper-out.

        The pen is lifted FIRST: homing (or the K_AT paper-out move) with the
        pen still down would draw a line across the page.
        """
        with self._lock:
            self.queue.clear()
            self._qsrc.clear()
            self.stopped = True
            self.paused = False
            self._pause_flush = False
            if not self.running:
                self.running = True     # let _fill flush the stop sequence
            seq = [self._pen(True)]
            if self.m.type == 'K_AT':
                k = self.m.kat
                seq.append('G0 Y%s F8000' % _num(getattr(k, 'feedOutY', 420)))   # kat.b.q()
                seq.append('G0 X%s F3000' % _num(getattr(k, 'parkX', 290)))      # kat.b.r()
            else:
                seq.append(self.c.home_cmd())
            for c in seq:
                if c:
                    self.queue.append((c, None))
                    self._qsrc.append(None)
        self._fill()

    def abort(self):
        """Drop everything without sending more (ALARM, e-stop, unplug)."""
        with self._lock:
            self.queue.clear()
            self._qsrc.clear()
            self.pending.clear()
            self._psrc.clear()
            self._rx_chars = 0
            self.stopped = True
            was_running = self.running
            self.running = False
        if was_running and self.on_complete:
            self.on_complete()

    def pause(self, lift=True):
        """Hold the stream. lift=True: lift the pen after the already-buffered
        moves (soft pause). lift=False: just stop feeding (feed hold mode;
        the caller has sent '!' and the pen stays where it is)."""
        with self._lock:
            if self.paused or not self.running:
                return
            self.paused = True
            self._was_pen_down = self._stream_pen_down
            self._pause_lifted = False
            if lift and self.queue and self._was_pen_down:
                self.queue.insert(0, (self._pen(True), None))
                self._qsrc.insert(0, None)
                self._pause_flush = True
                self._pause_lifted = True
        self._fill()

    def resume(self, prefix=None):
        """Continue; put the pen back down if it was down when paused and
        the pause lifted it. prefix: commands to send before the pen goes
        down again (return to the pause point after a jog)."""
        with self._lock:
            if not self.paused:
                return
            lifted = getattr(self, '_pause_lifted', False)
            if self._pause_flush:          # pen-up never went out: drop it
                self.queue.pop(0)
                self._qsrc.pop(0)
                self._pause_flush = False
                lifted = False
            if self.queue and self._was_pen_down and (lifted or prefix):
                self.queue.insert(0, (self._pen(False), None))
                self._qsrc.insert(0, None)
            if prefix:
                prefix = [sanitize_line(c, 'resume') for c in prefix]
                if self._was_pen_down and not lifted:
                    # pen still down after a hold+jog: lift before moving back
                    prefix = [self._pen(True)] + list(prefix)
                for c in reversed([c for c in prefix if c]):
                    self.queue.insert(0, (c, None))
                    self._qsrc.insert(0, None)
            self.paused = False
        self._fill()

    # ------------------------------------------------------------ flow
    def _fill(self):
        sent_any = False
        done = False
        with self._lock:
            if not self.running:
                return
            # while paused only the injected pen-up (queue head) may go out
            cap = self.c.RX_CAPACITY
            while self.queue:
                if self.paused and not self._pause_flush:
                    break
                cmd, no = self.queue[0]
                need = len(cmd) + 1
                if self.single_step or cap == -1:
                    if self.pending:          # one command in flight at a time
                        break
                elif self.pending and need + self._rx_chars > cap:
                    break
                self.queue.pop(0)
                src = self._qsrc.pop(0) if self._qsrc else None
                try:
                    self.c.send(cmd, False)
                except Exception:
                    # device gone: the disconnect event aborts the stream
                    self.queue.insert(0, (cmd, no))
                    self._qsrc.insert(0, src)
                    return
                self.pending.append((cmd, no, need))
                self._psrc.append(src)
                self._rx_chars += need
                self._sent_count += 1
                if src is not None:
                    self.sent_line = src
                sent_any = True
                if self.paused:            # that was the injected pen-up
                    self._pause_flush = False
                    self._track_pen(cmd)
                    break
                self._track_pen(cmd)
            if not self.queue and not self.pending and self.running:
                self.running = False
                done = True
        if done:
            if self.on_complete:
                self.on_complete()
            return
        if sent_any and self.on_progress:
            self.on_progress(self.progress())

    def _track_pen(self, cmd):
        """Pen state from the streamed line itself (P3): exact pen commands,
        M3/M4/M5, Marlin M280/M106/M107, or a Z word closer to the pen-down
        height than to the pen-up height (same rule as parse_gcode)."""
        try:
            if cmd == self._pen(False):
                self._stream_pen_down = True
                return
            if cmd == self._pen(True):
                self._stream_pen_down = False
                return
        except Exception:
            pass
        u = cmd.upper().replace(' ', '')
        m = _re.search(r'M0*([0-9]+)', u)
        if m:
            code = int(m.group(1))
            if code in (3, 4, 106):
                self._stream_pen_down = True
            elif code in (5, 107):
                self._stream_pen_down = False
            elif code == 280:
                sm = _re.search(r'S([0-9.]+)', u)
                if sm:
                    self._stream_pen_down = int(float(sm.group(1))) == int(self.m.marlin.penDownPos)
        if 'Z' in u and 'G91' not in u:
            zm = _re.search(r'Z([+-]?[0-9]*\.?[0-9]+)', u)
            if zm:
                z = float(zm.group(1))
                if self.m.type in ('Marlin', 'K_AT'):
                    zd, zu = self.m.marlin.penDownMM, self.m.marlin.penUpMM
                else:
                    zd, zu = self.m.grbl.zOn, self.m.grbl.zOff
                self._stream_pen_down = abs(z - zd) < abs(z - zu)

    def progress(self) -> float:
        """Fraction of source lines acknowledged by the firmware (B9)."""
        if self.total <= 0:
            total = self._sent_count + len(self.queue)
            return 1.0 if total == 0 else self.acked / max(1, total)
        return min(1.0, self.acked_line / self.total)

    @property
    def line_of_pending_head(self):
        """Source line of the oldest command still awaiting its reply."""
        with self._lock:
            for s in self._psrc:
                if s is not None:
                    return s
        return None

    def _pop_pending(self):
        with self._lock:
            if not self.pending:
                return None, None
            cmd, no, need = self.pending.pop(0)
            src = self._psrc.pop(0) if self._psrc else None
            self._rx_chars = max(0, self._rx_chars - need)
            self.acked += 1
            if src is not None:
                self.acked_line = src
            return cmd, src

    # ------------------------------------------------------------ events
    def _handle_event(self, ev):
        if ev.type in ('ok', 'error') and self.paused and not self.pending:
            # nothing of ours is in flight: this reply belongs to a manual
            # command sent while paused (P4) - never credit or fail the job
            return
        if ev.type == 'ok':
            self._pop_pending()
            self._fill()
        elif ev.type == 'error' and self.c.ERROR_IS_RESPONSE:
            cmd, src = self._pop_pending()
            if not self.running:
                return
            self.errors.append((cmd, ev.data))
            self.error_lines.append(src)
            if self.on_error:
                self.on_error(cmd, ev.data)
            if self.stop_on_error and not self.stopped:
                self.stop()
            else:
                self._fill()
        elif ev.type == 'alarm':
            if not self.running:
                return
            self.alarm = ev.data
            if self.on_error:
                self.on_error(None, ev.data)
            self.abort()
        elif ev.type == 'disconnected':
            if not self.running:
                return
            self.lost = ev.data or 'disconnected'
            self.abort()
        elif ev.type == 'resend':
            self._resend(ev.data)

    def _resend(self, n):
        """Marlin 'Resend: n': requeue from the first matching line number."""
        with self._lock:
            for idx, (cmd, no) in enumerate(self._history):
                if no == n:
                    self.queue = self._history[idx:]
                    self._qsrc = [None] * len(self.queue)
                    self.pending.clear()
                    self._psrc.clear()
                    self._rx_chars = 0
                    break
        self._fill()


def _num(v):
    f = float(v)
    return '%d' % f if f == int(f) else repr(f)


def marlin_line(cmd: str, n: int) -> str:
    """marlin.b.b(String,int): 'N{n} {cmd}*{xor}'."""
    s = 'N%d %s' % (n, cmd)
    chk = 0
    for ch in s:
        chk ^= ord(ch)
    return '%s*%d' % (s, chk)
