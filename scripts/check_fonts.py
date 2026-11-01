# -*- coding: utf-8 -*-
"""Verify every font in the font directory loads and covers common hanzi.

usage: python scripts/check_fonts.py [FONT_DIR] [--source ORIGINAL_INSTALL_FONT_DIR]
  FONT_DIR defaults to $PENPLOT_FONT_DIR or <repo>/fonts. With --source,
  also report vendor fonts that are missing from FONT_DIR.
"""
import argparse
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)
from penplot.psf import load_dir  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('fontdir', nargs='?',
                default=os.environ.get('PENPLOT_FONT_DIR') or os.path.join(REPO, 'fonts'))
ap.add_argument('--source', help="original software's gcodeFonts directory")
args = ap.parse_args()
fd = args.fontdir

missing = set()
if args.source:
    src = args.source
    src_files = {f for f in os.listdir(src) if f.lower().endswith('.gfont')
                 and os.path.getsize(os.path.join(src, f)) > 1000}   # skip broken empties
    dst_files = {f for f in os.listdir(fd) if f.lower().endswith(('.gfont', '.psf'))}
    print('source fonts: %d, packaged: %d' % (len(src_files), len(dst_files)))
    missing = src_files - {f for f in dst_files if f.endswith('.gfont')}
    print('missing:', missing or 'NONE')

fonts = load_dir(fd)
print('loaded: %d fonts' % len(fonts))
total = 0
bad = []
for k, f in sorted(fonts.items()):
    # sanity: sample common chars
    have = sum(1 for ch in '的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感'[:80] if f.has_glyph(ch))
    total += f.glyph_count
    status = 'OK'
    if f.glyph_count == 0:
        status = 'EMPTY'
        bad.append(k)
    print('  %-46s glyphs=%-6d coverage=%2d/80 %s' % (k[:46], f.glyph_count, have, status))
KNOWN_EMPTY = {'ÕÅÉúµÄ×Ö'}   # 张生的字: ships empty in the original install (0 glyphs)
print('total glyphs: %d, bad fonts: %s' % (total, bad or 'none'))
sys.exit(1 if (missing or (set(bad) - KNOWN_EMPTY)) else 0)
