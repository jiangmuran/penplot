# -*- coding: utf-8 -*-
"""Regression tests: deterministic layout, G-code import of Z-pen files."""
import os
import random
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from penplot.builtin_font import load_builtin  # noqa: E402
from penplot.gcode import generate_gcode, parse_gcode  # noqa: E402
from penplot.geometry import Path  # noqa: E402
from penplot.layout import FontsSet, PageInfo, TextDocument, page_presets  # noqa: E402
from penplot.settings import MachineConfig, Settings  # noqa: E402


def _doc(seed=3):
    fs = FontsSet()
    fs.randomFontSize = [0.8, 1.2]
    fs.randomRotate = [-8.0, 8.0]
    fs.randomY = 0.2
    return TextDocument(PageInfo(**page_presets()[0]), load_builtin(), fs,
                        settings=Settings(), rng=random.Random(seed))


def _sig(ents):
    return [tuple(round(v, 3) for v in e.coords) for e in ents]


def test_layout_is_cached_and_pages_consistent():
    text = '\n'.join('LINE %02d HELLO WORLD' % i for i in range(45))
    doc = _doc()
    n_pages = len(doc.layout(text))
    assert n_pages >= 2
    # exporting page by page must give the same glyphs as a second pass
    a = [_sig(doc.entities(text, page_index=i)) for i in range(n_pages)]
    b = [_sig(doc.entities(text, page_index=i)) for i in range(n_pages)]
    assert a == b
    # the same seed in a fresh document reproduces the same pages
    doc2 = _doc()
    assert len(doc2.layout(text)) == n_pages
    assert [_sig(doc2.entities(text, page_index=i)) for i in range(n_pages)] == a


def _square():
    p = Path()
    p.move_to(10, -10)
    for x, y in ((20, -10), (20, -20), (10, -20), (10, -10)):
        p.line_to(x, y)
    return p


def test_gcode_roundtrip_z_pen_profile():
    mc = MachineConfig(machine_type='Grbl')
    mc.grbl.type = 'Stepper'
    mc.grbl.zOff, mc.grbl.zOn = 0.0, 8.0
    g = generate_gcode([_square()], mc, optimize=False)
    assert 'Z8.0' in g and 'M3' not in g
    paths = parse_gcode(g, mc)
    assert len(paths) == 1
    pts = list(zip(paths[0].coords[0::2], paths[0].coords[1::2]))
    assert pts[0] == (10.0, -10.0) and (20.0, -20.0) in pts


def test_gcode_roundtrip_servo_profile():
    mc = MachineConfig(machine_type='Grbl')
    g = generate_gcode([_square()], mc, optimize=False)
    assert len(parse_gcode(g, mc)) == 1


def test_parse_multi_g_words_and_relative():
    # 'G90G0 X0Y0' is a rapid, not a drawn move; G91 moves are relative
    paths = parse_gcode('G21\nM5\nG0 X1Y1\nM3S1000\nG1 X5Y1\nM5\nG90G0 X0Y0\n'
                        'G91\nM3\nG1 X1Y0\nG1 X0Y1\nM5\n')
    assert len(paths) == 2
    assert list(paths[1].coords) == [0.0, 0.0, 1.0, 0.0, 1.0, 1.0]


def test_parse_ignores_offsets_and_dwell():
    paths = parse_gcode('G10 P0 L20 X5Y5Z0\nG4 P0.2\nM3\nG1 X1Y1\nM5\n')
    assert len(paths) == 1 and paths[0].coords[:2] == [0.0, 0.0]


def test_arc_with_identical_endpoints_is_omitted():
    # used to raise ZeroDivisionError (SVG spec: zero-length arc is skipped)
    p = Path()
    p.move_to(5.0, 5.0)
    p.arc_to_beziers(5.0, 5.0, 3.0, 3.0, 0.0, False, True, 5.0, 5.0)
    assert len(p.coords) == 2
