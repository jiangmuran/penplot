# -*- coding: utf-8 -*-
"""G-code generation: path optimizer + per-firmware file generators.

Byte-level formats mirror the original software:
- the original app.c.a  (builder skeleton)
- the original app.c.c  (split / greedy-merge ordering / emission)
- machine.grbl.a / machine.marlin.a / machine.ebb.a (firmware writers)
"""
import math

from .geometry import Path, MOVE


def fmt3(v: float) -> str:
    """Java DecimalFormat('#0.000') - always 3 decimals, keeps '-0.000'."""
    return '%.3f' % (v + 0.0)


def _fstr(v: float) -> str:
    """Java float toString for G92 offsets etc. (e.g. 0.0, 12.5)."""
    return repr(round(v, 6)).rstrip('0').rstrip('.') if isinstance(v, float) and v != int(v) else ('%d.0' % int(v) if float(v).is_integer() else repr(v))


# ------------------------------------------------------------ splitting
def split_paths(paths):
    """Stage 1: entities -> subpath polylines (one per MOVE)."""
    out = []
    for p in paths:
        cur = None
        for op, x, y in p.iter_points():
            if op == MOVE:
                if cur is not None:
                    out.append(cur)
                cur = Path()
                cur.move_to(x, y)
            elif cur is not None:
                cur.line_to(x, y)
        if cur is not None:
            out.append(cur)
    return out


def _dist2(ax, ay, bx, by):
    dx, dy = ax - bx, ay - by
    return dx * dx + dy * dy


def optimize_paths(paths, near_dst: float):
    """Stage 2 (c.c): greedy nearest-neighbour ordering with merge/reverse.

    The current working polyline keeps absorbing the nearest remaining
    polyline while the gap <= near_dst; otherwise it is closed into the
    output and the nearest becomes the new working polyline.
    """
    remaining = list(paths)
    if not remaining:
        return []
    out = []
    cur = remaining.pop(0)
    while cur is not None:
        if out:
            prev = out[-1]
            ex, ey = prev.coords[-2], prev.coords[-1]
            sx, sy = cur.coords[0], cur.coords[1]
            if math.hypot(ex - sx, ey - sy) <= near_dst:
                prev.append(cur)
                cur = prev          # keep extending the merged polyline
            else:
                out.append(cur)
        else:
            out.append(cur)
        if not cur.coords:
            break
        ex, ey = cur.coords[-2], cur.coords[-1]
        best_i = None
        best_d = float('inf')
        best_tail = False
        for i, p in enumerate(remaining):
            d_head = _dist2(ex, ey, p.coords[0], p.coords[1])
            d_tail = _dist2(ex, ey, p.coords[-2], p.coords[-1])
            d = d_head if d_head < d_tail else d_tail
            if d < best_d:
                best_d = d
                best_i = i
                best_tail = d_tail < d_head
        if best_i is None:
            cur = None
        else:
            nxt = remaining.pop(best_i)
            if best_tail:
                nxt.reverse()
            cur = nxt
    return out


_optimize_paths_py = optimize_paths
_NUMPY_MIN = 64


