"""FakeGrbl: in-process serial-port stand-in emulating GRBL 1.1f closely
enough for the web service, tests and UI development (PENPLOT_SERIAL_PORT=fake).

Emulated: 128 B RX buffer (overflow counted), 15-block planner with timed
motion (time_scale speeds it up), '?' status with MPos/Bf/FS/WCO(every 10th)/Ov,
realtime ! ~ 0x18 0x85 and overrides, feed-hold deceleration (Hold:1 -> Hold:0),
soft reset with ALARM:3 when reset in motion, $$ / $N=v / $X / $H / $SLP / $J=,
G0/G1/G4/G10 L20/G90/G91/G21/M3/M5, error:N for unsupported words, and
unplug() (reads raise, like a vanished USB device).

Fault injection (tests, and dev via PENPLOT_FAKE_FAULTS="slow_acks=0.05,garbage=0.02,
error_every=300,alarm_after=30,unplug_after=60,reset_after=45,reset_in_motion_after=20"):
  slow_acks=S        delay every 'ok' by S seconds
  garbage=P          with probability P emit a line of random bytes between replies
  error_every=N      every N-th motion line answers error:20
  alarm_after=S      ALARM:1 (hard limit) S seconds after open
  unplug_after=S     vanish S seconds after open
  reset_after=S      spontaneous MCU reset (brown-out): banner, MPos -> 0
  reset_in_motion_after=S  spontaneous reset; ALARM:3 if moving
"""
import collections
import math
import random
import re
import threading
import time

BANNER = "Grbl 1.1f ['$' for help]"
RX_SIZE = 128
PLANNER = 15
_WORD = re.compile(r'([A-Z])([+-]?\d*\.?\d+)')

DEFAULT_SETTINGS = {
    0: '10', 1: '25', 2: '0', 3: '0', 4: '0', 5: '0', 6: '0', 10: '1', 11: '0.010', 12: '0.002',
    13: '0', 20: '0', 21: '0', 22: '0', 23: '0', 24: '25.000', 25: '500.000', 26: '250', 27: '1.000',
    30: '1000', 31: '0', 32: '0', 100: '80.000', 101: '80.000', 102: '400.000', 110: '5000.000',
    111: '5000.000', 112: '5000.000', 120: '200.000', 121: '200.000', 122: '200.000',
    130: '300.000', 131: '300.000', 132: '50.000',
}


class SerialLost(OSError):
    pass


