# -*- coding: utf-8 -*-
"""GRBL controller (machine.grbl.b port)."""
import re
import threading
import time

from .base import MachineController, FirmwareEvent

_VER = re.compile(r'[0-9]*\.[0-9]*')
_STATUS = re.compile(r'<(.*?)>')
_PARAM = re.compile(r'\$(\d+)=([^ ]*)\s?\(?([^\)]*)?\)?')


ALARM_HINTS = {
    1: '硬限位触发：检查限位开关后解锁（$X）',
    2: '软限位：目标超出行程，坐标可能失效',
    3: '运动中复位：坐标已丢失，请抬笔并重新设零',
    4: '探针初始状态错误',
    5: '探针未触发',
    6: '回零失败：复位',
    7: '回零失败：安全门打开',
    8: '回零失败：未能离开限位',
    9: '回零失败：找不到限位开关',
    10: '回零失败：第二次接近失败',
}

STATE_TEXT = {'Alarm': '报警', 'Idle': '空闲', 'Sleep': '休眠', 'Run': '运行中',
              'Home': '回机械原点中', 'Jog': '点动运行中', 'Hold': '暂停（保持）',
              'Door': '安全门', 'Check': '检查模式'}

# realtime command bytes (GRBL 1.1)
RT_STATUS = b'?'
RT_HOLD = b'!'
RT_RESUME = b'~'
RT_RESET = b'\x18'
RT_JOG_CANCEL = b'\x85'
RT_OVERRIDES = {  # name -> byte
    'feed_100': b'\x90', 'feed_plus_10': b'\x91', 'feed_minus_10': b'\x92',
    'feed_plus_1': b'\x93', 'feed_minus_1': b'\x94',
    'rapid_100': b'\x95', 'rapid_50': b'\x96', 'rapid_25': b'\x97',
    'spindle_100': b'\x99', 'spindle_plus_10': b'\x9A', 'spindle_minus_10': b'\x9B',
    'spindle_plus_1': b'\x9C', 'spindle_minus_1': b'\x9D',
}


def _floats(s):
    try:
        return tuple(float(v) for v in s.split(','))
    except ValueError:
        return None