def optimize_paths(paths, near_dst: float):  # noqa: F811  (same contract as _optimize_paths_py)
    """Stage 2 (c.c): greedy nearest-neighbour ordering with merge/reverse.

    Identical result to `_optimize_paths_py` (same float maths, same tie
    breaking: first remaining polyline wins, head wins over tail on a tie),
    but the nearest search is vectorised: the pure-Python O(n²) loop took
    ~65 s for a 4 400-stroke SVG on the A53 board (6 s on a desktop).
    """
    if len(paths) < _NUMPY_MIN:
        return _optimize_paths_py(paths, near_dst)
    try:
        import numpy as np
    except ImportError:          # numpy is optional for the core
        return _optimize_paths_py(paths, near_dst)
    if any(not p.coords for p in paths):
        return _optimize_paths_py(paths, near_dst)
    if not all(math.isfinite(v) for p in paths for v in (p.coords[0], p.coords[1], p.coords[-2], p.coords[-1])):
        return _optimize_paths_py(paths, near_dst)
    remaining = list(paths)
    out = []
    cur = remaining[0]
    rest = remaining[1:]
    # endpoints of the not-yet-used polylines, in their original order
    idx = np.arange(len(rest))
    hx = np.array([p.coords[0] for p in rest], dtype=np.float64)
    hy = np.array([p.coords[1] for p in rest], dtype=np.float64)
    tx = np.array([p.coords[-2] for p in rest], dtype=np.float64)
    ty = np.array([p.coords[-1] for p in rest], dtype=np.float64)
    alive = np.ones(len(rest), dtype=bool)
    n_alive = len(rest)
    inf = float('inf')
    while cur is not None:
        if out:
            prev = out[-1]
            ex, ey = prev.coords[-2], prev.coords[-1]
            sx, sy = cur.coords[0], cur.coords[1]
            if math.hypot(ex - sx, ey - sy) <= near_dst:
                prev.append(cur)
                cur = prev
            else:
                out.append(cur)
        else:
            out.append(cur)
        if not cur.coords or n_alive == 0:
            break
        ex, ey = cur.coords[-2], cur.coords[-1]
        dx = ex - hx
        dy = ey - hy
        d_head = dx * dx + dy * dy
        dx = ex - tx
        dy = ey - ty
        d_tail = dx * dx + dy * dy
        tail = d_tail < d_head
        d = np.where(tail, d_tail, d_head)
        d[~alive] = inf
        k = int(np.argmin(d))            # first minimum = first in remaining order
        if not alive[k] or not d[k] < inf:
            break                        # reference: best_i stays None -> stop
        nxt = rest[int(idx[k])]
        if tail[k]:
            nxt.reverse()
        alive[k] = False
        n_alive -= 1
        cur = nxt
        if n_alive and n_alive * 2 < len(alive) and len(alive) > 256:
            keep = alive
            idx, hx, hy, tx, ty = idx[keep], hx[keep], hy[keep], tx[keep], ty[keep]
            alive = np.ones(len(idx), dtype=bool)
    return out


# ------------------------------------------------------------ generators
class GcodeBuilder:
    """c.a equivalent: drives a firmware writer."""

    def __init__(self, machine):
        self.m = machine          # MachineConfig
        self.w = self._writer()
        self.buf = []
        self._rotate = None
        if getattr(machine.settings, 'rotate', 0.0):
            self._rotate = machine.settings.rotate

    def _writer(self):
        t = self.m.type
        if t == 'Grbl':
            return GrblWriter(self.m)
        if t == 'Marlin':
            return MarlinWriter(self.m)
        if t == 'K_AT':
            return KatWriter(self.m)
        if t == 'Ebb':
            return EbbWriter(self.m)
        raise ValueError('unknown machine type %r' % t)

    # -- skeleton (c.a) --
    def start(self):
        self.w.start(self.buf)

    def finish(self):
        self.w.finish(self.buf)

    def pen_down(self):
        self.w.pen_down(self.buf)
        self.w.dwell_on(self.buf)

    def pen_up(self):
        self.w.pen_up(self.buf)
        self.w.dwell_off(self.buf)

    def move(self, x, y, rapid):
        if self._rotate:
            r = math.radians(self._rotate)
            x, y = x * math.cos(r) - y * math.sin(r), x * math.sin(r) + y * math.cos(r)
        if self.w.move(self.buf, x, y, rapid):
            self.buf.append('\r\n')

    def text(self):
        return ''.join(self.buf)


def generate_gcode(paths, machine, optimize=True, progress=None):
    """Full pipeline (c.c.a()): paths (mm) -> gcode string."""
    paths = [p.clone() for p in paths]
    if optimize:
        sub = split_paths(paths)
        ordered = optimize_paths(sub, machine.settings.nearDst)
    else:
        ordered = []
        for p in paths:
            ordered.extend(p.subpaths())
    b = GcodeBuilder(machine)
    b.start()
    last_x = float('nan')
    last_y = float('nan')
    total = max(1, len(ordered))
    for idx, p in enumerate(ordered):
        for op, x, y in p.iter_points():
            if x != last_x or y != last_y:
                last_x, last_y = x, y
                if op == MOVE:
                    b.pen_up()
                    b.move(x, y, True)
                    b.pen_down()
                else:
                    b.move(x, y, False)
        if progress and (idx % 50 == 0):
            progress(0.6 + 0.4 * idx / total)
    b.finish()
    return b.text()


