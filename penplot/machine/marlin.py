# -*- coding: utf-8 -*-
"""Marlin controller (machine.marlin.b port)."""
import re

from .base import MachineController, FirmwareEvent

_VER = re.compile(r'[0-9]*\.[0-9]*\.[0-9]*')
_RESEND = re.compile(r'Resend: ([0-9]+)')
_SETTINGS = re.compile(r'M(\d+) X([0-9]*\.?[0-9]+) Y([0-9]*\.?[0-9]+) '
                       r'Z([0-9]*\.?[0-9]+) E([0-9]*\.?[0-9]+)*')


class MarlinController(MachineController):
    RX_CAPACITY = 96

    def _on_connect(self, port, baud):
        super()._on_connect(port, baud)
        self.send('M115', False)

    def _dispatch(self, line) -> bool:
        if not self.firmware_version and self._is_banner(line):
            m = _VER.search(line)
            if m:
                self.firmware_version = m.group(0)
            self._emit(FirmwareEvent('connected', self.firmware_version))
            return True
        if line.startswith('echo:'):
            self._parse_settings(line[5:])
            return False
        if line.lower() == 'ok':
            self._emit(FirmwareEvent('ok'))
            return True
        m = _RESEND.search(line)
        if m:
            self._emit(FirmwareEvent('resend', int(m.group(1))))
            return True
        if line.startswith('File deleted'):
            self._emit(FirmwareEvent('file_deleted', line))
            return True
        if line == 'Begin file list':
            self._listing = True
            self._files = []
            return True
        if line == 'End file list':
            self._listing = False
            self._emit(FirmwareEvent('file_list', self._files))
            return True
        if getattr(self, '_listing', False):
            self._files.append(line)
            return True
        return False

    def _is_banner(self, line) -> bool:
        return line.startswith('Marlin') or line.startswith('echo:Marlin') \
            or line.startswith('FIRMWARE_NAME:Marlin')

    def _parse_settings(self, text):
        m = _SETTINGS.search(text.strip())
        if not m:
            return
        code = int(m.group(1))
        ms = self.machine.marlin
        if code == 92:
            ms.stepsPreUnitX, ms.stepsPreUnitY = float(m.group(2)), float(m.group(3))
            ms.stepsPreUnitZ, ms.stepsPreUnitE = float(m.group(4)), float(m.group(5))
        elif code == 201:
            ms.accX, ms.accY = float(m.group(2)), float(m.group(3))
        elif code == 203:
            ms.velocityX, ms.velocityY = float(m.group(2)), float(m.group(3))
        self._emit(FirmwareEvent('settings', code))

    # ---- actions ----
    def pen_cmd(self, up: bool) -> str:
        ms = self.machine.marlin
        if ms.type == 'Servo':
            return 'M280 P0 S%d' % (ms.penUpPos if up else ms.penDownPos)
        if ms.type == 'Stepper':
            return 'G1G90 Z%sF%d' % (fmt3(ms.penUpMM if up else ms.penDownMM), ms.zSpeed)
        if ms.type == 'EStepper':
            return 'G1G90 E%sF%d' % (fmt3(ms.penUpMM if up else ms.penDownMM), ms.zSpeed)
        if ms.type == 'Fan':
            return 'M107' if up else 'M106 S%d' % ms.fanSpeed
        return ''

    def home_cmd(self) -> str:
        return 'G0 X0Y0F%d' % self.machine.settings.jogSpeed

    def go_home(self):
        """Pen up first, then back to the origin (B12)."""
        self.set_pen(True)
        self.send('G90', False)
        return self.send(self.home_cmd(), True)

    def set_zero(self, axes='xyz'):
        s = self.machine.settings
        w = ''
        if 'x' in axes:
            w += 'X%s' % jnum(s.offsetX)
        if 'y' in axes:
            w += 'Y%s' % jnum(s.offsetY)
        if 'z' in axes:
            w += 'Z0'
        return self.send('G92' + w, True)

    def jog(self, dx, dy, dz=0.0, speed=None):
        speed = speed or self.machine.settings.jogSpeed
        self.send('G91', False)
        ok = self.send('G0 X%sY%sZ%sF%d' % (jnum(dx), jnum(dy), jnum(dz), speed) if dz else
                       'G0 X%sY%sF%d' % (jnum(dx), jnum(dy), speed), True)
        self.send('G90', True)      # restore absolute mode for later jobs
        return ok

    def wait_idle(self, timeout: float = 600.0) -> bool:
        """M400 is answered with 'ok' only after all moves have finished."""
        return self.send('M400', True, timeout=timeout)

    def home_axes(self):
        self.send('G28 Z', True)

    def sleep(self):
        self.send('M18', True)

    # ---- SD card (machine.c.c.b / machine.h) ----
    def sd_list(self):
        self.send('M20', False)

    def sd_select(self, name):
        self.send('M23 %s' % name, True)

    def sd_print(self):
        self.send('M24', True)

    def sd_delete(self, name):
        self.send('M30 %s' % name, True)


def fmt3(v) -> str:
    s = '%.3f' % v
    return '0.000' if s == '-0.000' else s


def jnum(v) -> str:
    f = float(v)
    if f == int(f):
        return '%d.0' % int(f)
    return repr(f)
