# -*- coding: utf-8 -*-
"""K_AT auto paper-feeding writing machine (machine.kat.b/c port)."""
import os
import threading

from .marlin import MarlinController
from .base import FirmwareEvent


class KatController(MarlinController):
    def _is_banner(self, line) -> bool:
        return 'K_AT' in line

    def _dispatch(self, line) -> bool:
        if line.startswith('Error:'):
            self._emit(FirmwareEvent('error',
                                     '写字机出现异常！请检查是否有缺纸，或传感器不正常。'
                                     '检查无误后，重新连接软件。'))
            return True
        if line == 'paper ready':
            self._emit(FirmwareEvent('paper_ready'))
            return True
        return super()._dispatch(line)

    def pen_cmd(self, up: bool) -> str:
        k = self.machine.kat
        return 'G1G90 E%sF%d' % (('0.2' if up else '6'), k.penSpeed)

    def set_zero_cmd(self) -> str:
        s = self.machine.settings
        return 'G92X%sY%sZ0' % (_jnum(s.offsetX), _jnum(s.offsetY))

    def wait_paper(self, timeout=120) -> bool:
        """M998 - wait until paper is loaded ('paper ready' event)."""
        ev = threading.Event()

        def h(e):
            if e.type == 'paper_ready':
                ev.set()
        self.add_event_listener(h)
        try:
            self.send('M998', False)
            return ev.wait(timeout)
        finally:
            self.remove_event_listener(h)

    def feed_out_paper(self):
        self.send('G0 Y420 F8000', True)

    def park_pen(self):
        self.send('G0 X290 F3000', True)


def _jnum(v) -> str:
    f = float(v)
    return '%d.0' % int(f) if f == int(f) else repr(f)


class KatBatchQueue:
    """machine.kat.c: queue of gcode files printed with automatic paper feed."""

    def __init__(self, controller: KatController, sender_factory):
        self.c = controller
        self.sender_factory = sender_factory   # () -> Sender
        self.items = []                        # [(file_path, copies)]

    def add(self, gcode_file: str, copies: int = 1):
        self.items.append([gcode_file, copies])

    def run(self, on_status=None):
        """Blocking batch run: wait paper -> stream file -> next copy/file."""
        for path, copies in self.items:
            with open(path, encoding='utf-8', errors='replace') as f:
                lines = [ln.strip() for ln in f if ln.strip()]
            for copy in range(copies):
                if on_status:
                    on_status('%s copy %d/%d - waiting paper' %
                              (os.path.basename(path), copy + 1, copies))
                if not self.c.wait_paper():
                    raise RuntimeError('等待纸张超时')
                s = self.sender_factory()
                s.load_commands([self.c.set_zero_cmd()] + lines, line_numbers=True)
                done = threading.Event()
                s.on_complete = lambda: done.set()
                if on_status:
                    s.on_progress = lambda p: on_status(
                        '%s copy %d/%d - %d%%' % (os.path.basename(path),
                                                  copy + 1, copies, int(p * 100)))
                s.start()
                done.wait()
        if on_status:
            on_status('batch complete')