class GrblWriter:
    """machine.grbl.a + pen commands from machine.grbl.b."""

    def __init__(self, m):
        self.m = m

    def _pen_cmd(self, up: bool) -> str:
        g = self.m.grbl
        if g.type in ('Servo', 'Laser'):
            return 'M5' if up else 'M3S%d' % g.laserS
        if g.type == 'Stepper':
            # Java: "G1G90 Z" + float  ->  Float.toString, e.g. "Z2.0"
            return 'G1G90 Z%sF%d' % (_java_float(g.zOff if up else g.zOn), g.zSpeed)
        if g.type == 'Servo_bachin':
            return 'M3S%d' % (g.penUpPos if up else g.penDownPos)
        return ''

    def start(self, buf):
        s = self.m.settings
        buf.append('%s\r\n' % self.m.advanced.startGcode)
        buf.append('G21\r\n')
        buf.append('G90\r\n')
        buf.append('F%d\r\n' % s.feedRate)
        buf.append('%s\r\n' % self._pen_cmd(True))

    def finish(self, buf):
        buf.append('%s\r\n' % self._pen_cmd(True))
        self.dwell_off(buf)
        buf.append('G90G0 X0Y0\r\n')
        buf.append('%s\r\n' % self.m.advanced.endGcode)

    def pen_down(self, buf):
        buf.append('%s\r\n' % self._pen_cmd(False))

    def pen_up(self, buf):
        buf.append('%s\r\n' % self._pen_cmd(True))

    def dwell_on(self, buf):
        d = self.m.settings.toolOnDelay
        if d > 0:
            buf.append('G4 P%s\r\n' % _java_float(d))

    def dwell_off(self, buf):
        d = self.m.settings.toolOffDelay
        if d > 0:
            buf.append('G4 P%s\r\n' % _java_float(d))

    def move(self, buf, x, y, rapid):
        s = self.m.settings
        if rapid:
            buf.append('G0 X%sY%sF%d' % (fmt3(x), fmt3(y), s.jogSpeed))
        else:
            buf.append('G1 X%sY%sF%d' % (fmt3(x), fmt3(y), s.feedRate))
        return True


class MarlinWriter(GrblWriter):
    """machine.marlin.a."""

    def _pen_cmd(self, up):
        ms = self.m.marlin
        if ms.type == 'Servo':
            # Java: a("M280", "P0", "S..") - comma-joined, no spaces
            return 'M280P0S%d' % (ms.penUpPos if up else ms.penDownPos)
        if ms.type == 'Stepper':
            return 'G1G90 Z%sF%d' % (_java_float(ms.penUpMM if up else ms.penDownMM),
                                     ms.zSpeed)
        if ms.type == 'EStepper':
            return 'G1G90 E%sF%d' % (_java_float(ms.penUpMM if up else ms.penDownMM),
                                     ms.zSpeed)
        if ms.type == 'Fan':
            return 'M107' if up else 'M106 S%d' % ms.fanSpeed
        return ''

    def start(self, buf):
        # Java marlin/a.a(): startGcode + G21 + G90 + G92 - NO pen command
        s = self.m.settings
        buf.append('%s\r\n' % self.m.advanced.startGcode)
        buf.append('G21\r\n')
        buf.append('G90\r\n')
        buf.append('G92X%sY%sZ0\r\n' % (_fstr(s.offsetX), _fstr(s.offsetY)))

    def finish(self, buf):
        buf.append('%s\r\n' % self._pen_cmd(True))
        self.dwell_off(buf)
        buf.append('G0 X0Y0F%d\r\n' % self.m.settings.jogSpeed)
        buf.append('%s\r\n' % self.m.advanced.endGcode)

    def dwell_on(self, buf):
        d = self.m.settings.toolOnDelay
        if d > 0:
            buf.append('G4 P%d\r\n' % int(d * 1000))

    def dwell_off(self, buf):
        d = self.m.settings.toolOffDelay
        if d > 0:
            buf.append('G4 P%d\r\n' % int(d * 1000))


