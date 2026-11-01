"""Core changes for the web service (03 §10, 01 §18 B3-B12, B16, B18)."""
import glob
import os
import random
import time

from conftest import REPO

from penplot.builtin_font import load_builtin
from penplot.gcode import analyze_gcode, generate_gcode
from penplot.geometry import Path
from penplot.layout import (FontsSet, OriginSpec, PageInfo, TextDocument, check_bounds, export_transform,
                            export_transform_mm, page_presets, work_area_rect)
from penplot.machine.base import Sender
from penplot.machine.grbl import GrblController
from penplot.settings import MachineConfig, Settings
from penplot.web.machine.fake import FakeGrbl


def _ctrl(mc=None, time_scale=0.01):
    mc = mc or MachineConfig.load(os.path.join(REPO, 'configs', 'grbl-zpen.json'))
    c = GrblController(mc)
    fake = FakeGrbl(time_scale=time_scale)
    c.open('fake', ser=fake, reset=False)
    end = time.time() + 2
    while not c.firmware_version and time.time() < end:
        time.sleep(0.01)
    return c, fake


def test_status_parse_wco_and_wpos():
    c = GrblController(MachineConfig())
    c.handle_line('<Idle|MPos:10.000,5.000,0.000|Bf:15,128|FS:0,0|WCO:2.000,1.000,0.000>')
    assert c.wpos == (8.0, 4.0, 0.0) and c.buf == (15, 128)
    # WCO not repeated: cached
    c.handle_line('<Run|MPos:12.000,5.000,8.000|Bf:10,90|FS:1500,0|Ov:110,100,100|Pn:XZ>')
    assert c.wpos == (10.0, 4.0, 8.0) and c.feed == 1500 and c.ov == (110, 100, 100) and c.pins == 'XZ'
    assert c.position == c.wpos and c.state == 'Run'


def test_dollar_params_do_not_rewrite_profile_and_apply_guard():
    mc = MachineConfig()
    mc.grbl.type = 'Stepper'
    c = GrblController(mc)
    c.handle_line('$30=1000')
    c.handle_line('$31=0')
    assert c.grbl_params == {30: '1000', 31: '0'}
    assert mc.grbl.penUpPos == 50                            # B8: profile untouched
    assert c.apply_settings() is False                       # B7: no $30/$31 on standard GRBL


def test_set_zero_xy_keeps_z_and_go_home_lifts_pen():
    c, fake = _ctrl()
    assert c.set_zero('xy')
    assert fake.received_lines[-1] == 'G10 P0 L20 X0.0Y0.0'   # B3
    c.go_home()
    assert fake.received_lines[-2:] == ['G1G90 Z0.0F5000', 'G90G0 X0Y0']   # B12
    c.close()


def test_realtime_and_disconnect_event():
    c, fake = _ctrl(time_scale=1.0)
    events = []
    c.add_event_listener(lambda e: events.append(e.type))
    c.jog(10, 0, 0, 600)
    time.sleep(0.05)
    c.feed_hold()
    assert c.query_status(1.0).startswith('Hold')
    c.cycle_start()
    c.jog_cancel()
    time.sleep(0.1)
    assert c.query_status(1.0) == 'Idle'
    c.override('feed_plus_10')
    assert fake.ov[0] == 110
    s = Sender(c)
    s.load_commands(['G1 X%d Y0 F100' % i for i in range(1, 50)])
    s.start()
    time.sleep(0.05)
    fake.unplug()                                          # B5
    time.sleep(0.2)
    assert 'disconnected' in events and not c.connected
    assert s.lost and not s.running


def test_sender_counts_acks_not_sends():
    c, fake = _ctrl(time_scale=0.5)
    s = Sender(c)
    s.load_commands(['G1 X%d Y0 F6000' % i for i in range(1, 60)])
    s.start()
    time.sleep(0.15)
    assert s.sent_line > s.acked_line >= 0                  # B9
    assert s.progress() == s.acked_line / 59
    s.abort()
    c.close()


