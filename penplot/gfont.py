# -*- coding: utf-8 -*-
"""Parser for the .gfont stroke-font format used by the original engraving suite.

Layout (all ints/floats big-endian, Java DataInputStream compatible):
    int32 version                     # <= 5 supported
    if version >= 5:
        int32 encLen
        encLen bytes  = TEA-encrypted header (key penplot.tea.GFONT_KEY)
        header: UTF name, int32 type_ordinal, UTF b, UTF a, UTF c,
                int32 size, int32 glyph_count, [v>=2: UTF n], [v>=4: UTF o]
    int32 n_inline
    n_inline glyphs inline
    ZIP archive: entry name = str(charcode); entry body = glyph record

Glyph record: uint16 charcode, int32 n_floats, float32 x n, int32 n_bytes, byte x n
    ops: 0 = moveTo, 1 = lineTo (coords are x,y pairs)
"""
import io
import os
import struct
import zipfile

from collections.abc import Mapping

from . import tea


class _LazyZipGlyphs(Mapping):
    """{charcode: Glyph} backed by the font's ZIP archive.

    Only the central directory is read at load time; each glyph is
    deserialized on first access and cached. A big CJK font (6-7k glyphs)
    therefore opens in milliseconds instead of seconds, which matters on
    small ARM boards. A corrupt entry costs only that glyph
    (owner.zip_skipped is incremented when it is first touched).
    """

    def __init__(self, owner, zf: zipfile.ZipFile):
        self._owner = owner
        self._zf = zf
        self._names = {}
        for name in zf.namelist():
            try:
                code = int(name)
            except ValueError:
                if not name:
                    continue
                code = ord(name[0])
            self._names[code] = name
        self._cache = {}
        self._bad = set()

    def __getitem__(self, code):
        g = self._cache.get(code)
        if g is not None:
            return g
        if code not in self._names or code in self._bad:
            raise KeyError(code)
        try:
            g, _ = Glyph.deserialize(self._zf.read(self._names[code]))
        except Exception:
            self._bad.add(code)
            self._owner.zip_skipped += 1
            raise KeyError(code)
        self._cache[code] = g
        return g

    def __contains__(self, code):
        return code in self._names and code not in self._bad

    def __iter__(self):
        return (c for c in self._names if c not in self._bad)

    def __len__(self):
        return len(self._names) - len(self._bad)


def _read_utf(buf, pos: int):
    (n,) = struct.unpack_from('>H', buf, pos)
    pos += 2
    raw = bytes(buf[pos:pos + n])
    s = _cesu8_decode(raw)
    return s, pos + n


def _cesu8_decode(raw: bytes) -> str:
    """Java writeUTF emits modified UTF-8 (CESU-8: supplementary chars as
    surrogate pairs). Re-combine surrogates so emoji etc. survive."""
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        pass
    try:
        t = raw.decode('utf-8', 'surrogatepass')
        return t.encode('utf-16', 'surrogatepass').decode('utf-16')
    except Exception:
        return raw.decode('utf-8', 'replace')


class Glyph:
    __slots__ = ('char', 'coords', 'ops')

    def __init__(self, char: int, coords=None, ops=None):
        self.char = char
        self.coords = list(coords) if coords else []
        self.ops = list(ops) if ops else []

    @property
    def empty(self) -> bool:
        return not self.ops

    def points(self):
        """Yield (op, x, y) tuples."""
        c = self.coords
        for i, op in enumerate(self.ops):
            yield op, c[i * 2], c[i * 2 + 1]

    def serialize(self) -> bytes:
        out = bytearray()
        out += struct.pack('>Hi', self.char, len(self.coords))
        for f in self.coords:
            out += struct.pack('>f', f)
        out += struct.pack('>i', len(self.ops))
        out += bytes(self.ops)
        return bytes(out)

    @classmethod
    def deserialize(cls, buf, pos: int = 0):
        char, n = struct.unpack_from('>Hi', buf, pos)
        pos += 6
        if n < 0 or n * 4 > len(buf) * 4 + 16:
            raise ValueError('corrupt glyph: bad coord count %d' % n)
        coords = list(struct.unpack_from('>%df' % n, buf, pos))
        pos += 4 * n
        (m,) = struct.unpack_from('>i', buf, pos)
        pos += 4
        if m < 0 or m > len(buf):
            raise ValueError('corrupt glyph 0x%04X: bad op count %d' % (char, m))
        ops = list(buf[pos:pos + m])
        pos += m
        return cls(char, coords, ops), pos


