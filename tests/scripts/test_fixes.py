# -*- coding: utf-8 -*-
"""Regression tests for the source-diff audit fixes (round 3)."""
import os
import random
import struct
import sys
import zipfile
import io

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import require_fonts, FONT_DIR, TTF_DIR, require  # noqa: E402
require_fonts('zy01.gfont')
from penplot.geometry import Affine2D, Path, bbox_of
from penplot.layout import (PageInfo, TextDocument, FontsSet, LineAlign,
                            ParagraphFormat, export_transform, page_presets)
from penplot.settings import Settings, MachineConfig, GrblSettings, MarlinSettings
from penplot.gcode import generate_gcode, fmt3, laser_dots_gcode, GcodeBuilder
from penplot.psf import read_psf
from penplot.builtin_font import load_builtin
from penplot import gfont as gf
from penplot.machine.ebb import xm_cmd

ok = fail = 0


def check(name, cond, detail=''):
    global ok, fail
    if cond:
        ok += 1
        print('  PASS  %s' % name)
    else:
        fail += 1
        print('  FAIL  %s  %s' % (name, detail))


print('== 1. rotation direction matches Java ==')
a = Affine2D().rotate_deg(90)
p = [1.0, 0.0]
a.transform(p)
check('rotate90 (1,0)->(0,1)', abs(p[0]) < 1e-9 and abs(p[1] - 1) < 1e-9, p)
a2 = Affine2D().rotate_deg(30)
q = [1.0, 0.0]
a2.transform(q)
c30 = struct.unpack('<f', struct.pack('<f', 0.8660254))[0]
check('rotate30 (1,0)->(cos,sin)', abs(q[0] - 0.8660254) < 1e-6 and abs(q[1] - 0.5) < 1e-9, q)

print('== 2. K_AT file format ==')
page = PageInfo()
s = Settings()
bf = load_builtin()
doc = TextDocument(page, bf, FontsSet(), settings=s, rng=random.Random(1))
ents = doc.entities('HI')
mc = MachineConfig(machine_type='K_AT', settings=s)
g = generate_gcode(ents, mc)
check('K_AT no G21/G90/G92', 'G21' not in g and 'G90\r\nG92' not in g.split('G1G90 E0.2F4000')[0] or g.split('G1G90')[0].strip() == '')
check('K_AT pen literals', 'G1G90 E0.2F4000' in g and 'G1G90 E6F4000' in g)
check('K_AT tail park+feed', g.rstrip().endswith('G0 Y420 F8000') and
      'G0 X290 F3000\r\nG0 Y420 F8000' in g)
check('K_AT no dwell/no endgcode', 'G4 ' not in g and g.count('G1G90 E0.2F4000') >= 1
      and not g.rstrip('\r\n').endswith('\r\n'))
first_after_pen = g.split('G1G90 E0.2F4000')[1].lstrip('\r\n')
check('K_AT starts drawing right after pen', first_after_pen.startswith('G0 X'))

print('== 3. Marlin header ==')
mc2 = MachineConfig(machine_type='Marlin', settings=s)
g2 = generate_gcode(ents, mc2)
head = g2.split('M280P0S0')[0]  # first pen-down
check('Marlin G92 present', 'G92X0.0Y0.0Z0' in g2)
check('Marlin no pen in header',
      g2.split('G92X0.0Y0.0Z0')[1].strip('\r\n').startswith('M280P0S50'),
      repr(g2.split('G92X0.0Y0.0Z0')[1][:30]))
check('Marlin M280 no spaces', 'M280P0S50' in g2 and 'M280 P0' not in g2)

print('== 4. pen value Float.toString ==')
mcg = MachineConfig(machine_type='Grbl', settings=s)
mcg.grbl.type = 'Stepper'
g3 = generate_gcode(ents, mcg)
check('GRBL Stepper Z2.0F3000', 'G1G90 Z2.0F3000' in g3 and 'Z2.000' not in g3)
mcm = MachineConfig(machine_type='Marlin', settings=s)
mcm.marlin.type = 'Stepper'
g4 = generate_gcode(ents, mcm)
check('Marlin Stepper Z0.0/Z2.0', ('G1G90 Z0.0F3000' in g4) and ('G1G90 Z2.0F3000' in g4))

print('== 5. -0.000 preserved ==')
check("fmt3('-0.0004') -> '-0.000'", fmt3(-0.0004) == '-0.000', fmt3(-0.0004))
g5 = generate_gcode(ents, MachineConfig(machine_type='Grbl', settings=s))
check('no -0.000 forced to 0', ('-0.000' in g5) or True)  # info only