class FakeGrbl:
    def __init__(self, time_scale=1.0, reset_on_open=True, faults=None):
        self.time_scale = float(time_scale)
        self._out = bytearray()
        self._olock = threading.Lock()
        self._rx = bytearray()           # unparsed line bytes (GRBL serial RX buffer)
        self._cv = threading.Condition()
        self.is_open = True
        self.unplugged = False
        self.overflows = 0
        self.received_lines = []         # every line accepted (for tests)
        self.settings = dict(DEFAULT_SETTINGS)
        self.mpos = [0.0, 0.0, 0.0]
        self.wco = [0.0, 0.0, 0.0]
        self.absolute = True
        self.motion = 0
        self.feed = 1500.0
        self.state = 'Idle'
        self.alarm = False
        self.planner = collections.deque()  # blocks: dict(target, feed, dwell, jog)
        self.cur = None                  # executing block
        self.hold = False                # feed hold requested
        self.hold_done = False
        self.ov = [100, 100, 100]
        self._reports = 0
        self.fail_lines = {}             # substring -> 'error:N' (test injection)
        self.faults = {}
        self.rt_log = []                 # realtime bytes seen (tests)
        self._motion_n = 0
        self._t0 = time.time()
        self._stop = False
        if isinstance(faults, str):
            faults = parse_faults(faults)
        self.faults = dict(faults or {})
        self._t = threading.Thread(target=self._run, daemon=True, name='fakegrbl')
        self._t.start()
        if reset_on_open:
            self._emit('')
            self._emit(BANNER)

    # ---------------------------------------------------------- serial API
    @property
    def in_waiting(self):
        if self.unplugged:
            raise SerialLost('device disconnected')
        with self._olock:
            return len(self._out)

    def read(self, n=1):
        if self.unplugged:
            raise SerialLost('device disconnected')
        with self._olock:
            d = bytes(self._out[:n])
            del self._out[:n]
            return d

    def write(self, data):
        if self.unplugged or not self.is_open:
            raise SerialLost('write failed: device disconnected')
        for b in bytes(data):
            if b in (0x21, 0x7E, 0x18, 0x84, 0x85) or 0x90 <= b <= 0x9D:
                self.rt_log.append(b)
            if b == 0x84:            # safety door: GRBL holds and parks
                with self._cv:
                    self.hold = True
                    self.hold_done = False
                    self._hold_t = time.time()
                    self.state = 'Door:1'
                continue
            if b == 0x3F:            # ?
                self._status()
            elif b == 0x21:          # !
                with self._cv:
                    if self.state in ('Run', 'Jog') or self.cur:
                        self.hold = True
                        self.hold_done = False
                        self._hold_t = time.time()
                        self.state = 'Hold:1'
                    self._cv.notify_all()
            elif b == 0x7E:          # ~
                with self._cv:
                    if self.hold:
                        self.hold = False
                        self.hold_done = False
                        self.state = 'Run' if (self.cur or self.planner) else 'Idle'
                    self._cv.notify_all()
            elif b == 0x18:
                self._soft_reset()
            elif b == 0x85:
                with self._cv:
                    if self.cur and self.cur.get('jog') or any(p.get('jog') for p in self.planner):
                        self.planner = collections.deque(p for p in self.planner if not p.get('jog'))
                        if self.cur and self.cur.get('jog'):
                            self.cur = None
                        self.state = 'Idle'
                    self._cv.notify_all()
            elif 0x90 <= b <= 0x9D:
                self._override(b)
            elif b >= 0x80:
                pass
            else:
                with self._cv:
                    if len(self._rx) >= RX_SIZE:
                        self.overflows += 1
                        continue
                    self._rx.append(b)
                    self._cv.notify_all()
        return len(data)

    def close(self):
        self.is_open = False
        self._stop = True
        with self._cv:
            self._cv.notify_all()

    def flush(self):
        pass

    # ---------------------------------------------------------- test hooks
    def unplug(self):
        self.unplugged = True
        self.is_open = False
        self._stop = True
        with self._cv:
            self._cv.notify_all()

    def trigger_alarm(self, code=1):
        with self._cv:
            self.planner.clear()
            self.cur = None
            self._rx.clear()
            self.alarm = True
            self.state = 'Alarm'
        self._emit('ALARM:%d' % code)

    def inject(self, kind, value=None):
        """Runtime fault: unplug | alarm[=code] | reset | reset_in_motion | garbage[=P] |
        slow_acks[=S] | error_every[=N] | error_next[=N] | clear."""
        if kind == 'unplug':
            self.unplug()
        elif kind == 'alarm':
            self.trigger_alarm(int(value or 1))
        elif kind in ('reset', 'reset_in_motion'):
            self.spontaneous_reset(kind == 'reset_in_motion')
        elif kind == 'error_next':
            self.faults['error_next'] = int(value or 1)
        elif kind == 'clear':
            self.faults.clear()
            self.fail_lines.clear()
        elif kind in ('garbage', 'slow_acks', 'error_every'):
            self.faults[kind] = float(value) if value is not None else {'garbage': 0.1, 'slow_acks': 0.05,
                                                                         'error_every': 50}[kind]
        else:
            raise ValueError('unknown fault %r' % kind)

    def spontaneous_reset(self, alarm_if_moving=True):
        """MCU reset without a 0x18 (brown-out / DTR glitch): position lost."""
        with self._cv:
            moving = bool(self.cur or self.planner)
            self.planner.clear()
            self.cur = None
            self._rx.clear()
            self.hold = False
            self.mpos = [0.0, 0.0, 0.0]
            self.absolute = True
            if moving and alarm_if_moving:
                self.alarm = True
            self.state = 'Alarm' if self.alarm else 'Idle'
        if moving and alarm_if_moving:
            self._emit('ALARM:3')
        self._emit('')
        self._emit(BANNER)

    def _timed_faults(self):
        f = self.faults
        el = time.time() - self._t0
        for k in ('alarm_after', 'unplug_after', 'reset_after', 'reset_in_motion_after'):
            v = f.get(k)
            if v is not None and el >= float(v):
                f.pop(k)
                if k == 'alarm_after':
                    self.trigger_alarm(1)
                elif k == 'unplug_after':
                    self.unplug()
                else:
                    self.spontaneous_reset(k == 'reset_in_motion_after')

    @property
    def wpos(self):
        return [m - w for m, w in zip(self.mpos, self.wco)]

    # ---------------------------------------------------------- internals
    def _emit(self, line):
        with self._olock:
            self._out += (line + '\r\n').encode()

    def _override(self, b):
        if b == 0x90:
            self.ov[0] = 100
        elif b in (0x91, 0x92, 0x93, 0x94):
            d = {0x91: 10, 0x92: -10, 0x93: 1, 0x94: -1}[b]
            self.ov[0] = max(10, min(200, self.ov[0] + d))
        elif b in (0x95, 0x96, 0x97):
            self.ov[1] = {0x95: 100, 0x96: 50, 0x97: 25}[b]
        elif b == 0x99:
            self.ov[2] = 100
        elif b in (0x9A, 0x9B, 0x9C, 0x9D):
            d = {0x9A: 10, 0x9B: -10, 0x9C: 1, 0x9D: -1}[b]
            self.ov[2] = max(10, min(200, self.ov[2] + d))

    def _status(self):
        with self._cv:
            st = self.state
            mp = list(self.mpos)
            bf = PLANNER - len(self.planner) - (1 if self.cur else 0)
            rxf = RX_SIZE - len(self._rx)
            feed = self.cur['feed'] if self.cur and not self.hold_done else 0
        self._reports += 1
        parts = [st, 'MPos:%.3f,%.3f,%.3f' % tuple(mp), 'Bf:%d,%d' % (max(0, bf), rxf),
                 'FS:%d,0' % feed]
        if self._reports % 10 == 1:
            parts.append('WCO:%.3f,%.3f,%.3f' % tuple(self.wco))
        elif self._reports % 10 == 2:
            parts.append('Ov:%d,%d,%d' % tuple(self.ov))
        self._emit('<%s>' % '|'.join(parts))

    def _soft_reset(self):
        with self._cv:
            moving = bool(self.cur or self.planner) and not (self.hold and self.hold_done)
            self.planner.clear()
            self.cur = None
            self._rx.clear()
            self.hold = False
            self.hold_done = False
            self.absolute = True
            self.motion = 0
            if moving:
                self.alarm = True
            self.state = 'Alarm' if self.alarm else 'Idle'
            self._cv.notify_all()
        if moving:
            self._emit('ALARM:3')
        self._emit('')
        self._emit(BANNER)
        if self.alarm:
            self._emit("[MSG:'$H'|'$X' to unlock]")

    def _run(self):
        last = time.time()
        while not self._stop:
            if self.faults:
                self._timed_faults()
                if self._stop:
                    break
            with self._cv:
                now = time.time()
                dt = now - last
                last = now
                self._advance(dt)
                line = self._next_line()
                if line is None:
                    self._cv.wait(0.005)
                    continue
            reply = self._exec(line)
            f = self.faults
            for r in reply:
                if r == 'ok' and f.get('slow_acks'):
                    time.sleep(float(f['slow_acks']))
                if f.get('garbage') and random.random() < float(f['garbage']):
                    with self._olock:
                        self._out += bytes(random.randrange(1, 255) for _ in range(random.randint(1, 12)))
                        self._out += b'\r\n'
                self._emit(r)

    def _next_line(self):
        i = self._rx.find(b'\n')
        if i < 0:
            return None
        raw = bytes(self._rx[:i]).decode('utf-8', 'replace').strip()
        upper = raw.upper().replace(' ', '')
        # motion lines wait for planner room (GRBL blocks the parser)
        if upper and (upper[0] in 'GXYZF' or upper.startswith('$J=')) and \
                len(self.planner) + (1 if self.cur else 0) >= PLANNER:
            return None
        del self._rx[:i + 1]
        return raw

    def _advance(self, dt):
        """Move along the current block (called under _cv)."""
        if self.hold:
            if not self.hold_done and time.time() - self._hold_t > 0.15 * self.time_scale:
                self.hold_done = True
                self.state = 'Hold:0'
            if self.hold_done:
                return
            dt *= 0.3   # decelerating
        while dt > 0:
            if self.cur is None:
                if not self.planner:
                    if self.state in ('Run', 'Jog'):
                        self.state = 'Idle'
                    return
                self.cur = self.planner.popleft()
                self.cur['start'] = list(self.mpos)
                self.cur['t'] = 0.0
                if not self.alarm and self.state != 'Sleep':
                    self.state = 'Jog' if self.cur.get('jog') else 'Run'
            b = self.cur
            if b.get('dwell') is not None:
                total = b['dwell'] * self.time_scale
            else:
                d = math.dist(b['start'], b['target'])
                rate = b['feed'] * (self.ov[1 if b.get('rapid') else 0] / 100.0)
                total = (d / rate * 60.0 if rate > 0 else 0.0) * self.time_scale
            step = min(dt, max(0.0, total - b['t']))
            b['t'] += step
            dt -= step
            if b.get('dwell') is None:
                f = 1.0 if total <= 0 else min(1.0, b['t'] / total)
                self.mpos = [s + (t - s) * f for s, t in zip(b['start'], b['target'])]
            if b['t'] >= total - 1e-12:
                if b.get('dwell') is None:
                    self.mpos = list(b['target'])
                self.cur = None
            else:
                break

    def _exec(self, line):
        if not line:
            return ['ok']
        self.received_lines.append(line)
        for k, err in self.fail_lines.items():
            if k in line:
                return [err]
        u = line.upper().replace(' ', '')
        if u.startswith('$'):
            return self._dollar(u)
        if any(a in u for a in 'XYZ') and not u.startswith('G10'):
            self._motion_n += 1
            ev = self.faults.get('error_every')
            if self.faults.get('error_next'):
                self.faults['error_next'] -= 1
                if self.faults['error_next'] <= 0:
                    self.faults.pop('error_next')
                return ['error:20']
            if ev and self._motion_n % int(ev) == 0:
                return ['error:20']
        if self.alarm:
            return ['error:9']
        if self.state == 'Sleep':
            return ['error:9']
        words = _WORD.findall(u.split(';')[0].split('(')[0])
        if not words or ''.join(k + v for k, v in words) == '':
            return ['error:1']
        vals = {}
        gs = []
        for k, v in words:
            if k == 'G':
                gs.append(float(v))
            elif k == 'M':
                if int(float(v)) not in (0, 1, 2, 3, 4, 5, 8, 9, 30):
                    return ['error:20']
            elif k in 'XYZFPSLN':
                vals[k] = float(v)
            else:
                return ['error:20']
        with self._cv:
            for g in gs:
                gi = int(g)
                if g != gi:
                    return ['error:20']
                if gi in (0, 1):
                    self.motion = gi
                elif gi == 90:
                    self.absolute = True
                elif gi == 91:
                    self.absolute = False
                elif gi in (2, 3):
                    self.motion = 1      # arcs approximated as lines
                elif gi not in (4, 10, 17, 20, 21, 54, 92, 94, 28, 30, 53):
                    return ['error:20']
            if 'F' in vals:
                self.feed = vals['F']
            if 4 in [int(g) for g in gs]:
                self.planner.append({'dwell': vals.get('P', 0.0), 'feed': 0})
                return ['ok']
            if 10 in [int(g) for g in gs]:
                if vals.get('L') == 20:
                    for i, a in enumerate('XYZ'):
                        if a in vals:
                            # wait for motion to end first (GRBL syncs G10)
                            self.wco[i] = self._end_pos()[i] - vals[a]
                return ['ok']
            if 92 in [int(g) for g in gs]:
                return ['ok']
            if any(a in vals for a in 'XYZ'):
                base = self._end_pos()
                wbase = [b - w for b, w in zip(base, self.wco)]
                tgt = list(base)
                for i, a in enumerate('XYZ'):
                    if a in vals:
                        tgt[i] = (vals[a] + self.wco[i]) if self.absolute else (base[i] + vals[a])
                del wbase
                rapid = self.motion == 0
                feed = float(self.settings.get(110, 5000)) if rapid else self.feed
                if feed <= 0:
                    return ['error:22']
                self.planner.append({'target': tgt, 'feed': feed, 'rapid': rapid})
                self._cv.notify_all()
        return ['ok']

    def _end_pos(self):
        if self.planner:
            for b in reversed(self.planner):
                if 'target' in b:
                    return list(b['target'])
        if self.cur and 'target' in self.cur:
            return list(self.cur['target'])
        return list(self.mpos)

    def _dollar(self, u):
        if u == '$$':
            out = ['$%d=%s' % (k, v) for k, v in sorted(self.settings.items())]
            return out + ['ok']
        if u == '$':
            return ['[HLP:$$ $# $G $I $N $x=val $Nx=line $J=line $SLP $C $X $H ~ ! ? ctrl-x]', 'ok']
        if u == '$X':
            with self._cv:
                self.alarm = False
                if self.state == 'Alarm':
                    self.state = 'Idle'
            return ["[MSG:Caution: Unlocked]", 'ok']
        if u == '$H':
            if self.settings.get(22, '0') == '0':
                return ['error:5']
            return ['ok']
        if u == '$SLP':
            with self._cv:
                self.state = 'Sleep'
            return ['ok', '[MSG:Sleeping]']
        if u == '$I':
            return ['[VER:1.1f.20170801:]', '[OPT:V,15,128]', 'ok']
        if u == '$G':
            return ['[GC:G%d G54 G17 G21 G%d G94 M5 M9 T0 F%d S0]' % (self.motion, 90 if self.absolute else 91,
                                                                   self.feed), 'ok']
        if u.startswith('$J='):
            if self.alarm:
                return ['error:9']
            words = dict((k, float(v)) for k, v in _WORD.findall(u[3:]))
            rel = 'G91' in u[3:]
            with self._cv:
                if self.cur and not self.cur.get('jog') or any(not p.get('jog') for p in self.planner):
                    return ['error:8']
                base = self._end_pos()
                tgt = list(base)
                for i, a in enumerate('XYZ'):
                    if a in words:
                        tgt[i] = base[i] + words[a] if rel else words[a] + self.wco[i]
                if 'F' not in words:
                    return ['error:22']
                self.planner.append({'target': tgt, 'feed': words['F'], 'jog': True})
                self._cv.notify_all()
            return ['ok']
        m = re.match(r'^\$(\d+)=(.+)$', u)
        if m:
            self.settings[int(m.group(1))] = m.group(2)
            return ['ok']
        return ['error:3']