class KatWriter(MarlinWriter):
    """machine.kat.a: empty header, park+feed-paper tail, zero dwells,
    hardcoded E-axis pen commands (byte-exact literals from the original)."""

    def start(self, buf):
        # Java kat/a.a(): binds the controller only - writes NOTHING
        pass

    def finish(self, buf):
        # Java kat/a.b(): pen-up + (no dwell) + park pen + feed paper out
        self.pen_up(buf)
        buf.append('G0 X290 F3000\r\n')
        buf.append('G0 Y420 F8000\r\n')

    def pen_down(self, buf):
        buf.append('G1G90 E6F4000\r\n')

    def pen_up(self, buf):
        buf.append('G1G90 E0.2F4000\r\n')

    def dwell_on(self, buf):
        pass    # constructor forces both delays to 0

    def dwell_off(self, buf):
        pass


class EbbWriter:
    """machine.ebb.a: EBB command stream (relative stepper + sub-step carry)."""

    def __init__(self, m):
        self.m = m
        self.cx = 0.0
        self.cy = 0.0
        self.carry = [0.0, 0.0]
        self.steps = [0, 0]
        self.pen_down_state = False

    def start(self, buf):
        self.cx = self.cy = 0.0
        self.steps = [0, 0]
        self.carry = [0.0, 0.0]
        buf.append('%s\r\n' % self.m.advanced.startGcode)

    def finish(self, buf):
        self.pen_up(buf)
        buf.append('%s\r\n' % self._xm(self.steps[0] * -1, self.steps[1] * -1,
                                       self.m.settings.jogSpeed, 1))
        buf.append('%s\r\n' % self.m.advanced.endGcode)

    def pen_down(self, buf):
        buf.append('SP,0,%d\r\n' % int(self.m.settings.toolOnDelay * 1000))
        self.pen_down_state = True

    def pen_up(self, buf):
        buf.append('SP,1,%d\r\n' % int(self.m.settings.toolOffDelay * 1000))
        self.pen_down_state = False

    def dwell_on(self, buf):
        pass

    def dwell_off(self, buf):
        pass

    def move(self, buf, x, y, rapid):
        dx = x - self.cx
        dy = y - self.cy
        self.cx, self.cy = x, y
        if dx == 0.0 and dy == 0.0:
            return False
        speed = self.m.settings.feedRate if self.pen_down_state else self.m.settings.jogSpeed
        buf.append(self._xm(dx, dy, speed, 0, self.carry, self.steps))
        return True

    def _xm(self, dx, dy, speed_mm_min, unit, carry=None, steps=None):
        """ebb.b.a(dx,dy,speed,unit,carry,steps) - builds XM command.

        Uses Java float32 arithmetic and Math.round (floor(x+0.5)) semantics
        so step counts and durations match the original to the step.
        """
        e = self.m.ebb
        rate = _f32(_f32(speed_mm_min / 60.0) * e.mmToSteps)
        if rate > 25000.0:
            rate = 25000.0
        ax, ay = _f32(dx), _f32(dy)
        if unit == 0:
            ax = _f32(dx * e.mmToSteps)
            ay = _f32(dy * e.mmToSteps)
        ia = int(ax)
        ib = int(ay)
        if carry is not None:
            carry[0] = _f32(carry[0] + _f32(ax - ia))
            carry[1] = _f32(carry[1] + _f32(ay - ib))
            while abs(carry[0]) >= 1.0:
                k = int(carry[0])
                ia += k
                carry[0] = _f32(carry[0] - k)
            while abs(carry[1]) >= 1.0:
                k = int(carry[1])
                ib += k
                carry[1] = _f32(carry[1] - k)
        if steps is not None:
            steps[0] += ia
            steps[1] += ib
        m = max(abs(ia), abs(ib))
        dur = _math_round(_f32(_f32(m / rate) * 1000.0)) if rate > 0 else 0
        dur = max(1, dur)
        return 'XM,%d,%d,%d' % (dur, ia, ib)


def _f32(v: float) -> float:
    """Round to IEEE-754 binary32 (Java float arithmetic)."""
    import struct as _s
    return _s.unpack('<f', _s.pack('<f', v))[0]


def _math_round(v: float) -> int:
    """Java Math.round: floor(x + 0.5)."""
    return int(math.floor(v + 0.5))