def test_analyze_gcode_times_positions():
    mc = MachineConfig.load(os.path.join(REPO, 'configs', 'grbl-zpen.json'))
    g = '\n'.join(['G21', 'G90', 'G1G90 Z0.0F5000', 'G0 X10Y0F2500', 'G1G90 Z8.0F5000', 'G1 X10Y-10F600',
                   'G4 P0.5', 'G1G90 Z0.0F5000', 'G90G0 X0Y0'])
    a = analyze_gcode(g, mc)
    assert a.lines == 9 and a.pen_lifts == 1
    assert abs(a.draw_mm - 10) < 1e-9 and abs(a.travel_mm - (10 + 14.142135623730951)) < 1e-9
    assert a.bbox == (10.0, -10.0, 10.0, 0.0)
    assert abs(a.times[5] - 1.0) < 1e-9 and abs(a.times[6] - 0.5) < 1e-9
    assert a.state_at(6) == (10.0, -10.0, 8.0, True)
    assert abs(a.est_s - a.cum[-1]) < 1e-9


def test_export_transform_mm_matches_px_version_and_corners():
    page = PageInfo(**page_presets()[0])
    s = Settings()
    p = Path().move_to(100.0, 50.0).line_to(300.0, 400.0)
    a = [p.clone()]
    export_transform(a, page, s)
    k = 25.4 / s.dpi
    b = [Path([v * k for v in p.coords], list(p.ops))]
    export_transform_mm(b, page.pageWidth, page.pageHeight)
    assert a[0].coords == b[0].coords
    # RightDown corner, offset 5/5: page point (w-5, h-5) is the origin
    q = [Path().move_to(204.0, 291.0)]
    export_transform_mm(q, 209.0, 296.0, OriginSpec(corner=3, offset_x_mm=5, offset_y_mm=5))
    assert [round(v, 9) for v in q[0].coords] == [0.0, 0.0]
    # rotation 90 swaps the page
    r = [Path().move_to(0.0, 0.0)]
    export_transform_mm(r, 100.0, 50.0, OriginSpec(rotation=90))
    assert [round(v, 6) for v in r[0].coords] == [50.0, 0.0]


def test_bounds_check_any_corner():
    assert work_area_rect(300, 200) == (0.0, -200.0, 300.0, 0.0)
    assert work_area_rect(300, 200, {'corner': 3}) == (-300.0, 0.0, 0.0, 200.0)
    assert check_bounds((0, -150, 250, 0), 300, 200) == []
    assert check_bounds((0, -250, 350, 0), 300, 200) == ['X>300', 'Y<-200']


def test_missing_glyphs_reported_and_skip_mode():
    doc = TextDocument(PageInfo(**page_presets()[0]), load_builtin(), FontsSet(), settings=Settings(),
                       rng=random.Random(1))
    ents = doc.entities('A龘B')
    assert doc.missing == {'龘'} and len(ents) == 3        # box drawn (default)
    doc2 = TextDocument(PageInfo(**page_presets()[0]), load_builtin(), FontsSet(), settings=Settings(),
                        rng=random.Random(1))
    doc2.missing_glyph = 'skip'
    assert len(doc2.entities('A龘B')) == 2


def test_read_header_matches_full_load():
    from penplot.gfont import GFont, read_header
    fs = sorted(glob.glob(os.path.join(REPO, 'fonts', '*.gfont')))
    if not fs:
        return
    for p in fs[:3]:
        h, codes = read_header(p)
        g = GFont().load(p)
        assert set(codes) == set(g.inline) | set(g._zip_glyphs)
        assert (h.name, h.size) == (g.name, g.size)


def test_fake_grbl_reset_in_motion_alarm3():
    c, fake = _ctrl(time_scale=5)
    c.send('G1 X50 F100', True)
    time.sleep(0.05)
    c.soft_reset()
    time.sleep(0.2)
    assert c.query_status(1.0) == 'Alarm' and c.alarm_code == 3
    assert not c.send('G1 X1 F100', True)                   # error:9 while locked
    c.unlock()
    assert c.query_status(1.0) == 'Idle'
    c.close()


def test_generate_gcode_unchanged_for_cli():
    mc = MachineConfig()
    p = Path().move_to(0, 0).line_to(1, 1)
    assert generate_gcode([p], mc).startswith('\r\nG21\r\nG90\r\nF1500\r\nM5')
