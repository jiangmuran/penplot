# -*- coding: utf-8 -*-
"""PSF - plaintext stroke-font format (.psf) and font interchange.

Format v1 (line-oriented, UTF-8, '#' comments, whitespace-insensitive):

    #psf 1
    name   My Font
    family my-font
    author someone
    size   100            # reference height unit (like gfont size)
    type   0              # free-form classification int

    glyph 0x0041 A        # <code> [display char, comment only]
    m 12.0 -62.0          # moveTo
    l 46.0 0.0            # lineTo
    ...

Coordinate convention (same as .gfont): y grows DOWNWARD, baseline at y=0,
glyph body above the baseline has negative y.

This module also converts both ways with the encrypted .gfont format:
    gfont -> psf : read_gfont() / StrokeFont.from_gfont()
    psf  -> gfont: write_gfont_bytes()  (produces a valid v5 file that the
                   original software can import through its font dialog)
"""
import io
import os
from collections.abc import Mapping
import struct
import zipfile

from . import tea
from .gfont import GFont


class StrokeGlyph:
    __slots__ = ('char', 'coords', 'ops', 'advance')

    def __init__(self, char, coords=None, ops=None, advance=None):
        self.char = char
        self.coords = list(coords) if coords else []
        self.ops = list(ops) if ops else []
        # advance width in font units (None -> derive from glyph bbox, the
        # legacy behaviour; set for space-like glyphs from TTF conversion)
        self.advance = advance

    def points(self):
        c = self.coords
        for i, op in enumerate(self.ops):
            yield op, c[i * 2], c[i * 2 + 1]


class StrokeFont:
    """Unified font object; duck-type compatible with gfont.GFont."""

    def __init__(self):
        self.name = ''
        self.family = ''
        self.author = ''
        self.size = 100.0
        self.type_ordinal = 0
        self.glyphs = {}

    @property
    def glyph_count(self):
        return len(self.glyphs)

    @property
    def filename(self):
        return self.name or self.family or 'font'

    def glyph(self, ch):
        if isinstance(ch, str):
            ch = ord(ch)
        g = self.glyphs.get(ch)
        if g is None:
            return None
        return g

    def has_glyph(self, ch):
        if isinstance(ch, str):
            ch = ord(ch)
        return ch in self.glyphs

    # ---------------- gfont interchange ----------------
    @classmethod
    def from_gfont(cls, g: GFont) -> 'StrokeFont':
        f = cls()
        f.name = g.b or g.name or 'gfont'
        f.family = g.name
        f.author = g.o or g.n
        f.size = float(g.size) if g.size else 100.0
        f.type_ordinal = g.type_ordinal
        # collect every glyph (inline + zip); keep even empty-op entries
        # so roundtrips preserve the font byte-faithfully (rendering of
        # empty glyphs is identical: nothing drawn)
        codes = set(list(g.inline.keys()) + list(g._zip_glyphs.keys()))
        codes |= {gg.char for gg in g.inline.values()}
        for code in codes:
            gg = g.glyph(chr(code)) if code < 0x110000 else None
            if gg is None:
                gg = g.inline.get(code) or g._zip_glyphs.get(code)
            if gg is not None:
                f.glyphs[code] = StrokeGlyph(gg.char, gg.coords, gg.ops)
        return f

    def to_gfont_bytes(self) -> bytes:
        """Build a valid encrypted v5 .gfont (importable by the original app)."""
        return write_gfont_bytes(self)


def _write_utf(s: str) -> bytes:
    b = s.encode('utf-8')
    return struct.pack('>H', len(b)) + b