def _java_float(v) -> str:
    """Java Float.toString (used for pen Z/E values and G4 P seconds)."""
    f = float(v)
    if f == int(f):
        return '%d.0' % int(f)
    return ('%r' % f)


def laser_dots_gcode(points_mm, machine, powers=None, dwell_s=None):
    """Laser dot mode (c.b port, extended).

    points_mm: flat [x0,y0,x1,y1,...] in mm.
    powers: optional per-dot S values (0..1); None -> machine laserS.
    dwell_s: optional per-dot G4 P seconds; None -> toolOn/toolOff dwells
    (the original emits G4 P{toolOnDelay} after burn and G4 P{toolOffDelay}
    after S0 on EVERY dot).
    """
    from .gcode import GcodeBuilder
    g = machine.grbl
    b = GcodeBuilder(machine)
    b.start()                       # full header incl. pen-up (M5)
    b.buf.append('M3S0\r\n')
    i = 0
    dot = 0
    while i < len(points_mm) - 1:
        x, y = points_mm[i], points_mm[i + 1]
        b.move(x, y, True)
        b.buf.append('\r\n')
        p = g.laserS if powers is None else int(round(powers[dot] * g.laserS))
        b.buf.append('S%d\r\n' % p)
        if dwell_s is not None:
            d = float(dwell_s[dot])
            if d > 0:
                b.buf.append('G4 P%s\r\n' % _java_float(d))
        else:
            b.w.dwell_on(b.buf)
        b.buf.append('S0\r\n')
        if dwell_s is None:
            b.w.dwell_off(b.buf)
        i += 2
        dot += 1
    b.w.finish(b.buf)
    return b.text()


# ---------------------------------------------------------------- import
_WORD = __import__('re').compile(r'([A-Za-z])\s*([+-]?\d*\.?\d+)')


def parse_gcode(text, machine=None):
    """Import G-code back into Path entities (mm). G0/G1 (modal) moves;
    pen state from M3/M4/M5, Marlin M280/M106/M107, or Z height.

    Z pen: a Z word means "pen down" when Z is closer to the profile's
    pen-down height than to its pen-up height (GrblSettings zOn/zOff, or
    Marlin penDownMM/penUpMM). Without a machine the GRBL defaults apply
    (zOn=2, zOff=0), i.e. Z > 1 is down. Several G words on one line
    ('G90G0 X0Y0', 'G1G90 Z8.0F5000') and G91 relative moves are handled.

    machine: optional MachineConfig; also gives M280 servo-angle semantics
    (S == penDownPos -> pen down). Without it, S==0 is treated as down.
    """
    import re
    word = re.compile(r'([A-Za-z])\s*([+-]?\d*\.?\d+)')
    g_re = re.compile(r'G\s*0*(\d+)', re.I)
    m_re = re.compile(r'M\s*0*(\d+)', re.I)
    marlin = machine.marlin if machine else None
    if machine is not None and machine.type in ('Marlin', 'K_AT'):
        z_down, z_up = machine.marlin.penDownMM, machine.marlin.penUpMM
    elif machine is not None:
        z_down, z_up = machine.grbl.zOn, machine.grbl.zOff
    else:
        z_down, z_up = 2.0, 0.0
    st = {'pen': False, 'cur': None}
    absolute = True
    unit = 1.0                     # G20 inch -> 25.4, G21 mm
    x = y = 0.0
    paths = []

    def set_pen(down):
        if down and not st['pen']:
            st['cur'] = Path()
            st['cur'].move_to(x, y)
        elif not down and st['pen']:
            if st['cur'] is not None and len(st['cur'].ops) > 1:
                paths.append(st['cur'])
            st['cur'] = None
        st['pen'] = down

    for raw in text.split('\n'):
        line = raw.split(';', 1)[0].split('(', 1)[0].strip()
        if not line or line.startswith('%'):
            continue
        words = {}
        for m in word.finditer(line):
            k = m.group(1).upper()
            if k not in ('G', 'M'):
                words[k] = float(m.group(2))
        gs = [int(v) for v in g_re.findall(line)]
        ms = [int(v) for v in m_re.findall(line)]
        non_motion = bool(gs) and set(gs) <= {4, 10, 28, 30, 53, 92}
        if 20 in gs:
            unit = 25.4
        if 21 in gs:
            unit = 1.0
        for k in ('X', 'Y', 'Z'):
            if k in words:
                words[k] *= unit
        if 90 in gs:
            absolute = True
        if 91 in gs:
            absolute = False
        for mcode in ms:
            if mcode in (3, 4):
                set_pen(True)
            elif mcode in (5, 107):
                set_pen(False)
            elif mcode == 280:
                sv = words.get('S')
                if marlin is not None and sv is not None:
                    set_pen(int(sv) == int(marlin.penDownPos))
                else:
                    set_pen(sv == 0)
            elif mcode == 106 and 'S' in words:
                set_pen(True)
        if non_motion:
            continue                      # dwell / offsets / homing
        if 'Z' in words and absolute:
            z = words['Z']
            set_pen(abs(z - z_down) < abs(z - z_up))
        if 'X' in words or 'Y' in words:
            if absolute:
                nx, ny = words.get('X', x), words.get('Y', y)
            else:
                nx, ny = x + words.get('X', 0.0), y + words.get('Y', 0.0)
            if st['pen']:
                # arcs (G2/G3) become straight chords; a pen-down rapid
                # still draws on a plotter
                if st['cur'] is None:
                    st['cur'] = Path()
                    st['cur'].move_to(x, y)
                st['cur'].line_to(nx, ny)
            x, y = nx, ny
    if st['cur'] is not None and len(st['cur'].ops) > 1:
        paths.append(st['cur'])
    return paths