class GrblController(MachineController):
    # GRBL's serial RX buffer is 128 bytes on stock builds (some boards have
    # more); 100 keeps a safety margin and matches the original software.
    RX_CAPACITY = 100
    ERROR_IS_RESPONSE = True      # 'error:N' is sent instead of 'ok'

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.state = ''           # raw GRBL state: Idle / Run / Alarm / Hold:0 ...
        self.position = None      # (x, y, z) work position of the last report
        self.mpos = None
        self.wpos = None
        self.wco = None           # cached: GRBL reports WCO only every 10-30 reports
        self.feed = None
        self.spindle = None
        self.buf = None           # (planner blocks free, rx bytes free)
        self.ov = None            # (feed%, rapid%, spindle%)
        self.pins = ''
        self.status_seq = 0       # incremented on every parsed status report
        self.status_time = 0.0
        self.grbl_params = {}     # $$ table: {n: value string}
        self.alarm_code = None
        self.messages = []        # recent [MSG:...] lines
        self._poller = None
        self._status_cv = threading.Condition()

    def _on_connect(self, port, baud):
        super()._on_connect(port, baud)
        if self._reset_on_open:
            # soft reset (0x18), banner "Grbl X.Y" follows
            try:
                self._write(RT_RESET)
            except Exception:
                pass

    def _dispatch(self, line) -> bool:
        if line.lower() == 'ok':
            self._emit(FirmwareEvent('ok'))
            return True
        if line.startswith('Grbl'):
            m = _VER.search(line)
            if m:
                self.firmware_version = m.group(0) + line[m.end():].split(' ')[0]
                self.firmware_version = self.firmware_version.strip() or m.group(0)
            self._emit(FirmwareEvent('connected', self.firmware_version))
            if self.machine.settings.updateStatus:
                self.start_status_polling()
            return True
        if line.startswith('$') and '=' in line:
            m = _PARAM.search(line)
            if m:
                try:
                    self._read_param(int(m.group(1)), m.group(2))
                except ValueError:
                    pass
                return True
        if line.startswith('ALARM'):
            self.state = 'Alarm'
            self.status = '报警'
            try:
                self.alarm_code = int(line.split(':', 1)[1])
            except (IndexError, ValueError):
                self.alarm_code = None
            self._emit(FirmwareEvent('alarm', line))
            return True
        if line.startswith('<'):
            m = _STATUS.search(line)
            if m:
                self._parse_status(m.group(1))
                self._emit(FirmwareEvent('status', self.status))
            return True
        if line.startswith('[MSG:'):
            self.messages = (self.messages + [line[5:-1]])[-20:]
            self._emit(FirmwareEvent('message', line[5:-1]))
            return True
        if line.startswith('error'):
            self._emit(FirmwareEvent('error', line))
            return True
        return False

    def _parse_status(self, body):
        """<State|MPos:..|WPos:..|WCO:..|Bf:..|FS:..|F:..|Ov:..|Pn:..> (B4)."""
        parts = body.split('|')
        self.state = parts[0]
        mpos = wpos = None
        pins = ''
        for part in parts[1:]:
            k, _, v = part.partition(':')
            if k == 'MPos':
                mpos = _floats(v)
            elif k == 'WPos':
                wpos = _floats(v)
            elif k == 'WCO':
                w = _floats(v)
                if w:
                    self.wco = w
            elif k == 'Bf':
                b = _floats(v)
                if b and len(b) >= 2:
                    self.buf = (int(b[0]), int(b[1]))
            elif k == 'FS':
                f = _floats(v)
                if f:
                    self.feed = f[0]
                    self.spindle = f[1] if len(f) > 1 else None
            elif k == 'F':
                f = _floats(v)
                if f:
                    self.feed = f[0]
            elif k == 'Ov':
                o = _floats(v)
                if o:
                    self.ov = tuple(int(x) for x in o)
            elif k == 'Pn':
                pins = v
        self.pins = pins
        wco = self.wco or (0.0, 0.0, 0.0)
        if mpos is not None:
            self.mpos = mpos
            self.wpos = tuple(a - b for a, b in zip(mpos, wco + (0.0,) * (len(mpos) - len(wco))))
        elif wpos is not None:
            self.wpos = wpos
            self.mpos = tuple(a + b for a, b in zip(wpos, wco + (0.0,) * (len(wpos) - len(wco))))
        self.position = self.wpos
        st = self.state.split(':')[0]
        self.status = STATE_TEXT.get(st, st)
        if st != 'Alarm':
            self.alarm_code = None if st == 'Idle' else self.alarm_code
        import time as _t
        with self._status_cv:
            self.status_seq += 1
            self.status_time = _t.time()
            self._status_cv.notify_all()

    def _read_param(self, idx, val):
        """$$ line: stored in grbl_params only; the profile is NOT rewritten (B8)."""
        self.grbl_params[idx] = str(val).strip()

    def read_grbl_settings(self, timeout=5.0):
        """Send $$ and return {n: value string} (collected until 'ok')."""
        self.grbl_params = {}
        ok = self.send('$$', True, timeout)
        return dict(self.grbl_params) if ok else None

    # ---- realtime (B6) ----
    def feed_hold(self):
        self.write_realtime(RT_HOLD)

    def cycle_start(self):
        self.write_realtime(RT_RESUME)

    def soft_reset(self):
        self.write_realtime(RT_RESET)

    def jog_cancel(self):
        self.write_realtime(RT_JOG_CANCEL)

    def override(self, name_or_byte):
        b = RT_OVERRIDES.get(name_or_byte, name_or_byte)
        if not isinstance(b, (bytes, bytearray)) or len(b) != 1 or not (0x90 <= b[0] <= 0x9D):
            raise ValueError('not an override byte: %r' % (name_or_byte,))
        self.write_realtime(b)

    # ---- actions ----
    def pen_cmd(self, up: bool) -> str:
        return self.pen_cmd_for(self.machine, up)

    def pen_cmd_for(self, machine, up: bool) -> str:
        g = machine.grbl
        if g.type in ('Servo', 'Laser'):
            return 'M5' if up else 'M3S%d' % g.laserS
        if g.type == 'Stepper':
            z = g.zOff if up else g.zOn
            return 'G1G90 Z%sF%d' % (jnum(z), g.zSpeed)   # same text as the file writer
        if g.type == 'Servo_bachin':
            return 'M3S%d' % (g.penUpPos if up else g.penDownPos)
        return ''

    def home_cmd(self) -> str:
        return 'G90G0 X0Y0'

    def go_home(self):
        """Back to the work origin - pen up FIRST (B12)."""
        self.set_pen(True)
        return self.send(self.home_cmd(), True)

    def zero_cmd(self, axes='xyz') -> str:
        s = self.machine.settings
        words = ''
        if 'x' in axes:
            words += 'X%s' % jfloat(s.offsetX)
        if 'y' in axes:
            words += 'Y%s' % jfloat(s.offsetY)
        if 'z' in axes:
            words += 'Z0'
        return 'G10 P0 L20 ' + words

    def set_zero(self, axes='xyz'):
        """Make the current position the work origin. axes='xy' keeps the Z
        reference (B3): setting Z0 while the pen is down breaks the pen
        height reference."""
        return self.send(self.zero_cmd(axes), True)

    def jog(self, dx, dy, dz=0.0, speed=None):
        speed = speed or self.machine.settings.jogSpeed
        try:
            v1 = float(_VER.search(self.firmware_version).group(0)) if self.firmware_version else 0.0
        except (ValueError, AttributeError):
            v1 = 0.0
        if v1 >= 1.1:
            # $J= is modal-free: it never changes the parser's G90/G91 state
            return self.send('$J=G21G91X%sY%sZ%sF%d' % (jnum(dx), jnum(dy), jnum(dz), speed), True)
        # pre-1.1 / unknown firmware: plain relative move, then restore
        # absolute mode or every later file coordinate becomes relative
        ok = self.send('G21G91G1X%sY%sZ%sF%d' % (jnum(dx), jnum(dy), jnum(dz), speed), True)
        self.send('G90', True)
        return ok

    def home_axes(self):
        return self.send('$H', True)

    def unlock(self):
        return self.send('$X', True)

    def sleep(self):
        return self.send('$SLP', True)

    def read_params(self):
        return self.send('$$', True)

    def apply_settings(self):
        """Write $30/$31/$6 for servo pens on the bachin GRBL fork only.
        On standard GRBL these are spindle max/min and probe invert, so
        writing them would break a Stepper/laser machine (B7)."""
        g = self.machine.grbl
        if g.type != 'Servo_bachin':
            return False
        self.send('$30=%d' % g.penUpPos, True)
        self.send('$31=%d' % g.penDownPos, True)
        self.send('$6=%d' % (0 if g.ecoServo else 1), True)
        return True

    def query_status(self, timeout: float = 2.0):
        """Send '?' and return the raw state of the next status report."""
        with self._status_cv:
            seq = self.status_seq
        self.write_realtime(RT_STATUS)
        if self.wait_status(seq, timeout):
            return self.state
        return None

    def wait_status(self, after_seq, timeout):
        """Block until a status report newer than after_seq arrives."""
        import time as _t
        end = _t.time() + timeout
        with self._status_cv:
            while self.status_seq <= after_seq:
                left = end - _t.time()
                if left <= 0:
                    return False
                self._status_cv.wait(left)
        return True

    def wait_idle(self, timeout: float = 600.0) -> bool:
        """Poll '?' until GRBL reports Idle (all buffered motion done).
        Returns False on Alarm or timeout."""
        end = time.time() + timeout
        while time.time() < end:
            st = self.query_status()
            if st is not None:
                if st.startswith('Idle'):
                    return True
                if st.startswith('Alarm'):
                    return False
            time.sleep(0.25)
        return False

    # ---- status polling (machine.grbl.c) ----
    def start_status_polling(self, interval=0.5):
        """At most ONE poller thread (the banner arrives after every soft
        reset; the original started a new thread each time)."""
        if self._poller is not None and self._poller.is_alive():
            return

        def poll():
            while self.connected and not self._stop:
                try:
                    self.write_realtime(RT_STATUS)
                except Exception:
                    break
                time.sleep(interval)
        self._poller = threading.Thread(target=poll, daemon=True)
        self._poller.start()


def fmt(v: float) -> str:
    s = '%.3f' % v
    return '0.000' if s == '-0.000' else s


def jnum(v) -> str:
    """Java float concat ('X'+float)."""
    f = float(v)
    if f == int(f):
        return '%d.0' % int(f)
    return repr(f)


def jfloat(v) -> str:
    return jnum(v)
