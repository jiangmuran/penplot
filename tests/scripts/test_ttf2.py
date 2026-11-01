# -*- coding: utf-8 -*-
"""Round-4 fixes: external review bugs + stroke-extraction algorithm."""
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import FONT_DIR, TTF_DIR, require  # noqa: E402
import numpy as np

from penplot.ttffont import (default_charset, gb2312_symbols, _load_pil_font,
                             _load_cmap, render_ink, skeleton_glyph,
                             outline_glyph, convert_ttf)
from penplot.psf import StrokeFont, StrokeGlyph, read_psf, write_psf
from penplot.geometry import Path
from penplot.layout import PageInfo, TextDocument, FontsSet, LineAlign
from penplot.settings import Settings
from penplot import image as imgmod
from penplot.strokes import skeleton_strokes, estimate_stroke_width, orient_and_order

ok = fail = 0


def check(name, cond, detail=''):
    global ok, fail
    if cond:
        ok += 1
        print('  PASS  %s' % name)
    else:
        fail += 1
        print('  FAIL  %s  %s' % (name, detail))


F = TTF_DIR or ''
msyh = os.path.join(F, 'msyh.ttc')
simsun = os.path.join(F, 'simsun.ttc')
arial = os.path.join(F, 'arial.ttf')
require(TTF_DIR and msyh, simsun, arial)


def _segments(g):
    segs = []
    cur = []
    for i, op in enumerate(g.ops):
        pt = (g.coords[i * 2], g.coords[i * 2 + 1])
        if op == 0:
            if cur:
                segs.append(cur)
            cur = [pt]
        else:
            cur.append(pt)
    if cur:
        segs.append(cur)
    return segs


def _glyph_bbox(g):
    xs = g.coords[0::2]
    ys = g.coords[1::2]
    return (min(xs), min(ys), max(xs), max(ys))


def _close_bbox(a, b, tol=1.0):
    return all(abs(x - y) < tol for x, y in zip(a, b))

print('== BUG1 cmap filter: no .notdef tofu ==')
cs = default_charset()
f160 = _load_pil_font(arial, 160)
# render 永 with arial -> tofu box (~3500 ink px); with filter it is skipped
ink_tofu, _, _ = render_ink(f160, '永')
check('arial renders tofu for 永 (precondition)',
      ink_tofu is not None and (ink_tofu > 0.5).sum() > 800,
      (ink_tofu > 0.5).sum() if ink_tofu is not None else None)
cm = _load_cmap(arial, 0)
filtered = [c for c in cs if ord(c) in cm]
check('cmap filter drops all CJK from arial', '永' not in filtered and
      'a' in filtered and len(filtered) < 200, len(filtered))
sf = convert_ttf(arial, 't_arial.psf', chars='永ABC', mode='skeleton',
                 size_px=140)
check('no tofu glyph in converted font',
      sf.has_glyph('A') and not sf.has_glyph('永'),
      sorted(chr(k) for k in sf.glyphs))
gg = sf.glyph('A')
check('converted glyph is not a rectangle box',
      gg is None or len(gg.ops) <= 30, len(gg.ops) if gg else None)

print('== BUG2 advance widths + space preserved ==')
sf2 = convert_ttf(arial, 't_adv.psf', chars='i m W . ', mode='skeleton',
                  size_px=140)
sp = sf2.glyphs.get(0x20)
check('space glyph exists (advance-only)',
      sp is not None and sp.advance and not sp.ops,
      (sp.advance if sp else None))
adv_i = sf2.glyph('i').advance
adv_m = sf2.glyph('m').advance
check('proportional advances i < m', adv_i and adv_m and adv_i < adv_m * 0.6,
      (adv_i, adv_m))
# psf roundtrip keeps advance
sf3 = read_psf('t_adv.psf')
check('psf roundtrip keeps advance',
      sf3.glyphs[0x20].advance == sf2.glyphs[0x20].advance and
      sf3.glyph('m').advance == adv_m)
# layout uses stored advance for space (no 0.3*h guess)
s = Settings()
doc = TextDocument(PageInfo(), sf3, FontsSet(), settings=s, rng=random.Random(1))
pages = doc.layout('i m')
space_box = pages[0][0].chars[1]
check('layout uses stored space advance',
      abs(space_box.adv - sf3.glyphs[0x20].advance * (doc._line_h / sf3.size)) < 0.5,
      (space_box.adv, sf3.glyphs[0x20].advance))

print('== BUG3 full-width punctuation in default charset ==')
check('，。、；：？！《》in charset',
      all(c in cs for c in '，。、；：？！《》（）【】'))
check('symbol rows count', 100 < len(gb2312_symbols()) < 290,
      len(gb2312_symbols()))

print('== BUG4 per-component dots ==')
f140 = _load_pil_font(arial, 140)
for ch, want in ((':', 2), ('i', 2), ('!', 2), (';', 2)):
    g, adv = skeleton_glyph(f140, ch)
    n = sum(1 for op in g.ops if op == 0) if g else 0
    check('dots kept: %s -> %d strokes' % (ch, want), n == want, n)