# ---------------------------------------------------------------- analysis
class GcodeAnalysis:
    """Result of analyze_gcode(). Line k (1-based) = k-th non-empty line,
    the same numbering the Sender uses for acked_line/sent_line."""
    __slots__ = ('times', 'cum', 'xs', 'ys', 'zs', 'pen', 'bbox', 'draw_mm',
                 'travel_mm', 'pen_lifts', 'lines', 'motion_lines', 'est_s',
                 'warnings', 'absolute', 'travel_bbox', 'z_range', 'machine_moves', 'unsafe')

    def to_dict(self):
        return {'lines': self.lines, 'motion_lines': self.motion_lines,
                'bbox': list(self.bbox) if self.bbox else None,
                'draw_mm': round(self.draw_mm, 1), 'travel_mm': round(self.travel_mm, 1),
                'pen_lifts': self.pen_lifts, 'est_s': round(self.est_s, 1),
                'warnings': list(self.warnings),
                'travel_bbox': list(self.travel_bbox) if self.travel_bbox else None,
                'z_range': list(self.z_range) if self.z_range else None,
                'machine_moves': list(self.machine_moves[:20]),
                'unsafe': [{'line': n, 'reason': r} for n, r in self.unsafe[:20]]}

    def time_until(self, line):
        """Estimated seconds for lines 1..line."""
        if line <= 0 or not self.cum:
            return 0.0
        return self.cum[min(line, len(self.cum)) - 1]

    def state_at(self, line):
        """(x, y, z, absolute) after executing lines 1..line."""
        if line <= 0 or not self.xs:
            return 0.0, 0.0, 0.0, True
        i = min(line, len(self.xs)) - 1
        return self.xs[i], self.ys[i], self.zs[i], bool(self.absolute[i])