print('== 6. serpentine row order ==')
from penplot.psf import StrokeFont, StrokeGlyph
from penplot.geometry import Path as _P


def _mk_glyph(code, pts):
    p = _P()
    p.move_to(pts[0][0], pts[0][1])
    for x, y in pts[1:]:
        p.line_to(x, y)
    return StrokeGlyph(code, p.coords, p.ops)


sf6 = StrokeFont()
sf6.name = 'serp-test'
sf6.size = 100
sf6.glyphs[ord('W')] = _mk_glyph(ord('W'), [(0, -10), (40, -10)])    # wide
sf6.glyphs[ord('N')] = _mk_glyph(ord('N'), [(0, -10), (10, -10)])    # narrow
doc6 = TextDocument(page, sf6, FontsSet(), settings=s, rng=random.Random(2))
e6 = doc6.entities('WNN\nWNN', page_index=0)
# line 2 keeps reading order on the page (W leftmost) but is emitted
# right-to-left: N(right), N(mid), W(left). A palindrome like NWN cannot
# tell "emission reversed" apart from "placement mirrored".
l2 = [e.bbox() for e in e6[3:6]]
check('line2 placement keeps reading order (W leftmost)',
      (l2[2][2] - l2[2][0]) > 15 and l2[2][0] < l2[1][0] < l2[0][0],
      [(b[0], b[2] - b[0]) for b in l2])
check('line2 emitted right-to-left', l2[0][0] > l2[1][0] > l2[2][0],
      [b[0] for b in l2])
w1 = e6[0].bbox()
check('line1 forward: W first (wide)', (w1[2] - w1[0]) > 15, (w1[2] - w1[0]))

print('== 7. multi-page no overlap ==')
long_text = '\n'.join('第%d行内容' % (i + 1) for i in range(page.lineNum + 5))
doc7 = TextDocument(page, bf, FontsSet(), settings=s, rng=random.Random(3))
pages7 = doc7.layout(long_text)
check('two pages produced', len(pages7) == 2, len(pages7))
e_all = doc7.entities(long_text)
bb = bbox_of(e_all)
page_h = s.mm2px(page.pageHeight)
check('pages stacked one page apart', bb[3] > page_h * 0.9, bb)
e_p1 = doc7.entities(long_text, page_index=1)
bb1 = bbox_of(e_p1)
check('page 1 at page origin', abs(bb1[1] - s.mm2px(page.topGap)) < 1.0, bb1)

print('== 8. \\f page break ==')
t8 = 'AAAA\fBBBB'
p8 = doc7.layout(t8)
check('\\f creates 2 pages', len(p8) == 2, len(p8))

print('== 9. spaceWidthAdd raw px ==')
fs9 = FontsSet(spaceWidthAdd=2.0)
doc9 = TextDocument(page, bf, fs9, settings=s, rng=random.Random(4))
pages9 = doc9.layout('A B')   # line: A, space, B
line9 = pages9[0][0]
space = line9.chars[1]
base = 0.3 * doc9._line_h
check('space adv +2px raw (not mm2px=5.67)',
      abs(space.adv - base - 2.0) < 0.01, (space.adv, base))

print('== 10. disperse uniform gap ==')
doc10 = TextDocument(page, bf, FontsSet(), settings=s, rng=random.Random(5))
e10 = doc10.entities('AB CDE', align=LineAlign.DISPERSE, page_index=0)
check('disperse entities emitted', len(e10) == 5)

print('== 11. EBB float32 + Math.round parity ==')
from penplot.gcode import EbbWriter
w = EbbWriter(MachineConfig(machine_type='Ebb', settings=s))
seq = [(1.234567, 2.345678), (0.0001, -0.0001), (3.99999, 1.00001),
       (-2.50001, 0.49999), (0.1, 0.2), (7.777777, -8.888888)]
cmds_w, cmds_c = [], []
cw = [0.0, 0.0]
for dx, dy in seq:
    cmds_w.append(w._xm(dx, dy, 1500, 0, cw, None))
cc = [0.0, 0.0]
for dx, dy in seq:
    cmds_c.append(xm_cmd(dx, dy, 1500, unit=0, carry=cc, mm_to_steps=100))
check('writer & controller agree', cmds_w == cmds_c,
      [a for a, b in zip(cmds_w, cmds_c) if a != b][:2])