# robustness at a smaller size (the reviewer's parameter-sensitivity case)
f100 = _load_pil_font(arial, 100)
g, _ = skeleton_glyph(f100, 'i')
n = sum(1 for op in g.ops if op == 0) if g else 0
check('dot survives at 100px too', n == 2, n)

print('== BUG5 canvas / face / errors ==')
ink_c, by, x0 = render_ink(f140, '中')
ys, xs = np.nonzero(ink_c > 0.5)
check('ink not clipped at canvas edges',
      ys.min() > 3 and ys.max() < ink_c.shape[0] - 4 and
      xs.min() > 3 and xs.max() < ink_c.shape[1] - 4,
      (ys.min(), ys.max(), ink_c.shape))
try:
    _load_pil_font(os.path.join(F, 'simsun.ttc'), 140, face_index=99)
    check('strict face loading raises', False)
except IOError:
    check('strict face loading raises', True)

print('== A. junction-joined stroke counts (msyh) ==')
f160m = _load_pil_font(msyh, 160)
CASES = {'十': (2, 3), '国': (7, 9), '永': (5, 11), '我': (7, 13)}
for ch, (want, tol_max) in CASES.items():
    g, adv = skeleton_glyph(f160m, ch)
    n = sum(1 for op in g.ops if op == 0) if g else 0
    check('%s strokes=%d (want %d, <=%d)' % (ch, n, want, tol_max),
          want <= n <= tol_max, n)

print('== B. stroke direction & order ==')
g, _ = skeleton_glyph(f160m, '三')
segs = _segments(g)
check('三 = 3 horizontals', len(segs) == 3, len(segs))
check('all horizontals left->right',
      all(s[0][0] <= s[-1][0] for s in segs))
check('order top->bottom',
      [s[0][1] for s in segs] == sorted(s[0][1] for s in segs),
      [s[0][1] for s in segs])
g_v, _ = skeleton_glyph(f160m, '川')
segs_v = _segments(g_v)
check('川 verticals top->bottom',
      all(s[0][1] <= s[-1][1] + 1e-9 for s in segs_v), len(segs_v))

print('== C. adaptive thresholds ==')
for size in (100, 160, 220):
    fz = _load_pil_font(msyh, size)
    ink_z, _, _ = render_ink(fz, '中')
    w = estimate_stroke_width(ink_z)
    check('width scales with size (%dpx -> %.1f)' % (size, w),
          size * 0.05 < w < size * 0.15, w)

print('== D. vector outline mode ==')
sf_o = convert_ttf(msyh, 't_out.psf', chars='中O', mode='outline',
                   size_px=140, face_index=0)
g_o = sf_o.glyph('中')
check('outline has multiple closed contours',
      g_o is not None and sum(1 for op in g_o.ops if op == 0) >= 2,
      sum(1 for op in g_o.ops if op == 0) if g_o else None)
bb1 = _glyph_bbox(sf_o.glyph('O'))
sf_o2 = convert_ttf(msyh, 't_out2.psf', chars='O', mode='outline',
                    size_px=280, face_index=0)
# outline is resolution-independent: same font units regardless of size_px
check('vector outline resolution-independent',
      _close_bbox(bb1, _glyph_bbox(sf_o2.glyph('O'))),
      (bb1, _glyph_bbox(sf_o2.glyph('O'))))

print('== E. makemeahanzi loader ==')
from penplot.mmah import convert_mmah
fixture = os.path.join(os.path.dirname(os.path.abspath(__file__)), 't_mmah_fixture.txt')
with open(fixture, 'w', encoding='utf-8') as fh:
    fh.write(json.dumps({'character': '十', 'strokes': [],
                         'medians': [[[100, 900], [900, 900]],
                                     [[500, 100], [500, 900]]]}) + '\n')
    fh.write(json.dumps({'character': '一', 'strokes': [],
                         'medians': [[[100, 600], [900, 600]]]}) + '\n')
sfm = convert_mmah(fixture, 't_mmah.psf')
g10 = sfm.glyph('十')
check('mmah stroke count exact', g10 is not None and
      sum(1 for op in g10.ops if op == 0) == 2)
segs10 = _segments(g10)
check('mmah directions preserved',
      segs10[0][0][0] < segs10[0][-1][0] and        # 横: left->right
      segs10[1][0][1] < segs10[1][-1][1])           # 竖: top->bottom
# baseline = median bottom (900,600 -> 750); 一 bottom = 600-750 = -150
gy = sfm.glyph('一')
check('mmah baseline shift applied',
      abs(max(gy.coords[1::2]) + 150.0) < 1e-6, max(gy.coords[1::2]))

print()
print('RESULT: %d pass, %d fail' % (ok, fail))
sys.exit(1 if fail else 0)