class GFont:
    def __init__(self):
        self.version = 0
        self.name = ''
        self.type_ordinal = 0
        self.b = ''
        self.a = ''
        self.c = ''
        self.size = 0            # reference size used when the font was built
        self.glyph_count = 0
        self.n = ''
        self.o = ''
        self.inline: dict[int, Glyph] = {}
        self._zip_bytes = b''
        self._zip_glyphs: Mapping = {}
        self._zip_loaded = False
        self.zip_skipped = 0

    # ---------------- parsing ----------------
    def _parse_header(self, buf):
        pos = 0
        self.name, pos = _read_utf(buf, pos)
        (self.type_ordinal,) = struct.unpack_from('>i', buf, pos); pos += 4
        self.b, pos = _read_utf(buf, pos)
        self.a, pos = _read_utf(buf, pos)
        self.c, pos = _read_utf(buf, pos)
        (self.size, self.glyph_count) = struct.unpack_from('>ii', buf, pos); pos += 8
        if self.version >= 2:
            self.n, pos = _read_utf(buf, pos)
        if self.version >= 4:
            self.o, pos = _read_utf(buf, pos)

    def load(self, path_or_bytes, load_zip: bool = True, lazy: bool = True):
        """Parse a font. load_zip=False reads only header + inline glyphs
        (enough for name/size listing). lazy=True (default) defers decoding
        of ZIP glyphs until they are used; lazy=False decodes everything
        up front (and fills zip_skipped immediately)."""
        if isinstance(path_or_bytes, (bytes, bytearray)):
            data = path_or_bytes
        else:
            with open(path_or_bytes, 'rb') as fh:
                data = fh.read()
        pos = 0
        (self.version,) = struct.unpack_from('>i', data, pos); pos += 4
        if self.version > 5:
            raise ValueError('unsupported gfont version %d' % self.version)
        if self.version >= 5:
            (enc_len,) = struct.unpack_from('>i', data, pos); pos += 4
            enc = data[pos:pos + enc_len]; pos += enc_len
            header = tea.decrypt(enc, tea.GFONT_KEY)
            self._parse_header(memoryview(header))
        else:
            end = self._parse_header_stripped(data, pos)
            pos = end
        (n_inline,) = struct.unpack_from('>i', data, pos); pos += 4
        for _ in range(n_inline):
            g, pos = Glyph.deserialize(data, pos)
            self.inline[g.char] = g
        if load_zip:
            self._zip_bytes = data[pos:]
            if lazy:
                self._open_zip_lazy()
            else:
                self._load_zip()
        return self

    def _open_zip_lazy(self):
        self.zip_skipped = 0
        if not self._zip_bytes:
            return
        try:
            zf = zipfile.ZipFile(io.BytesIO(self._zip_bytes))
        except Exception:
            self._zip_glyphs = {}
            self.zip_skipped = -1     # whole archive unreadable
            return
        self._zip_glyphs = _LazyZipGlyphs(self, zf)
        self._zip_loaded = True

    def _parse_header_stripped(self, data, pos):
        buf = memoryview(data)
        self.name, pos = _read_utf(buf, pos)
        (self.type_ordinal,) = struct.unpack_from('>i', data, pos); pos += 4
        self.b, pos = _read_utf(buf, pos)
        self.a, pos = _read_utf(buf, pos)
        self.c, pos = _read_utf(buf, pos)
        (self.size, self.glyph_count) = struct.unpack_from('>ii', data, pos); pos += 8
        if self.version >= 2:
            self.n, pos = _read_utf(buf, pos)
        if self.version >= 4:
            self.o, pos = _read_utf(buf, pos)
        return pos

    def _load_zip(self):
        if not self._zip_bytes:
            return
        self.zip_skipped = 0
        try:
            zf = zipfile.ZipFile(io.BytesIO(self._zip_bytes))
        except Exception:
            self._zip_glyphs = {}
            self.zip_skipped = -1     # whole archive unreadable
            return
        self._zip_glyphs = {}
        self._zip_loaded = True
        for name in zf.namelist():
            try:
                code = int(name)
            except ValueError:
                code = ord(name[0])
            # a single corrupt entry costs one glyph, not the whole font
            try:
                g, _ = Glyph.deserialize(zf.read(name))
                self._zip_glyphs[code] = g
            except Exception:
                self.zip_skipped += 1

    # ---------------- access ----------------
    def glyph(self, char) -> Glyph | None:
        if isinstance(char, str):
            char = ord(char)
        if char in self.inline:
            return self.inline[char]
        return self._zip_glyphs.get(char)

    def has_glyph(self, char) -> bool:
        if isinstance(char, str):
            char = ord(char)
        return char in self.inline or char in self._zip_glyphs

    @property
    def filename(self) -> str:
        return self.o or self.n or self.name


def read_header(path):
    """Header + glyph code list WITHOUT reading the whole file (03 §10.7).

    Reads the (small) header and inline glyph block from the start, then
    only the ZIP central directory from the end (zipfile seeks there; the
    ZIP is stored after a prefix, which zipfile handles). Returns
    (GFont with header fields filled and no glyph data, sorted list of codes).
    """
    f = GFont()
    codes = set()
    with open(path, 'rb') as fh:
        head = fh.read(4)
        (f.version,) = struct.unpack('>i', head)
        if f.version > 5:
            raise ValueError('unsupported gfont version %d' % f.version)
        if f.version >= 5:
            (enc_len,) = struct.unpack('>i', fh.read(4))
            enc = fh.read(enc_len)
            f._parse_header(memoryview(tea.decrypt(enc, tea.GFONT_KEY)))
            pos = 8 + enc_len
        else:
            buf = fh.read(64 * 1024)
            pos = 4 + f._parse_header_stripped(buf, 0)
        fh.seek(pos)
        (n_inline,) = struct.unpack('>i', fh.read(4))
        for _ in range(max(0, n_inline)):
            hdr = fh.read(6)
            char, n = struct.unpack('>Hi', hdr)
            fh.seek(4 * n, 1)
            (m,) = struct.unpack('>i', fh.read(4))
            fh.seek(m, 1)
            codes.add(char)
        try:
            fh.seek(0)
            zf = zipfile.ZipFile(fh)
            for name in zf.namelist():
                try:
                    codes.add(int(name))
                except ValueError:
                    if name:
                        codes.add(ord(name[0]))
        except zipfile.BadZipFile:
            pass
    return f, sorted(codes)


def load_dir(font_dir) -> dict:
    """Load every .gfont in a directory. Returns {font_filename: GFont}."""
    fonts = {}
    if not font_dir or not os.path.isdir(font_dir):
        return fonts
    for fn in os.listdir(font_dir):
        if not fn.lower().endswith('.gfont'):
            continue
        try:
            f = GFont().load(os.path.join(font_dir, fn))
            key = fn[:-6]
            fonts[key] = f
        except Exception as e:
            print('skip %s: %s' % (fn, e))
    return fonts
