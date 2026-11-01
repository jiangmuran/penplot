#!/usr/bin/env python3
"""Validate every seed template and write previews.

For each entry of seed/templates/index.json:
  1. parse the file with the backend's ProjectDoc schema (penplot.web.schemas),
  2. render it with penplot.compose.render_document (default variables,
     profile configs/grbl-zpen.json, fonts from fonts/),
  3. fail on render errors, missing glyphs, overflow or clipping,
  4. write previews/<id>.svg (page space) and previews/<id>.png.
Also checks seed/papers.json against PaperBase.

    .venv/bin/python seed/validate.py            # all
    .venv/bin/python seed/validate.py postcard   # some
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

from penplot.compose import Resolver, preview_svg, render_document  # noqa: E402
from penplot.web.printcfg import effective  # noqa: E402
from penplot.web.schemas.projects import PaperBase, ProjectDoc  # noqa: E402

FONT_DIR = os.path.join(ROOT, 'fonts')
PROFILE = os.path.join(ROOT, 'configs', 'grbl-zpen.json')
PREV = os.path.join(HERE, 'templates', 'previews')

# builtin papers (penplot.layout.page_presets) by id, as the backend seeds them
from penplot.layout import page_presets  # noqa: E402
_IDS = ['a4-normal', 'a4-narrow', 'a4-moderate', 'a4-wide', 'a3-normal', 'a3-narrow', 'a3-moderate',
        'a3-wide', '16k-normal', '16k-narrow', '16k-moderate', '16k-wide']
BUILTIN = {}
for pid, p in zip(_IDS, page_presets()):
    BUILTIN[pid] = {'name': p['name'], 'width_mm': p['pageWidth'], 'height_mm': p['pageHeight'],
                    'margins': {'l': p['leftGap'], 'r': p['rightGap'], 't': p['topGap'], 'b': p['bottomGap']},
                    'orientation': 'portrait', 'rotation': 0,
                    'ruling': {'line_num': p['lineNum'], 'line_gap': 0.0, 'line_gap_offset': 0.0, 'base_line': 1.0}}


def resolve_paper(ref, seeds):
    ref = ref or {'paper_id': 'a4-normal'}
    if ref.get('spec'):
        return dict(ref['spec'])
    pid = ref.get('paper_id') or 'a4-normal'
    if pid in BUILTIN:
        return BUILTIN[pid]
    if pid in seeds:
        return seeds[pid]
    raise SystemExit('unknown paper %s' % pid)


def png(paths, w, h, out, scale=4):
    from PIL import Image, ImageDraw
    W, H = int(w * scale), int(h * scale)
    im = Image.new('RGB', (W + 2, H + 2), 'white')
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W + 1, H + 1], outline=(200, 200, 200))
    for p in paths:
        for sp in p.subpaths():
            c = sp.coords
            pts = [(1 + c[i] * scale, 1 + c[i + 1] * scale) for i in range(0, len(c), 2)]
            if len(pts) > 1:
                d.line(pts, fill=(20, 40, 90), width=max(1, scale // 3))
    im.save(out, optimize=True)


def main(argv):
    fonts = {os.path.splitext(os.path.basename(f))[0]: f for f in glob.glob(os.path.join(FONT_DIR, '*'))
             if f.endswith(('.gfont', '.psf'))}
    with open(PROFILE, encoding='utf-8') as f:
        prof = json.load(f)
    with open(os.path.join(HERE, 'papers.json'), encoding='utf-8') as f:
        papers = json.load(f)
    seeds = {}
    for p in papers['papers']:
        body = {k: v for k, v in p.items() if k not in ('id', 'category', 'note')}
        PaperBase.model_validate(body)
        seeds[p['id']] = body
    print('papers.json: %d presets ok' % len(seeds))
    with open(os.path.join(HERE, 'templates', 'index.json'), encoding='utf-8') as f:
        index = json.load(f)['templates']
    os.makedirs(PREV, exist_ok=True)
    bad = 0
    for t in index:
        if argv and t['id'] not in argv:
            continue
        with open(os.path.join(HERE, 'templates', t['file']), encoding='utf-8') as f:
            raw = json.load(f)
        problems = []
        try:
            doc = ProjectDoc.model_validate(raw).model_dump(mode='json')
        except Exception as e:
            print('FAIL %-22s schema: %s' % (t['id'], e))
            bad += 1
            continue
        if doc['paper'].get('paper_id') and not doc['paper'].get('spec') and doc['paper']['paper_id'] not in BUILTIN:
            problems.append('paper %s is not builtin and has no inline spec' % doc['paper']['paper_id'])
        for v in t.get('variables') or []:
            if v not in {x['name'] for x in doc['variables']}:
                problems.append('index variable %s missing' % v)
        if t.get('sample_data') and not os.path.exists(os.path.join(HERE, t['sample_data'])):
            problems.append('sample %s missing' % t['sample_data'])
        page_papers = [resolve_paper(pg.get('paper') or doc['paper'], seeds) for pg in doc['pages']]
        mc, opts, origin = effective(prof, doc.get('print'), None)
        adir = os.path.join(HERE, 'assets')
        assets = {'asset:' + fn: os.path.join(adir, fn) for fn in os.listdir(adir)} if os.path.isdir(adir) else {}
        res = Resolver(fonts, assets, 'penplot-sans')
        try:
            pages = render_document(doc, page_papers, res, mc, origin=origin,
                                    work_area=(300.0, 300.0), opts=opts)
        except Exception as e:
            print('FAIL %-22s render: %r' % (t['id'], e))
            bad += 1
            continue
        for rp in pages:
            w = rp.warnings
            if w['missing_glyphs']:
                problems.append('page %d missing glyphs %s' % (rp.index, ''.join(w['missing_glyphs'])))
            if w['overflow']:
                problems.append('page %d text overflow' % rp.index)
            if w['clipped']:
                problems.append('page %d clipped (bbox %s)' % (rp.index, [round(v, 1) for v in rp.bbox]))
            if rp.out_of_work_area:
                problems.append('page %d out of work area' % rp.index)
            if not rp.page_paths:
                problems.append('page %d is empty' % rp.index)
        rp = pages[0]
        svg = preview_svg(rp.page_paths, rp.width_mm, rp.height_mm,
                          margins=page_papers[rp.source_page].get('margins'))
        with open(os.path.join(PREV, t['id'] + '.svg'), 'w', encoding='utf-8') as f:
            f.write(svg)
        png(rp.page_paths, rp.width_mm, rp.height_mm, os.path.join(PREV, t['id'] + '.png'))
        a = rp.analysis
        status = 'FAIL' if problems else 'ok  '
        bad += bool(problems)
        print('%s %-22s %d page(s) %5.0f×%-4.0f draw %6.0f mm  lifts %4d  est %4.0f s  %s' % (
            status, t['id'], len(pages), rp.width_mm, rp.height_mm, a.draw_mm, a.pen_lifts, a.est_s,
            '; '.join(problems)))
    if bad:
        print('%d template(s) failed' % bad)
        return 1
    print('all templates ok')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