def analyze_gcode(text, machine=None, rapid_rate=None, keep_arrays=True):
    """Per-line simulation for ETA, retry-from-line and import checks (03 §10.9).

    Times: G0/G1 XY distance / feed (G0 at rapid_rate, default
    settings.jogSpeed), Z moves |dz| / feed, G4 P dwell (seconds, GRBL).
    Pen-down = Z closer to the pen-down height (as parse_gcode) or M3/M4.
    bbox covers pen-down XY moves (machine coords).
    """
    import re
    from array import array
    word = re.compile(r'([A-Za-z])\s*([+-]?\d*\.?\d+)')
    if machine is not None and machine.type in ('Marlin', 'K_AT'):
        z_down, z_up = machine.marlin.penDownMM, machine.marlin.penUpMM
    elif machine is not None:
        z_down, z_up = machine.grbl.zOn, machine.grbl.zOff
    else:
        z_down, z_up = 2.0, 0.0
    if rapid_rate is None:
        rapid_rate = machine.settings.jogSpeed if machine is not None else 2500.0
    feed = machine.settings.feedRate if machine is not None else 1500.0
    times = array('d')
    cum = array('d')
    xs, ys, zs = array('d'), array('d'), array('d')
    pen_arr = array('b')
    absa = array('b')
    x = y = z = 0.0
    absolute = True
    motion = 0
    pen = False
    total = 0.0
    draw = travel = 0.0
    lifts = 0
    motion_lines = 0
    minx = miny = float('inf')
    maxx = maxy = float('-inf')
    warnings = []
    warned = set()
    n = 0
    unit = 1.0
    from .machine.base import line_problem, strip_comments
    tminx = tminy = float('inf')
    tmaxx = tmaxy = float('-inf')
    zmin = zmax = 0.0
    machine_moves = []
    unsafe = []

    def warn(key, msg):
        if key not in warned and len(warnings) < 50:
            warned.add(key)
            warnings.append(msg)

    for raw in text.split('\n'):
        s = raw.strip()
        if not s:
            continue
        n += 1
        if len(s) > 80:
            warn('long', '第 %d 行超过 80 个字符（GRBL 行缓冲上限）' % n)
        line = strip_comments(s)
        why = line_problem(line, allow_dollar=False) if line else None
        if why and len(unsafe) < 200:
            unsafe.append((n, why))
        t = 0.0
        if line and not line.startswith(('%', '$')):
            words = []
            for m in word.finditer(line):
                words.append((m.group(1).upper(), float(m.group(2))))
            gs = [int(v) for k, v in words if k == 'G']
            ms = [int(v) for k, v in words if k == 'M']
            vals = {k: v for k, v in words if k not in ('G', 'M')}
            for g in gs:
                if g == 20:
                    unit = 25.4
                elif g == 21:
                    unit = 1.0
            for k in ('X', 'Y', 'Z', 'F'):
                if k in vals:
                    vals[k] *= unit
            for g in gs:
                if g in (0, 1, 2, 3):
                    motion = g
                    if g in (2, 3):
                        warn('arc', 'G2/G3 圆弧按直线估算')
                elif g == 90:
                    absolute = True
                elif g == 91:
                    absolute = False
                    warn('g91', '包含 G91 相对坐标段')
                elif g == 20:
                    unit = 25.4
                    warn('g20', '包含 G20 英制单位：已按英寸换算成毫米')
                elif g == 21:
                    unit = 1.0
                elif g in (28, 30, 53):
                    if len(machine_moves) < 200:
                        machine_moves.append(n)
                    warn('g%d' % g, '包含 G%d（机械坐标/存储位置移动，本机没有回零，位置不可预测）' % g)
                elif g not in (4, 10, 17, 54, 92, 94):
                    warn('g%d' % g, '不支持的 G%d' % g)
            for mc in ms:
                if mc in (3, 4):
                    if not pen:
                        pen = True
                elif mc == 5:
                    if pen:
                        lifts += 1
                    pen = False
                elif mc not in (0, 1, 2, 30, 106, 107, 280, 8, 9):
                    warn('m%d' % mc, '不支持的 M%d' % mc)
            if 'F' in vals and vals['F'] > 0:
                feed = vals['F']
            if 4 in gs:
                t += vals.get('P', 0.0)
            elif not (gs and set(gs) <= {10, 28, 30, 53, 92}):
                has_xy = 'X' in vals or 'Y' in vals
                if has_xy or 'Z' in vals:
                    motion_lines += 1
                    if absolute:
                        nx, ny, nz = vals.get('X', x), vals.get('Y', y), vals.get('Z', z)
                    else:
                        nx, ny, nz = x + vals.get('X', 0.0), y + vals.get('Y', 0.0), z + vals.get('Z', 0.0)
                    rate = rapid_rate if motion == 0 else feed
                    dxy = math.hypot(nx - x, ny - y)
                    dz = abs(nz - z)
                    d = math.sqrt(dxy * dxy + dz * dz)
                    if rate > 0:
                        t += d / rate * 60.0
                    if 'Z' in vals:
                        down = abs(nz - z_down) < abs(nz - z_up)
                        if pen and not down:
                            lifts += 1
                        pen = down
                    for px, py in ((x, y), (nx, ny)):
                        if px < tminx:
                            tminx = px
                        if px > tmaxx:
                            tmaxx = px
                        if py < tminy:
                            tminy = py
                        if py > tmaxy:
                            tmaxy = py
                    if nz < zmin:
                        zmin = nz
                    if nz > zmax:
                        zmax = nz
                    if dxy > 0:
                        if pen:
                            draw += dxy
                            for px, py in ((x, y), (nx, ny)):
                                if px < minx:
                                    minx = px
                                if px > maxx:
                                    maxx = px
                                if py < miny:
                                    miny = py
                                if py > maxy:
                                    maxy = py
                        else:
                            travel += dxy
                    x, y, z = nx, ny, nz
        total += t
        if keep_arrays:
            times.append(t)
            cum.append(total)
            xs.append(x)
            ys.append(y)
            zs.append(z)
            pen_arr.append(1 if pen else 0)
            absa.append(1 if absolute else 0)
    if pen:
        lifts += 1
    if motion_lines and draw == 0.0:
        warn('nopen', '没有检测到落笔移动（笔状态命令不识别？）')
    a = GcodeAnalysis()
    a.times, a.cum, a.xs, a.ys, a.zs, a.pen, a.absolute = times, cum, xs, ys, zs, pen_arr, absa
    a.bbox = (minx, miny, maxx, maxy) if minx != float('inf') else None
    a.draw_mm, a.travel_mm, a.pen_lifts = draw, travel, lifts
    a.lines, a.motion_lines, a.est_s = n, motion_lines, total
    a.warnings = warnings
    a.travel_bbox = (tminx, tminy, tmaxx, tmaxy) if tminx != float('inf') else None
    a.z_range = (zmin, zmax)
    a.machine_moves = machine_moves
    a.unsafe = unsafe
    if unsafe:
        warn('unsafe', '%d 行含有不能发送的内容（实时控制字符、非 ASCII 或 $ 命令），已拒绝' % len(unsafe))
    return a


