# -*- coding: utf-8 -*-
"""Tests for v0.2: psf/gfont interchange, builtin font, image-to-path, gcode import."""
import os
import sys
import random

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import require_fonts, FONT_DIR, TTF_DIR, require  # noqa: E402
require_fonts('zy01.gfont')
import numpy as np

from penplot import (tea, GFont, StrokeFont, read_psf, write_psf,
                     write_gfont_bytes, convert_font, load_font, load_builtin)
from penplot.gcode import generate_gcode, parse_gcode
from penplot.settings import MachineConfig, Settings
from penplot.layout import PageInfo, TextDocument, FontsSet, LineAlign, export_transform
from penplot import image as imgmod
from penplot import preview as pv

import tempfile
TMP = tempfile.mkdtemp(prefix='penplot-test-')
ok = fail = 0


def check(name, cond):
    global ok, fail
    if cond:
        ok += 1
        print('  PASS %s' % name)
    else:
        fail += 1
        print('  FAIL %s' % name)


SRC_GFONT = os.path.join(FONT_DIR, 'zy01.gfont')

print('== 1. gfont -> psf -> gfont roundtrip ==')
g1 = GFont().load(SRC_GFONT)
sf = StrokeFont.from_gfont(g1)
check('psf font glyph count', sf.glyph_count > 2000)
psf_path = os.path.join(TMP, 't_zy01.psf')
write_psf(sf, psf_path)
sf2 = read_psf(psf_path)
check('psf reparsed glyph count', sf2.glyph_count == sf.glyph_count)
gz = sf2.glyph('中')
gz0 = g1.glyph('中')
check('glyph coords identical',
      all(abs(a - b) < 1e-4 for a, b in zip(gz.coords, gz0.coords))
      and gz.ops == list(gz0.ops))
g2_path = os.path.join(TMP, 't_zy01.gfont')
open(g2_path, 'wb').write(write_gfont_bytes(sf2))
g2 = GFont().load(g2_path)
check('repacked gfont loads', g2.glyph_count >= sf2.glyph_count - 30)  # zip glyphs
gz2 = g2.glyph('中')
check('repacked gfont glyph data', gz2 is not None and
      [round(v, 3) for v in gz2.coords] == [round(v, 3) for v in gz0.coords])

print('== 2. builtin font ==')
bf = load_builtin()
check('builtin has A-Z0-9a-z', all(bf.has_glyph(c) for c in
      'ABCXYZabcxyz0123456789.,:;!?+-/()'))
psf_b = os.path.join(TMP, 'penplot-sans.psf')
write_psf(bf, psf_b)
bf2 = load_font(psf_b)
check('builtin psf reload', bf2.glyph('Q') is not None and bf2.size == 100)
# layout with builtin
page = PageInfo(pageWidth=209, pageHeight=296, leftGap=31.8, rightGap=31.8,
                topGap=25.4, bottomGap=25.4, lineNum=20)
s = Settings()
doc = TextDocument(page, bf2, FontsSet(), settings=s, rng=random.Random(3))
ents = doc.entities('PENPLOT 2026 built-in font test!')
# 31 chars, 4 spaces -> 27 stroke paths expected
check('builtin layout entities', 25 <= len(ents) <= 31)
bb = None
from penplot.geometry import bbox_of
bb = bbox_of(ents)
check('builtin layout bbox sane', bb and bb[3] > bb[1] > 0)

print('== 3. image: edge / skeleton / dots ==')
# synthetic image: white square 20..60 with a diagonal line, 100x100 (1=ink)
ink = np.zeros((100, 100))
ink[20:60, 20:60] = 1.0
for i in range(10, 90):
    ink[i, i] = 1.0
edges = imgmod.canny(ink, low=0.05, high=0.2, sigma=1.0)
check('canny finds edges', edges.sum() > 100)
paths = imgmod.mask_to_paths(edges, min_points=8)
check('contours traced', len(paths) >= 1)
check('contour coords in range',
      all(0 <= p.coords[i] <= 100 for p in paths for i in range(len(p.coords))))
skel = imgmod.zhang_suen(ink > 0.5)
sps = imgmod.skeleton_to_paths(skel, min_points=3)
# directional walking: filled square -> 1 stroke, diagonal -> 1 stroke
check('skeleton traced', len(sps) >= 1 and sum(len(p.ops) for p in sps) > 20)
xs, ys, vs = imgmod.halftone_dots(ink, 5)
# dots may sit in the square OR on the diagonal line
def in_ink(x, y):
    return (20 <= x <= 60 and 20 <= y <= 60) or abs(x - y) <= 6
check('halftone dots only on ink', all(in_ink(x, y) for x, y in zip(xs, ys)))
check('halftone values full darkness', all(v == 1.0 for v in vs))

# small real-ish render: draw squares -> verify edge path closes around region
imgmod.paths_to_mm(paths, 50.0, 100)
mc = MachineConfig(machine_type='Grbl', settings=Settings())
g = generate_gcode(paths, mc)
check('edge gcode generated', 'G21' in g and 'M3S1000' in g)
ipaths = parse_gcode(g)
check('gcode reimport paths', len(ipaths) >= 1)

print('== 4. gcode import roundtrip ==')
doc2 = TextDocument(page, load_font(psf_b), FontsSet(), settings=s,
                    rng=random.Random(1))
ents2 = doc2.entities('ROUND TRIP 42')
export_transform(ents2, page, s, machine_type='Grbl')
g2 = generate_gcode(ents2, mc)
re_paths = parse_gcode(g2)
print('   reimport paths: %d' % len(re_paths))
check('reimport entity count', len(re_paths) >= 15)
re_svg = pv.paths_to_svg(re_paths, 209, 296, flip_y=True)
open(os.path.join(TMP, 't_reimport.svg'), 'w', encoding='utf-8').write(re_svg)
check('reimport svg written', len(re_svg) > 1000)

print('== 5. dots gcode ==')
flat = [c for pt in zip([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]) for c in pt]
dg = generate_dots = None
from penplot.gcode import laser_dots_gcode
dg = laser_dots_gcode(flat, mc, powers=[1.0, 0.5, 0.25], dwell_s=[0.1, 0.05, 0])
check('dots power modulation', 'S1000' in dg and 'S500' in dg and 'S250' in dg)
check('dots dwell modulation', 'G4 P0.1' in dg and 'G4 P0.05' in dg)

print()
print('RESULT: %d pass, %d fail' % (ok, fail))
sys.exit(1 if fail else 0)
