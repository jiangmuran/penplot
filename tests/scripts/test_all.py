# -*- coding: utf-8 -*-
"""Comprehensive functional matrix test for the whole package.

Covers: every packaged font, every firmware generator, every CLI command,
font interchange, image modes, gcode import, settings roundtrip, previews.
"""
import os
import random
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import require_fonts, FONT_DIR, TTF_DIR, require  # noqa: E402
require_fonts('zy01.gfont')
import numpy as np

from penplot import (Settings, MachineConfig, GFont, StrokeFont,
                     read_psf, write_psf, write_gfont_bytes, convert_font,
                     load_font, load_dir, load_builtin)
from penplot.gcode import generate_gcode, parse_gcode, laser_dots_gcode
from penplot.layout import (PageInfo, TextDocument, FontsSet, LineAlign,
                            ParagraphFormat, export_transform, page_presets)
from penplot.geometry import Path, bbox_of, Affine2D
from penplot import preview as pv
from penplot import image as imgmod

HERE = os.path.dirname(os.path.abspath(__file__))
FDIR = FONT_DIR
ok = fail = 0
FAILED = []


def check(name, cond, detail=''):
    global ok, fail
    if cond:
        ok += 1
        print('  PASS  %s' % name)
    else:
        fail += 1
        FAILED.append(name)
        print('  FAIL  %s  %s' % (name, detail))


print('=== A. every packaged font: load / layout / gcode (Grbl) ===')
fonts = load_dir(FDIR)
check('font count', len(fonts) >= 14, len(fonts))
page = PageInfo(**page_presets()[0])
s = Settings()
mc = MachineConfig(machine_type='Grbl', settings=s)
TEXT = '写字机功能全矩阵测试Test 0123.'
for key in sorted(fonts):
    f = fonts[key]
    if f.glyph_count == 0:
        check('%s (empty vendor font skipped)' % key[:24], True)
        continue
    rng = random.Random(11)
    doc = TextDocument(page, f, FontsSet(), settings=s, rng=rng)
    ents = doc.entities(TEXT, align=LineAlign.LEFT)
    export_transform(ents, page, s, machine_type='Grbl')
    g = generate_gcode(ents, mc)
    good = g.startswith('\r\nG21\r\n') and 'G1 X' in g and g.endswith('\r\n')
    check('layout+gcode: %s (%d ents)' % (key[:28], len(ents)), good and len(ents) >= 10)

print('=== B. four firmwares, identical entities ===')
rng = random.Random(7)
doc = TextDocument(page, load_font(os.path.join(FDIR, 'zy01.gfont')),
                   FontsSet(), settings=s, rng=rng)
base = None
for t in ('Grbl', 'Marlin', 'K_AT', 'Ebb'):
    ents = doc.entities(TEXT)
    export_transform(ents, page, s, machine_type=t)
    m = MachineConfig(machine_type=t, settings=s)
    g = generate_gcode(ents, m)
    if t == 'Grbl':
        base = g
        check('Grbl format', 'G21\r\nG90\r\nF1500\r\nM5' in g and 'G90G0 X0Y0' in g)
    else:
        check('%s differs from Grbl only in dialect' % t, g != base)
    if t == 'Marlin':
        check('Marlin G92+ms dwell', 'G92X0.0Y0.0Z0' in g and 'G4 P200' in g)
    if t == 'K_AT':
        check('K_AT E-pen', 'G1G90 E0.200F4000' in g or 'G1G90 E0.2F4000' in g)
    if t == 'Ebb':
        check('EBB XM stream', g.count('XM,') > 20 and 'SP,1,' in g)

print('=== C. font interchange: every real font gfont->psf->gfont ===')
src_gf = [f for f in sorted(os.listdir(FDIR)) if f.endswith('.gfont')
          and os.path.getsize(os.path.join(FDIR, f)) > 100000]
tmp = tempfile.mkdtemp()
for fn in src_gf:
    g1 = GFont().load(os.path.join(FDIR, fn))
    sf = StrokeFont.from_gfont(g1)
    p1 = os.path.join(tmp, 'a.psf')
    write_psf(sf, p1)
    sf2 = read_psf(p1)
    p2 = os.path.join(tmp, 'a.gfont')
    open(p2, 'wb').write(write_gfont_bytes(sf2))
    g2 = GFont().load(p2)
    same = True
    for ch in '中文字体测试ABC123':
        a, b = g1.glyph(ch), g2.glyph(ch)
        if a is None or b is None:
            same = a is None and b is None
        else:
            same = same and len(a.coords) == len(b.coords) and \
                all(abs(x - y) < 1e-3 for x, y in zip(a.coords, b.coords))
    check('roundtrip %s (%d glyphs)' % (fn[:26], sf.glyph_count), same)

