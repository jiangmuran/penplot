# -*- coding: utf-8 -*-
"""Numeric verification of layout correctness."""
import os, sys, random
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import require_fonts, FONT_DIR, TTF_DIR, require  # noqa: E402
require_fonts('zy01.gfont')
from penplot.gfont import load_dir
from penplot.layout import PageInfo, TextDocument, FontsSet
from penplot.settings import Settings

fonts = load_dir(FONT_DIR)
font = fonts['zy01']

text = '原软件深度重写测试'
missing = [ch for ch in text if not font.has_glyph(ch)]
print('missing glyphs in zy01 for %r: %s' % (text, missing or 'none'))

f2 = None
for k in fonts:
    if k.startswith('方正兰亭') or '方正' in k:
        f2 = fonts[k]
        print('found rich font:', k, fonts[k].glyph_count)
        break
if f2:
    missing2 = [ch for ch in text if not f2.has_glyph(ch)]
    print('missing in that font: %s' % (missing2 or 'none'))

page = PageInfo(pageWidth=209, pageHeight=296, leftGap=31.8, rightGap=31.8,
                topGap=25.4, bottomGap=25.4, lineNum=20)
s = Settings()
use = f2 or font
doc = TextDocument(page, use, FontsSet(), settings=s, rng=random.Random(1), text_size=1.0)

pages = doc.layout('中奎国')
line_h = doc._line_h
print('line height px:', round(line_h, 2))
ents = doc.entities('中奎国')
for e in ents:
    b = e.bbox()
    print('  bbox x[%.1f..%.1f] y[%.1f..%.1f] h=%.1f' % (b[0], b[2], b[1], b[3], b[3] - b[1]))

z = font.glyph('中')
zs = z.coords
xs, ys = zs[0::2], zs[1::2]
print('glyph 中 raw: x[%.0f..%.0f] y[%.0f..%.0f] (font space)' % (min(xs), max(xs), min(ys), max(ys)))

t = '这是一个非常长的句子用来测试自动换行功能是否按照预期工作，包括标点符号不应出现在行首，还有很多很多字需要换行。'
pages = doc.layout(t)
widths = []
for pi, lines in enumerate(pages):
    print('page %d: %d lines' % (pi, len(lines)))
    for li, ln in enumerate(lines):
        if ln:
            w = sum(cb.step for cb in ln)
            widths.append(w)
print('line widths px:', [round(w) for w in widths])
content = doc._mm2px(209 - 31.8 * 2)
print('content width px:', round(content))
print('WRAP OK' if all(w <= content + line_h * 0.6 for w in widths) else 'WRAP FAIL')

# indent / disperse sanity
from penplot.layout import ParagraphFormat
p2 = PageInfo(pageWidth=209, pageHeight=296, leftGap=31.8, rightGap=31.8,
              topGap=25.4, bottomGap=25.4, lineNum=20)
doc2 = TextDocument(p2, use, FontsSet(), settings=s, rng=random.Random(1))
pages2 = doc2.layout('缩进段落测试：这是第一行，这里是第二行的内容，验证首行缩进与悬挂缩进的差别。',
                     ParagraphFormat(spe_type=1, spe_value=20.0))
print('indent layout: %d lines' % sum(len(l) for l in pages2))
firsts = [ln.first for p_ in pages2 for ln in p_]
print('line first flags:', firsts)

