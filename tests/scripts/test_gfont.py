# -*- coding: utf-8 -*-
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _paths import require_fonts, FONT_DIR, TTF_DIR, require  # noqa: E402
require_fonts('zy01.gfont')
from penplot.gfont import GFont

fontdir = FONT_DIR
print('fontdir:', fontdir, os.path.isdir(fontdir))

for fn in ['zy01.gfont', sorted(f for f in os.listdir(fontdir) if f.endswith('.gfont'))[0]]:
    p = os.path.join(fontdir, fn)
    f = GFont().load(p)
    print('--- %s' % fn)
    print(' version=%s name=%r b=%r a=%r c=%r' % (f.version, f.name, f.b, f.a, f.c))
    print(' size=%s glyph_count=%s n=%r o=%r' % (f.size, f.glyph_count, f.n, f.o))
    print(' inline=%d zip=%d' % (len(f.inline), len(f._zip_glyphs)))
    tested = 0
    for code in sorted(f._zip_glyphs)[:5]:
        g = f.glyph(chr(code)) if code < 0x110000 else None
        if g and g.coords:
            pts = list(zip(g.coords[0:10:2], g.coords[1:10:2]))
            print('  U+%04X %r: %d coords %d ops, head=%s' % (
                code, chr(code), len(g.coords), len(g.ops),
                [(round(x, 1), round(y, 1)) for x, y in pts]))
            tested += 1
    # roundtrip check: decrypt->encrypt->decrypt
    from penplot import tea
    data = open(p, 'rb').read()
    import struct
    ver, enc_len = struct.unpack_from('>ii', data, 0)
    enc = data[8:8 + enc_len]
    hdr = tea.decrypt(enc, tea.GFONT_KEY)
    re_enc = tea.encrypt(hdr, tea.GFONT_KEY)
    hdr2 = tea.decrypt(re_enc, tea.GFONT_KEY)
    print(' roundtrip hdr ok:', hdr == hdr2)