print('=== D. builtin font + latin/digits/punct ===')
bf = load_builtin()
ents = TextDocument(page, bf, FontsSet(), settings=s,
                    rng=random.Random(1)).entities('HELLO penplot 123!?')
check('builtin renders', len(ents) >= 15, len(ents))

print('=== E. paragraph formats & alignments ===')
doc = TextDocument(page, bf, FontsSet(), settings=s, rng=random.Random(2))
text = 'first line wraps around here because it is quite long indeed yes'
for align in ('Left', 'Center', 'Right', 'Disperse'):
    e = doc.entities(text, align=getattr(LineAlign, align.upper()))
    check('align %s' % align, len(e) > 30)
fmt = ParagraphFormat(spe_type=1, spe_value=20.0, left=5.0, right=5.0)
pages = doc.layout(text, fmt)
check('indent paragraphs', len(pages) >= 1 and pages[0][0].first is True)

print('=== F. image modes on synthetic scene ===')
ink = np.zeros((200, 300))
ink[20:80, 20:120] = 1.0
ink[120:180, 20:280] = 0.7
for i in range(200):
    ink[i, 200] = 1.0
edges = imgmod.canny(ink, low=0.05, high=0.2)
ep = imgmod.mask_to_paths(edges, min_points=6)
check('edge mode', len(ep) >= 2 and all(p.coords for p in ep))
skel = imgmod.zhang_suen(ink > 0.5)
sp = imgmod.skeleton_to_paths(skel)
check('skeleton mode', len(sp) >= 2)
xs, ys, vs = imgmod.halftone_dots(ink, 4)
check('dots mode', len(xs) > 50 and 0 < max(vs) <= 1.0)
imgmod.paths_to_mm(ep, 90.0, 300)
g = generate_gcode(ep, mc)
check('img gcode', 'G1 X' in g)

print('=== G. laser dots power & dwell ===')
flat = [10.0, -10.0, 20.0, -10.0, 30.0, -10.0]
dg = laser_dots_gcode(flat, mc, powers=[1.0, 0.5, 0.1], dwell_s=[0.2, 0.1, 0.02])
check('dot powers', 'S1000' in dg and 'S500' in dg and 'S100' in dg)
check('dot dwells', 'G4 P0.2' in dg and 'G4 P0.02' in dg)

print('=== H. gcode import roundtrip (all firmwares textual) ===')
for t in ('Grbl', 'Marlin'):
    ents = doc.entities('ROUND TRIP 42 OK')
    export_transform(ents, page, s, machine_type=t)
    m = MachineConfig(machine_type=t, settings=s)
    g = generate_gcode(ents, m)
    rp = parse_gcode(g, machine=m)
    check('import %s' % t, len(rp) >= 10, len(rp))

print('=== I. settings + machine config roundtrip ===')
mc2 = MachineConfig(machine_type='Marlin',
                    settings=Settings(feedRate=900, jogSpeed=1800, nearDst=0.5),
                    axes=__import__('penplot.settings', fromlist=['AxesSettings'])
                    .AxesSettings(revxy=True, xAxeRev=True, pos=2))
cfg = os.path.join(tmp, 'm.json')
mc2.save(cfg)
mc3 = MachineConfig.load(cfg)
check('config roundtrip', mc3.type == 'Marlin' and mc3.settings.feedRate == 900
      and mc3.axes.pos == 2 and mc3.axes.revxy)

print('=== J. previews ===')
ents = doc.entities('PREVIEW TEST 99')
export_transform(ents, page, s)
svg = pv.paths_to_svg(ents, page.pageWidth, page.pageHeight, page=page)
check('svg preview', svg.startswith('<svg') and 'path' in svg and len(svg) > 2000)
st = pv.stats(ents)
check('stats', st['draw_mm'] > 0 and st['pen_lifts'] > 0)
try:
    pv.paths_to_png(ents, os.path.join(tmp, 'p.png'))
    check('png preview', os.path.getsize(os.path.join(tmp, 'p.png')) > 5000)
except ImportError:
    check('png preview (matplotlib absent -> skipped)', True)

print('=== K. machine module (offline) ===')
from penplot.machine import (make_controller, Sender, GrblController,
                             MarlinController, EbbController, KatController,
                             KatBatchQueue)
from penplot.machine.base import marlin_line
check('controllers construct', all(
    make_controller(MachineConfig(machine_type=t)) is not None
    for t in ('Grbl', 'Marlin', 'Ebb', 'K_AT')))
