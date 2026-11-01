# -*- coding: utf-8 -*-
"""EBB / EiBotBoard controller (machine.ebb.b port)."""
from .base import MachineController, FirmwareEvent


class EbbController(MachineController):
    RX_CAPACITY = -1        # one command at a time, wait for 'OK'

    def _on_connect(self, port, baud):
        super()._on_connect(port, baud)
        try:
            self._write(b"\x18")
        except Exception:
            pass

    def _dispatch(self, line) -> bool:
        if line == 'OK':
            self._emit(FirmwareEvent('ok'))
            return True
        if 'Steamduino DrawCore' in line:
            self.firmware_version = line
            self._emit(FirmwareEvent('ok'))
            self._emit(FirmwareEvent('connected', line))
            return True
        if line.startswith('EBB') and 'Version' in line:
            self.firmware_version = line[line.find('Version'):]
            self._emit(FirmwareEvent('ok'))
            self._emit(FirmwareEvent('connected', self.firmware_version))
            return True
        return False

    def track_sent(self, cmd):
        """Track position/pen from our own commands (ebb.b.a(String))."""
        parts = cmd.split(',')
        if len(parts) == 4 and parts[0] == 'XM':
            self._sx = getattr(self, '_sx', 0) + int(parts[2])
            self._sy = getattr(self, '_sy', 0) + int(parts[3])
        if parts[0] == 'SP':
            self.pen_up_state = parts[1] == '1'

    def cmd_time_ms(self, cmd) -> int:
        """ebb.b.c(String): estimated execution time for flow pacing."""
        parts = cmd.split(',')
        if parts[0] == 'SP':
            return int(parts[2]) if len(parts) == 3 else 0
        if parts[0] == 'XM':
            return int(parts[1])
        return 0

    # ---- actions ----
    def pen_cmd(self, up: bool) -> str:
        # live controller (ebb.b.b(boolean)): BOTH directions use
        # toolOnDelay; only the file generator uses toolOffDelay for up
        ms = int(self.machine.settings.toolOnDelay * 1000)
        return 'SP,%d,%d' % (1 if up else 0, ms)

    def go_home(self):
        sx = getattr(self, '_sx', 0)
        sy = getattr(self, '_sy', 0)
        self.set_pen(True)
        return self.send(xm_cmd(-sx, -sy, self.machine.settings.jogSpeed, unit=1), True)

    def home_cmd(self) -> str:
        sx = getattr(self, '_sx', 0)
        sy = getattr(self, '_sy', 0)
        return xm_cmd(-sx, -sy, self.machine.settings.jogSpeed, unit=1)

    def set_zero(self, axes='xyz'):
        self._sx = 0
        self._sy = 0
        return True

    def jog(self, dx, dy, dz=0.0, speed=None):
        speed = speed or self.machine.settings.jogSpeed
        return self.send(xm_cmd(dx, dy, speed, unit=0), True)

    def sleep(self):
        self.send('EM,0,0', True)
        self.send('S2,0,4', True)

    def reset_board(self):
        self.send('R', True)

    def apply_settings(self):
        e = self.machine.ebb
        for c in ('SC,4,%d' % e.penUpPos,
                  'SC,5,%d' % e.penDownPos,
                  'SC,11,%d' % e.penUpSpeed,
                  'SC,12,%d' % e.penDownSpeed,
                  'V'):
            self.send(c, True)


def xm_cmd(dx, dy, speed_mm_min, unit=0, ebb=None, carry=None, mm_to_steps=100):
    """ebb.b.a(float dx, float dy, float speed, int unit, float[] carry, int[] steps).

    Java float32 arithmetic + Math.round (floor(x+0.5)), matching gcode.EbbWriter.
    """
    import math
    import struct as _s

    def f32(v):
        return _s.unpack('<f', _s.pack('<f', v))[0]

    rate = f32(f32(speed_mm_min / 60.0) * mm_to_steps)
    if rate > 25000.0:
        rate = 25000.0
    ax, ay = f32(dx), f32(dy)
    if unit == 0:
        ax = f32(dx * mm_to_steps)
        ay = f32(dy * mm_to_steps)
    ia, ib = int(ax), int(ay)
    if carry is not None:
        carry[0] = f32(carry[0] + f32(ax - ia))
        carry[1] = f32(carry[1] + f32(ay - ib))
        while abs(carry[0]) >= 1.0:
            k = int(carry[0])
            ia += k
            carry[0] = f32(carry[0] - k)
        while abs(carry[1]) >= 1.0:
            k = int(carry[1])
            ib += k
            carry[1] = f32(carry[1] - k)
    m = max(abs(ia), abs(ib))
    dur = int(math.floor(f32(f32(m / rate) * 1000.0) + 0.5)) if rate > 0 else 0
    dur = max(1, dur)
    return 'XM,%d,%d,%d' % (dur, ia, ib)