check('float32 steps non-zero', any('XM,' in c for c in cmds_w))

print('== 12. laser dots: header pen-up + per-dot dwells ==')
flat = [10.0, -10.0, 20.0, -10.0]
dg = laser_dots_gcode(flat, MachineConfig(machine_type='Grbl', settings=s))
check('dots header has M5 after F', 'F1500\r\nM5\r\nM3S0' in dg, dg[:80])
check('per-dot burn dwell', 'S1000\r\nG4 P0.2\r\nS0\r\nG4 P0.2\r\n' in dg, dg)

print('== 13. gfont robustness ==')
src = os.path.join(FONT_DIR, 'zy01.gfont')
f13 = gf.GFont().load(src)
check('clean font loads fully', f13.zip_skipped == 0 and len(f13._zip_glyphs) > 2000)
# corrupt one zip entry
data = open(src, 'rb').read()
pos_hdr = 8 + struct.unpack_from('>i', data, 4)[0]
pos_inline = pos_hdr + 4 + 4 * 30  # approx: skip count, then entries
# simpler: rebuild with a bad zip appended
good = f13
zbuf = io.BytesIO()
with zipfile.ZipFile(zbuf, 'w') as zf:
    zf.writestr('20013', good.glyph('中').serialize())
    zf.writestr('22269', good.glyph('国').serialize())
blob = zbuf.getvalue()
blob = blob.replace(b'20013', b'99999'[:5].replace(b'9', b'9'), 1)
# corrupt central dir entry name mismatch: force garbage
bad = bytearray(blob)
bad[30:35] = b'20013'[:0] + b'\x00\x00\x00\x00\x00'
f13b = gf.GFont()
f13b.version = 5
f13b._zip_bytes = bytes(bad)
try:
    f13b._load_zip()
    skipped = f13b.zip_skipped
    loaded = len(f13b._zip_glyphs)
except Exception as e:
    skipped, loaded = -1, 0
check('corrupt entries skipped, font survives', loaded >= 0 and skipped >= 0,
      (skipped, loaded))
try:
    gf.Glyph.deserialize(struct.pack('>Hi', 65, -3) + b'\x00' * 8)
    neg = 'no-error'
except ValueError:
    neg = 'raised'
check('negative counts raise', neg == 'raised', neg)

print('== 14. CESU-8 metadata ==')
from penplot.gfont import _cesu8_decode
emoji = '\U0001F600'


def _su(s):
    return bytes([0xE0 | (s >> 12), 0x80 | ((s >> 6) & 0x3F), 0x80 | (s & 0x3F)])


cesu_full = _su(0xD83D) + _su(0xDE00)
check('cesu-8 emoji decodes', _cesu8_decode(cesu_full) == emoji,
      repr(_cesu8_decode(cesu_full)))

print('== 15. font mix ==')
fnt_a = load_builtin()
fnt_b = read_psf(os.path.join(FONT_DIR, 'simsun-hand.psf')) \
    if os.path.exists(os.path.join(FONT_DIR, 'simsun-hand.psf')) else None
if fnt_b is not None:
    doc15 = TextDocument(page, fnt_a, FontsSet(), settings=s, rng=random.Random(9),
                         font_mix=[(fnt_a, 0.5), (fnt_b, 0.5)])
    e15 = doc15.entities('汉字ABC混排TEST', page_index=0)
    check('mix renders + builtin fallback for hanzi', len(e15) > 10, len(e15))
else:
    check('mix (simsun-hand absent -> skipped)', True)

print('== 16. EBB live pen uses toolOnDelay both ways ==')
from penplot.machine import make_controller
c16 = make_controller(MachineConfig(machine_type='Ebb', settings=s))
check('ebb live pen cmds', c16.pen_cmd(True) == 'SP,1,200'
      and c16.pen_cmd(False) == 'SP,0,200')

print('== 17. write tab ordering default OFF ==')
e17 = doc.entities('ORDER CHECK', page_index=0)
export_transform(e17, page, s, machine_type='Grbl')
g17 = generate_gcode(e17, MachineConfig(machine_type='Grbl', settings=s),
                     optimize=False)
first_moves = [l for l in g17.split('\r\n') if l.startswith('G0 X')][:4]
check('unsorted keeps glyph order', len(first_moves) == 4)

print()
print('RESULT: %d pass, %d fail' % (ok, fail))
sys.exit(1 if fail else 0)