def write_gfont_bytes(font) -> bytes:
    """font: StrokeFont-like with .name/.size/.glyphs{code:(coords,ops)}."""
    glyphs = font.glyphs
    n = len(glyphs)
    name = (font.name or 'font')[:200]
    family = getattr(font, 'family', '') or ''
    author = getattr(font, 'author', '') or ''

    hdr = bytearray()
    hdr += _write_utf(name)                      # e: display name (gfont 'b')
    hdr += struct.pack('>i', int(getattr(font, 'type_ordinal', 0) or 0))
    hdr += _write_utf(name)                      # b
    hdr += _write_utf(family)                    # a
    hdr += _write_utf('')                        # c
    hdr += struct.pack('>ii', int(float(font.size or 100)), n)
    hdr += _write_utf('')                        # n (v2)
    hdr += _write_utf(author)                    # o (v4)

    out = bytearray()
    out += struct.pack('>i', 5)                  # version
    enc = tea.encrypt(bytes(hdr), tea.GFONT_KEY)
    out += struct.pack('>i', len(enc))
    out += enc
    out += struct.pack('>i', 0)                  # inline glyph count = 0
    zbuf = io.BytesIO()
    with zipfile.ZipFile(zbuf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for code in sorted(glyphs):
            g = glyphs[code]
            body = bytearray()
            body += struct.pack('>Hi', code, len(g.coords))
            for f in g.coords:
                body += struct.pack('>f', f)
            body += struct.pack('>i', len(g.ops))
            body += bytes(g.ops)
            zf.writestr(str(code), bytes(body))
    out += zbuf.getvalue()
    return bytes(out)


# ---------------------------------------------------------------- psf io
def write_psf(font, path):
    lines = ['#psf 1']
    if font.name:
        lines.append('name %s' % font.name)
    if getattr(font, 'family', ''):
        lines.append('family %s' % font.family)
    if getattr(font, 'author', ''):
        lines.append('author %s' % font.author)
    lines.append('size %g' % float(font.size or 100))
    lines.append('type %d' % int(getattr(font, 'type_ordinal', 0) or 0))
    for code in sorted(font.glyphs):
        g = font.glyphs[code]
        try:
            disp = chr(code)
        except ValueError:
            disp = ''
        lines.append('')
        comment = (' %s' % disp) if disp.strip() and disp.isprintable() else ''
        adv = ''
        if g.advance is not None:
            adv = ' adv=%s' % ('%.9g' % g.advance)
        lines.append('glyph 0x%04X%s%s' % (code, adv, comment))
        c = g.coords
        for i, op in enumerate(g.ops):
            cmd = 'm' if op == 0 else 'l'
            lines.append('%s %.9g %.9g' % (cmd, c[i * 2], c[i * 2 + 1]))
    data = '\n'.join(lines) + '\n'
    open(path, 'w', encoding='utf-8', newline='\n').write(data)
    return data


class _LazyPsfGlyphs(Mapping):
    """{code: StrokeGlyph} parsed on first access from the raw .psf text.

    A TTF-converted font has thousands of glyphs; parsing all of them into
    Python lists costs ~100 MB in a long-lived process. The index is built by
    one regex pass (C speed) and only touched glyphs are materialised."""
    _GLYPH = None

    def __init__(self, text):
        import re
        if _LazyPsfGlyphs._GLYPH is None:
            _LazyPsfGlyphs._GLYPH = re.compile(r'^[ \t]*glyph[ \t]+(\S+)([^\n]*)$', re.M | re.I)
        self._text = text
        self._index = {}
        prev = None                       # (code, body_start, extra) awaiting its end
        for m in _LazyPsfGlyphs._GLYPH.finditer(text):
            if prev is not None:
                self._index[prev[0]] = (prev[1], m.start(), prev[2])
                prev = None
            try:
                code = int(m.group(1), 0)
            except ValueError:
                continue
            extra = m.group(2).strip()
            prev = (code, m.end(), extra or None)
        if prev is not None:
            self._index[prev[0]] = (prev[1], len(text), prev[2])
        self._cache = {}

    def __getitem__(self, code):
        g = self._cache.get(code)
        if g is not None:
            return g
        start, end, extra = self._index[code]
        g = StrokeGlyph(code)
        for tok in (extra or '').split():
            if tok.lower().startswith('adv='):
                try:
                    g.advance = float(tok[4:])
                except ValueError:
                    pass
        for raw in self._text[start:end].split('\n'):
            line = raw.split('#', 1)[0].split()
            if len(line) >= 3 and line[0] in ('m', 'l', 'M', 'L'):
                g.coords.extend((float(line[1]), float(line[2])))
                g.ops.append(0 if line[0] in ('m', 'M') else 1)
        self._cache[code] = g
        return g

    def __contains__(self, code):
        return code in self._index

    def __iter__(self):
        return iter(self._index)

    def __len__(self):
        return len(self._index)


def read_psf(path_or_text, lazy=False) -> StrokeFont:
    """lazy=True: only the header is parsed now; glyphs on first use
    (used for files opened by path through load_font)."""
    if lazy and isinstance(path_or_text, str) and os.path.exists(path_or_text):
        text = open(path_or_text, encoding='utf-8').read()
        f = StrokeFont()
        import re
        m = re.search(r'^[ \t]*glyph[ \t]', text, re.M | re.I)   # no lower(): a CJK text copy is 4 B/char
        head = text if m is None else text[:m.start()]
        for raw in head.split('\n'):
            line = raw.split('#', 1)[0].strip()
            if not line:
                continue
            parts = line.split()
            k = parts[0].lower()
            if k == 'name':
                f.name = line[4:].strip()
            elif k == 'family':
                f.family = line[6:].strip()
            elif k == 'author':
                f.author = line[6:].strip()
            elif k == 'size' and len(parts) > 1:
                f.size = float(parts[1])
            elif k == 'type' and len(parts) > 1:
                f.type_ordinal = int(parts[1])
        f.glyphs = _LazyPsfGlyphs(text)
        if not f.name:
            f.name = os.path.splitext(os.path.basename(path_or_text))[0]
        return f
    return _read_psf_eager(path_or_text)


def _read_psf_eager(path_or_text) -> StrokeFont:
    if isinstance(path_or_text, (bytes, bytearray)):
        text = path_or_text.decode('utf-8')
    elif '\n' in path_or_text or os.path.exists(path_or_text):
        text = open(path_or_text, encoding='utf-8').read() if os.path.exists(path_or_text) \
            else path_or_text
    else:
        text = open(path_or_text, encoding='utf-8').read()
    f = StrokeFont()
    cur = None
    for raw in text.split('\n'):
        line = raw.split('#', 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        k = parts[0].lower()
        if k == 'glyph':
            tok = parts[1]
            code = int(tok, 0)
            cur = StrokeGlyph(code)
            # optional adv=... token (v1.1 extension, backward compatible)
            for extra in parts[2:]:
                if extra.lower().startswith('adv='):
                    try:
                        cur.advance = float(extra[4:])
                    except ValueError:
                        pass
            f.glyphs[code] = cur
        elif k in ('m', 'l') and cur is not None:
            x, y = float(parts[1]), float(parts[2])
            cur.coords.extend((x, y))
            cur.ops.append(0 if k == 'm' else 1)
        elif k == 'name':
            f.name = line[4:].strip()
        elif k == 'family':
            f.family = line[6:].strip()
        elif k == 'author':
            f.author = line[6:].strip()
        elif k == 'size':
            f.size = float(parts[1])
        elif k == 'type':
            f.type_ordinal = int(parts[1])
    if not f.name:
        f.name = os.path.splitext(os.path.basename(
            path_or_text if isinstance(path_or_text, str) else 'font'))[0] \
            if isinstance(path_or_text, str) and os.path.exists(path_or_text) else 'font'
    return f


def read_gfont_as_stroke(path) -> StrokeFont:
    return StrokeFont.from_gfont(GFont().load(path))


def convert_font(src, dst):
    """Auto-detect by extension/content; returns a human summary."""
    se, de = os.path.splitext(src)[1].lower(), os.path.splitext(dst)[1].lower()
    if se == '.gfont' and de == '.psf':
        f = read_gfont_as_stroke(src)
        write_psf(f, dst)
        return 'gfont -> psf: %d glyphs -> %s' % (f.glyph_count, dst)
    if se == '.psf' and de == '.gfont':
        f = read_psf(src)
        open(dst, 'wb').write(write_gfont_bytes(f))
        return 'psf -> gfont: %d glyphs -> %s' % (f.glyph_count, dst)
    if se == '.psf' and de == '.psf':
        f = read_psf(src)
        write_psf(f, dst)
        return 'psf normalised -> %s' % dst
    if se == '.gfont' and de == '.gfont':
        f = read_gfont_as_stroke(src)
        open(dst, 'wb').write(write_gfont_bytes(f))
        return 'gfont re-packed -> %s' % dst
    raise ValueError('unsupported conversion %s -> %s' % (se, de))


# ---------------------------------------------------------------- loader
def load_font(path):
    """Unified loader: .psf or .gfont (auto-detect)."""
    ext = os.path.splitext(path)[1].lower()
    if ext == '.psf':
        return read_psf(path, lazy=True)
    if ext == '.gfont':
        return GFont().load(path)
    # sniff: gfont v5 starts with int32 3..5, psf starts with '#psf'
    with open(path, 'rb') as fh:
        head = fh.read(16)
    if head.startswith(b'#psf') or head.startswith(b'\xef\xbb\xbf#psf'):
        return read_psf(path, lazy=True)
    return GFont().load(path)


def font_index(font_dir='.'):
    """{key: path} for every font file in a directory, without loading any."""
    if not font_dir or not os.path.isdir(font_dir):
        return {}
    return {os.path.splitext(fn)[0]: os.path.join(font_dir, fn)
            for fn in sorted(os.listdir(font_dir))
            if fn.lower().endswith(('.gfont', '.psf'))}


def load_dir(font_dir='.'):
    """Load every font in a directory (both formats)."""
    fonts = {}
    if not font_dir or not os.path.isdir(font_dir):
        return fonts
    for fn in sorted(os.listdir(font_dir)):
        if not fn.lower().endswith(('.gfont', '.psf')):
            continue
        try:
            f = load_font(os.path.join(font_dir, fn))
            fonts[os.path.splitext(fn)[0]] = f
        except Exception as e:
            print('skip %s: %s' % (fn, e))
    return fonts
