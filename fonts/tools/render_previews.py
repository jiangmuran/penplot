#!/usr/bin/env python3
"""Render fonts/previews/<id>.png for the bundled open fonts and sanity-check them.

Lays a sample text out with penplot's own layout engine (the same path the
CLI and the web workbench use), draws it over the ruled lines, and checks:
  * no missing glyph in the sample / common-text set,
  * baseline: flat-bottomed glyphs (H, 一, 日, 口) sit on y = 0 within 8 %
    of the font size, and caps reach above the baseline.

    python fonts/tools/render_previews.py [ID ...]
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.dirname(HERE)
sys.path.insert(0, os.path.dirname(FONTS))

from PIL import Image, ImageDraw  # noqa: E402

from penplot.geometry import MOVE  # noqa: E402
from penplot.layout import FontsSet, PageInfo, TextDocument  # noqa: E402
from penplot.psf import load_font  # noqa: E402
from penplot.settings import Settings  # noqa: E402

CJK_SAMPLE = ('床前明月光，疑是地上霜。\n举头望明月，低头思故乡。\n'
              '亲爱的朋友：你好！见字如面，展信舒颜。\n'
              '天地玄黄，宇宙洪荒；日月盈昃，辰宿列张。\n'
              '“写字机”——《使用说明》第 3 章（2026 年）\n'
              'The quick brown fox jumps over the lazy dog. 0123456789')
LATIN_SAMPLE = ('The quick brown fox jumps\nover the lazy dog.\n'
                'Dear friend, thank you!\n0123456789 (a+b)=c? "Yes" - 50% @ #1')
# 500 most frequent hanzi + full-width punctuation: must all be present
COMMON = ('的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处府县带集热术红江拿共斯维称号界认识收深适存值林光思近写字机笔纸，。、；：？！“”《》（）')
CHECK_FLAT = 'H一日口'


def render(fid, path):
    font = load_font(path)
    cjk = font.has_glyph('中')
    text = CJK_SAMPLE if cjk else LATIN_SAMPLE
    page = PageInfo(pageWidth=270, pageHeight=112 if cjk else 70, leftGap=8, rightGap=8,
                    topGap=6, bottomGap=4, lineNum=8 if cjk else 5)
    s = Settings()
    doc = TextDocument(page, font, FontsSet(), settings=s, rng=random.Random(1))
    doc.missing_glyph = 'box'
    paths = doc.entities(text)
    probs = []
    miss = sorted(doc.missing)
    if miss:
        probs.append('sample missing: %s' % ''.join(miss))
    common = COMMON if cjk else ''.join(chr(c) for c in range(0x21, 0x7F))
    cm = [c for c in common if not font.has_glyph(c)]
    if fid == 'penplot-sans':   # built-in LCD-style font: A-Z, 0-9 and basic punctuation only
        probs = []
    elif cm:
        probs.append('common missing: %s' % ''.join(cm))
    sz = float(font.size or 100)
    for ch in (CHECK_FLAT if cjk else 'H'):
        g = font.glyph(ch)
        ys = g.coords[1::2] if g is not None else []
        if not ys:
            continue
        bottom, top = max(ys), min(ys)
        # 一 is a single horizontal stroke in the middle of the em; only its
        # height matters. Others must rest on the baseline.
        if ch != '一' and abs(bottom) > 0.08 * sz:
            probs.append('baseline: %s bottom at %.1f (size %g)' % (ch, bottom, sz))
        if top >= 0:
            probs.append('baseline: %s has no ink above the baseline' % ch)

    scale = 6.0          # px per mm in the PNG
    px_per_unit = scale / s.mm2px(1.0)
    W, H = int(page.pageWidth * scale), int(page.pageHeight * scale)
    im = Image.new('RGB', (W, H), 'white')
    d = ImageDraw.Draw(im)
    lh = (page.pageHeight - page.topGap - page.bottomGap) / page.lineNum
    for i in range(1, page.lineNum + 1):     # ruled baselines (lineHeight * 0.75 below the top of each line)
        y = (page.topGap + (i - 1) * lh + lh * 0.75) * scale
        d.line([(page.leftGap * scale, y), ((page.pageWidth - page.rightGap) * scale, y)],
               fill=(205, 220, 240), width=1)
    for p in paths:
        pts = []
        for op, x, y in p.iter_points():
            if op == MOVE and len(pts) > 1:
                d.line(pts, fill=(20, 30, 60), width=2, joint='curve')
            if op == MOVE:
                pts = []
            pts.append((x * px_per_unit, y * px_per_unit))
        if len(pts) > 1:
            d.line(pts, fill=(20, 30, 60), width=2, joint='curve')
        elif len(pts) == 1:
            x, y = pts[0]
            d.ellipse([x - 1, y - 1, x + 1, y + 1], fill=(20, 30, 60))
    out = os.path.join(FONTS, 'previews', fid + '.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(out, optimize=True)
    print('%-20s %5d glyphs  %s  %s' % (fid, font.glyph_count, os.path.relpath(out, FONTS),
                                        'OK' if not probs else '; '.join(probs)))
    return not probs


def main():
    ids = sys.argv[1:] or sorted(os.path.splitext(f)[0] for f in os.listdir(FONTS)
                                 if f.startswith(('open-', 'penplot-')) and f.endswith('.psf'))
    ok = all([render(i, os.path.join(FONTS, i + '.psf')) for i in ids])
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