def sanitize_gcode(text):
    """Comment-free, empty-line-free G-code safe to stream (P1). Raises
    UnsafeGcode for the first offending line (realtime chars, non-ASCII,
    $ system commands)."""
    from .machine.base import sanitize_line
    out = []
    for k, raw in enumerate(text.split('\n'), 1):
        ln = sanitize_line(raw, k, allow_dollar=False)
        if ln:
            out.append(ln)
    return '\r\n'.join(out) + ('\r\n' if out else '')


def toolpath_stats(gcode_text, machine=None):
    """Stats of the FINAL toolpath (after ordering), incl. time estimate (B10)."""
    a = analyze_gcode(gcode_text, machine, keep_arrays=False)
    return {'draw_mm': round(a.draw_mm, 1), 'travel_mm': round(a.travel_mm, 1),
            'pen_lifts': a.pen_lifts, 'est_s': round(a.est_s, 1), 'lines': a.lines}


def offset_gcode(text, dx, dy):
    """Shift every absolute X/Y coordinate by (dx, dy) machine mm (job placement
    for library G-code). Refuses G91 relative sections (ValueError)."""
    import re
    word = re.compile(r'([XY])\s*([+-]?\d*\.?\d+)', re.I)
    out = []
    for raw in text.split('\n'):
        line = raw.rstrip('\r')
        u = line.upper().replace(' ', '')
        if 'G91' in u:
            raise ValueError('G91 相对坐标的 G 代码不能整体平移')
        if u in ('G90G0X0Y0', 'G0X0Y0', 'G90G0X0.0Y0.0') or u.startswith(('G10', 'G92', '$')):
            out.append(line)          # park-at-origin and offset commands stay put
            continue

        def sub(m):
            v = float(m.group(2)) + (dx if m.group(1).upper() == 'X' else dy)
            return '%s%.3f' % (m.group(1).upper(), v)
        out.append(word.sub(sub, line) if ('X' in u or 'Y' in u) else line)
    return '\r\n'.join(out)
