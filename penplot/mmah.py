# -*- coding: utf-8 -*-
"""Make Me a Hanzi stroke data -> PSF font converter.

Data source: https://github.com/skishore/makemeahanzi (graphics.txt)
9,300+ hanzi, each with REAL stroke medians - correct stroke count,
stroke ORDER and writing DIRECTION per stroke. This is exactly what a
writing machine wants; the TTF-skeleton pipeline stays for characters
the dataset does not cover and for non-CJK scripts.

LICENSING: the medians derive from the AR PL KaitiM GB font outlines,
redistributed under the Arphic Public License. Keep this notice and the
license text when redistributing converted fonts
(https://raw.githubusercontent.com/arphic/ ... /LICENSE Arphic PL).

Coordinate system: x in [0,1024]; y grows DOWNWARD with the glyph body
around y in [0,900] (baseline near the bottom of most hanzi). We shift
by a per-font baseline estimated as the median glyph bottom so that
converted glyphs follow the PSF convention (y down, baseline = 0).

Usage:
    python3 -m penplot.cli font mmah graphics.txt makemeahanzi.psf
"""
import json
import statistics

from .psf import StrokeFont, StrokeGlyph, write_psf
from .geometry import Path

EM = 1024.0


def _iter_graphics(path):
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if 'character' in rec and 'medians' in rec:
                yield rec


def convert_mmah(graphics_path, out_psf=None, baseline=None, name=None,
                 max_chars=None):
    """graphics.txt -> .psf (one stroke per pen path, real pen order)."""
    records = _iter_graphics(graphics_path)
    recs = []
    for rec in records:
        recs.append(rec)
        if max_chars and len(recs) >= max_chars:
            break
    if not recs:
        raise ValueError('no records parsed from %s' % graphics_path)

    # baseline: median of per-glyph bottoms (most hanzi sit ON the baseline)
    if baseline is None:
        bottoms = []
        for rec in recs:
            ys = [pt[1] for med in rec['medians'] for pt in med]
            if ys:
                bottoms.append(max(ys))
        baseline = statistics.median(bottoms) if bottoms else 900.0

    sf = StrokeFont()
    sf.name = name or 'makemeahanzi-kai'
    sf.family = 'AR PL KaitiM GB (medians)'
    sf.author = 'skishore/makemeahanzi (Arphic Public License)'
    sf.size = EM
    sf.type_ordinal = 0

    for rec in recs:
        ch = rec['character']
        p = Path()
        for med in rec['medians']:          # already in writing order
            if len(med) < 2:
                continue
            p.move_to(med[0][0], med[0][1] - baseline)
            for pt in med[1:]:
                p.line_to(pt[0], pt[1] - baseline)
        sf.glyphs[ord(ch)] = StrokeGlyph(ord(ch), p.coords, p.ops,
                                         advance=EM)   # hanzi: full-width
    if out_psf is None:
        out_psf = 'makemeahanzi.psf'
    write_psf(sf, out_psf)
    return sf