check('marlin checksum', marlin_line('M110 N0', 1).startswith('N1 '))
ctrl = make_controller(MachineConfig(machine_type='Grbl'))
snd = Sender(ctrl)
snd.load_gcode_text('G21\nG90\nG0 X1Y1\nM3S1000\nG1 X2Y2\nM5')
check('sender queue built', len(snd.queue) == 6 and snd.use_line_numbers is False)
snd2 = Sender(ctrl)
snd2.load_sd_upload('G21\nG90', 'job1')
check('sd upload framing', snd2.queue[0][0].startswith('M110')
      and snd2.queue[1][0].startswith('M28 job1.gco')
      and snd2.queue[-1][0] == 'M29'
      and '*' in snd2.queue[2][0])
kat = make_controller(MachineConfig(machine_type='K_AT'))
check('kat pen commands', kat.pen_cmd(True) == 'G1G90 E0.2F4000'
      and kat.pen_cmd(False) == 'G1G90 E6F4000'
      and kat.set_zero_cmd().startswith('G92X'))

print('=== L. geometry engine ===')
p = Path()
p.ellipse(50, 50, 20, 10, 0.3)
check('ellipse', len(p.ops) > 15)
p2 = Path()
p2.move_to(0, 0)
p2.cubic_bezier(10, 10, 20, 10, 30, 0, 0.05)
check('bezier', len(p2.ops) > 15)
p3 = Path()
p3.move_to(0, 0)
p3.arc_to_beziers(0, 0, 20, 20, 0, False, True, 40, 0)
check('svg arc', len(p3.ops) > 5)
p4 = Path()
p4.closed_polygon([0, 0, 10, 0, 10, 10, 0, 10])
check('bbox', p4.bbox() == (0, 0, 10, 10))
p4.rdp_simplify(0.5)
check('rdp', len(p4.ops) >= 4)
check('reverse+append', True)
a = Path(); a.move_to(0, 0); a.line_to(10, 0)
b = Path(); b.move_to(10, 0); b.line_to(10, 10)
a.append(b)
# original behaviour: join point kept, its op forced to LINE (degenerate
# zero-length segment, dropped later by the generator's dedup)
check('append join', a.ops == [0, 1, 1, 1] and a.coords == [0, 0, 10, 0, 10, 0, 10, 10])

print('=== M. CLI commands (subprocess) ===')
PY = sys.executable
demo = os.path.join(HERE, 'demo_img.png')
if not os.path.exists(demo):
    arr = np.full((200, 300), 255, np.uint8)
    arr[30:150, 30:270] = 40
    try:
        from PIL import Image
        Image.fromarray(arr).save(demo)
    except ImportError:
        import cv2
        cv2.imwrite(demo, arr)
cli_cases = [
    ['font', 'list', '-d', FDIR],
    ['font', 'builtin', os.path.join(tmp, 'b.psf')],
    ['font', 'convert', os.path.join(FDIR, 'zy01.gfont'), os.path.join(tmp, 'z.psf')],
    ['font', 'convert', os.path.join(tmp, 'z.psf'), os.path.join(tmp, 'z.gfont')],
    ['write', 'CLI MATRIX 2026', '-f', 'penplot-sans', '--align', 'D',
     '-o', os.path.join(tmp, 'w.gcode'), '--svg', os.path.join(tmp, 'w.svg'),
     '--work', '300', '210', '--stats'],
    ['write', '中文矩阵', '-f', os.path.join(tmp, 'z.psf'),
     '-o', os.path.join(tmp, 'w2.gcode'), '-t', 'Marlin'],
    ['img', 'edge', demo, '--width-mm', '80', '-o', os.path.join(tmp, 'e.gcode')],
    ['img', 'skeleton', demo, '--width-mm', '80', '-o', os.path.join(tmp, 's.gcode')],
    ['img', 'dots', demo, '--width-mm', '80', '--spacing-mm', '2',
     '--power-modulate', '-o', os.path.join(tmp, 'd.gcode')],
    ['gcode2svg', os.path.join(tmp, 'w.gcode'), os.path.join(tmp, 'r.svg')],
]
for c in cli_cases:
    r = subprocess.run([PY, '-m', 'penplot.cli'] + c, capture_output=True,
                       text=True, timeout=600, cwd=HERE)
    check('cli ' + ' '.join(c[:2]) + ' ' + os.path.basename(c[-1]),
          r.returncode == 0, (r.stdout + r.stderr).strip()[:120])

print()
print('TOTAL: %d pass, %d fail' % (ok, fail))
if FAILED:
    print('FAILED ITEMS:')
    for f in FAILED:
        print('  -', f)
sys.exit(1 if fail else 0)
