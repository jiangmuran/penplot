# -*- coding: utf-8 -*-
"""Sender flow control / error handling against a simulated GRBL."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from penplot.machine.base import FirmwareEvent, Sender  # noqa: E402
from penplot.machine.grbl import GrblController  # noqa: E402
from penplot.machine.marlin import MarlinController  # noqa: E402
from penplot.settings import MachineConfig  # noqa: E402


class FakeSerial:
    def __init__(self):
        self.written = []
        self.is_open = True
        self.in_waiting = 0

    def write(self, data):
        self.written.append(data)

    def close(self):
        self.is_open = False


def make(cls=GrblController, mtype='Grbl'):
    c = cls(MachineConfig(machine_type=mtype))
    c.ser = FakeSerial()
    c.connected = True
    return c


def sent_lines(c):
    return [d.decode().rstrip('\n') for d in c.ser.written if d != b'?']


def reply(c, line):
    c.handle_line(line)


def test_rx_bytes_tracked_per_line():
    c = make()
    s = Sender(c)
    s.load_commands(['G1 X%d.000Y0.000F1500' % i for i in range(20)])
    s.start()
    n0 = len(sent_lines(c))
    assert 0 < n0 < 20
    assert s._rx_chars <= c.RX_CAPACITY
    # one ok frees exactly one line's bytes -> at most one more line goes out
    reply(c, 'ok')
    assert len(sent_lines(c)) - n0 <= 1
    assert s._rx_chars == sum(n for _, _, n in s.pending)
    assert s._rx_chars <= c.RX_CAPACITY


def test_completes_after_all_ok():
    c = make()
    s = Sender(c)
    done = []
    s.on_complete = lambda: done.append(1)
    s.load_commands(['G0 X1', 'G1 X2', 'G1 X3'])
    s.start()
    for _ in range(3):
        reply(c, 'ok')
    assert done == [1] and not s.running and s._rx_chars == 0


def test_error_does_not_hang_and_stops_pen_up_first():
    c = make()
    s = Sender(c)
    done = []
    s.on_complete = lambda: done.append(1)
    s.load_commands(['M3S1000', 'G1 X1', 'G1 BAD', 'G1 X3', 'G1 X4'])
    s.start()
    reply(c, 'ok')
    reply(c, 'ok')
    reply(c, 'error:20')
    assert s.errors and s.errors[0][1] == 'error:20'
    lines = sent_lines(c)
    # after the error: no further job lines, then pen up BEFORE homing
    tail = lines[lines.index('G1 BAD') + 1:]
    tail = [t for t in tail if t not in ('G1 X3', 'G1 X4')] or tail
    assert 'M5' in tail and 'G90G0 X0Y0' in tail
    assert tail.index('M5') < tail.index('G90G0 X0Y0')
    # drain all remaining replies -> job finishes instead of hanging
    while s.pending:
        reply(c, 'ok')
    assert done == [1]


def test_error_continue_mode():
    c = make()
    s = Sender(c, stop_on_error=False)
    s.load_commands(['G1 X1', 'G1 BAD', 'G1 X3'])
    s.start()
    reply(c, 'ok')
    reply(c, 'error:20')
    reply(c, 'ok')
    assert not s.running and len(s.errors) == 1
    assert 'G1 X3' in sent_lines(c)


def test_alarm_aborts():
    c = make()
    s = Sender(c)
    done = []
    s.on_complete = lambda: done.append(1)
    s.load_commands(['G1 X%d' % i for i in range(50)])
    s.start()
    n = len(sent_lines(c))
    reply(c, 'ALARM:1')
    assert s.alarm == 'ALARM:1' and done == [1]
    reply(c, 'ok')
    assert len(sent_lines(c)) == n          # nothing more is sent


def test_marlin_error_line_is_not_a_reply():
    c = make(MarlinController, 'Marlin')
    s = Sender(c)
    s.load_commands(['G1 X1', 'G1 X2'])
    s.start()
    pend = len(s.pending)
    reply(c, 'error:something')            # Marlin follows up with ok/Resend
    assert len(s.pending) == pend


def test_single_step_one_in_flight():
    c = make()
    s = Sender(c, single_step=True)
    s.load_commands(['G1 X1', 'G1 X2', 'G1 X3'])
    s.start()
    assert len(sent_lines(c)) == 1
    s._fill()
    assert len(sent_lines(c)) == 1
    reply(c, 'ok')
    assert len(sent_lines(c)) == 2


def test_pause_lifts_pen_once_and_resume_lowers():
    c = make()
    s = Sender(c, single_step=True)
    s.load_commands(['M3S1000', 'G1 X1', 'G1 X2', 'G1 X3', 'M5'])
    s.start()                     # M3S1000 out
    reply(c, 'ok')                # G1 X1 out
    s.pause()
    reply(c, 'ok')                # injected M5 goes out
    reply(c, 'ok')
    reply(c, 'ok')                # still paused: nothing else
    lines = sent_lines(c)
    assert lines == ['M3S1000', 'G1 X1', 'M5']
    s.resume()                    # pen back down, then continue
    assert sent_lines(c)[-1] == 'M3S1000'
    reply(c, 'ok')
    assert sent_lines(c)[-1] == 'G1 X2'


def test_grbl_status_parsing_and_alarm_event():
    c = make()
    evs = []
    c.add_event_listener(lambda e: evs.append(e.type))
    reply(c, '<Idle|MPos:1.000,2.500,0.000|FS:0,0>')
    assert c.state == 'Idle' and c.position == (1.0, 2.5, 0.0)
    reply(c, 'ALARM:2')
    assert c.state == 'Alarm' and 'alarm' in evs


def test_send_wait_ok_registers_before_write():
    c = make()

    class InstantOk(FakeSerial):
        def write(self, data):
            super().write(data)
            c.handle_line('ok')      # reply arrives "during" the write
    c.ser = InstantOk()
    assert c.send('G90', True, timeout=0.5) is True


def test_send_wait_ok_returns_false_on_error():
    c = make()

    class InstantErr(FakeSerial):
        def write(self, data):
            super().write(data)
            c.handle_line('error:9')
    c.ser = InstantErr()
    assert c.send('G1 X1', True, timeout=0.5) is False


def test_jog_fallback_restores_absolute_mode():
    c = make()
    c.firmware_version = ''          # unknown firmware -> legacy jog

    class AutoOk(FakeSerial):
        def write(self, data):
            super().write(data)
            c.handle_line('ok')
    c.ser = AutoOk()
    c.jog(5, 0)
    lines = sent_lines(c)
    assert lines[0].startswith('G21G91') and lines[-1] == 'G90'


def test_unused_event_type_ignored():
    c = make()
    s = Sender(c)
    s._handle_event(FirmwareEvent('status', 'Idle'))
    assert not s.running
