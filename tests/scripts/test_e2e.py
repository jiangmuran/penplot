# -*- coding: utf-8 -*-
"""End-to-end test: real font -> layout -> gcode -> preview."""
import os
import sys
import random

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import require_fonts, FONT_DIR, TTF_DIR, require  # noqa: E402
require_fonts('zy01.gfont')

FONTDIR = FONT_DIR

from penplot.gfont import load_dir
from penplot.layout import PageInfo, TextDocument, FontsSet, LineAlign, export_transform
from penplot.settings import MachineConfig, Settings
from penplot.gcode import generate_gcode
from penplot import preview as pv

fonts = load_dir(FONTDIR)
print('fonts loaded:', len(fonts))
font = fonts.get('zy01') or list(fonts.values())[0]
print('using:', font.filename, font.glyph_count, 'glyphs')

page = PageInfo(name='A4', pageWidth=209, pageHeight=296, leftGap=31.8, rightGap=31.8,
                topGap=25.4, bottomGap=25.4, lineNum=20)
s = Settings()
rng = random.Random(7)

doc = TextDocument(page, font, FontsSet(randomFontSize=[0.98, 1.02],
                                        randomRotate=[-1.5, 1.5],
                                        randomY=0.01),
                   settings=s, rng=rng, text_size=1.0)
text = '原软件深度重写测试\nThe quick brown fox 0123456789\n第二行中文排版测试，验证换行与标点。'
ents = doc.entities(text, align=LineAlign.LEFT)
print('entities:', len(ents))
bb = None
from penplot.geometry import bbox_of
bb = bbox_of(ents)
print('bbox px:', bb)

export_transform(ents, page, s)
bb2 = bbox_of(ents)
print('bbox mm :', bb2)

for t in ('Grbl', 'Marlin', 'K_AT', 'Ebb'):
    mc = MachineConfig(machine_type=t, settings=s)
    g = generate_gcode(ents, mc)
    out = 'test_out_%s.gcode' % t
    open(os.path.join(os.path.dirname(os.path.abspath(__file__)), out), 'w',
         encoding='utf-8', newline='').write(g)
    lines = g.split('\r\n')
    print('%-7s %6d lines, head: %r' % (t, len(lines), lines[1] if len(lines) > 1 else ''))

# SVG preview of the layout (Grbl coords)
mc = MachineConfig(machine_type='Grbl', settings=s)
ents2 = doc.entities(text, align=LineAlign.LEFT)
export_transform(ents2, page, s)
svg = pv.paths_to_svg(ents2, page.pageWidth, page.pageHeight, page=page, flip_y=True)
open('test_preview.svg', 'w', encoding='utf-8').write(svg)
print('svg written:', os.path.getsize('test_preview.svg'), 'bytes')
print('stats:', pv.stats(ents2))
print('E2E OK')
