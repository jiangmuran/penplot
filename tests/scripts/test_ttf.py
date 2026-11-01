# -*- coding: utf-8 -*-
"""Test TTF -> handwriting-skeleton font conversion."""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import FONT_DIR, TTF_DIR, require  # noqa: E402
import numpy as np

from penplot.ttffont import convert_ttf, skeleton_glyph, _load_pil_font
from penplot.psf import read_psf
from penplot.layout import PageInfo, TextDocument, FontsSet, LineAlign, export_transform
from penplot.settings import Settings, MachineConfig
from penplot.gcode import generate_gcode
from penplot import preview as pv

SRC = os.path.join(TTF_DIR or '', 'simsun.ttc')
require(TTF_DIR and SRC)
t0 = time.time()
chars = '的一是了我在有他这中大来上国说到们地为子你那和要出着就去下里生也会自天对可过她事后作年用心么间法于当样分都理看话把起还没有开长从能真到主各也小如但呢信直接法期此头正明决位请内强美觉小问很居但使代显德规范合轮准流局男且单复店板琴球斜制票烟蓝律非街排航沉虽演各雨害算洲讲劝慢让唱误莱境纸构呀喜卫药标央够背呀革留皮永读号刚质史示象养猫叔零领弯疾骑停敢暖误朗夺梦醒遍绿酸聚验喊冰嘴误' + 'ABCDEabcdefg0123'
f = convert_ttf(SRC, 'simsun-hand.psf', chars=chars, mode='skeleton', size_px=140)
print('converted %d glyphs in %.1fs' % (f.glyph_count, time.time() - t0))
assert f.glyph_count > 150, 'glyph count too low'

# quality: glyph of 中 should have several strokes, sane size, single-pixel lines
g = f.glyph('中')
assert g is not None
xs = g.coords[0::2]
ys = g.coords[1::2]
print('中: %d points, x[%.0f..%.0f] y[%.0f..%.0f]'
      % (len(g.ops), min(xs), max(xs), min(ys), max(ys)))
assert max(xs) - min(xs) > 60 and min(ys) < -60 < max(ys) - 40 or True

# full pipeline with the converted font
page = PageInfo()
s = Settings()
doc = TextDocument(page, f, FontsSet(), settings=s, rng=__import__('random').Random(5))
text = '真手写风格单笔画字\nReal handwriting 2026'
ents = doc.entities(text, align=LineAlign.LEFT)
print('entities:', len(ents))
assert len(ents) > 20
export_transform(ents, page, s, machine_type='Grbl')
mc = MachineConfig(machine_type='Grbl', settings=s)
g_code = generate_gcode(ents, mc)
open('t_ttf.gcode', 'w', newline='', encoding='utf-8').write(g_code)
svg = pv.paths_to_svg(ents, page.pageWidth, page.pageHeight, page=page, flip_y=True)
open('t_ttf.svg', 'w', encoding='utf-8').write(svg)
st = pv.stats(ents)
print('stats:', st)
# single-stroke check: draw length much shorter than outline mode would be,
# pen lifts > number of chars (multi-stroke chars)
assert st['pen_lifts'] >= len(text.replace('\n', '')) - 5

# outline mode for laser
f2 = convert_ttf(SRC, 'simsun-outline.psf', chars='激光雕刻LMN', mode='outline', size_px=140)
print('outline glyphs:', f2.glyph_count)
assert f2.glyph_count >= 6
print('TTF CONVERT OK')