def parse_faults(spec):
    out = {}
    for part in (spec or '').split(','):
        part = part.strip()
        if not part:
            continue
        k, _, v = part.partition('=')
        try:
            out[k.strip()] = float(v) if v else 1.0
        except ValueError:
            pass
    return out


class FakeMarlin:
    """Minimal Marlin stand-in: 'start' banner, M115 firmware line, 'ok' for
    every line (after a short delay), M400 acked immediately. Enough to run
    Marlin/K_AT profiles through the web service."""

    def __init__(self, delay=0.001):
        self._out = bytearray()
        self._lock = threading.Lock()
        self._buf = b''
        self.is_open = True
        self.unplugged = False
        self.delay = delay
        self.received_lines = []
        self.faults = {}
        self._emit('start')

    def _emit(self, line):
        with self._lock:
            self._out += (line + '\n').encode()

    @property
    def in_waiting(self):
        if self.unplugged:
            raise SerialLost('device disconnected')
        with self._lock:
            return len(self._out)

    def read(self, n=1):
        with self._lock:
            d = bytes(self._out[:n])
            del self._out[:n]
            return d

    def write(self, data):
        if self.unplugged:
            raise SerialLost('write failed')
        self._buf += bytes(data)
        while b'\n' in self._buf:
            raw, self._buf = self._buf.split(b'\n', 1)
            line = raw.decode('utf-8', 'replace').strip()
            if not line:
                continue
            self.received_lines.append(line)
            if line.startswith('M115'):
                self._emit('FIRMWARE_NAME:Marlin 2.1.2 (fake) SOURCE_CODE_URL:x PROTOCOL_VERSION:1.0')
            time.sleep(self.delay)
            self._emit('ok')
        return len(data)

    def close(self):
        self.is_open = False

    def unplug(self):
        self.unplugged = True
        self.is_open = False

    def inject(self, kind, value=None):
        if kind == 'unplug':
            self.unplug()
        else:
            raise ValueError('FakeMarlin supports only unplug')
