# -*- coding: utf-8 -*-
"""Glyph sources for the teletype character grid.

A source turns one character into pen strokes in CELL-LOCAL mm (x right
from the left edge of the character's first cell, y DOWN from the top of
the row). Paper adds the cell offset; the same strokes feed the G-code and
the web preview (`d` path strings), so what the page shows is what the pen
draws.

Sources
- MonoGlyphs: the built-in monospace single-stroke ASCII font (font.py).
  Default, fast (≈1.2 pen lifts per char), and the only font terminal mode
  uses (see service.py: terminal output is laid out by programs that assume
  a wcwidth terminal and arrives at shell speed, so it stays ASCII-only).
- FontGlyphs: any installed library font (.gfont / .psf via FontIndex).
  Library fonts have no reliable metrics (a "size 525" gfont draws its hanzi
  330 units tall, centred on x=0), so metrics are MEASURED once from a few
  reference glyphs: CJK fonts map the height of 中/国/永… to char_h and keep
  wide glyphs at their own position in the em box (so ，。 stay bottom-left),
  narrow glyphs are centred in their cells; everything is shrunk to fit.

Fonts are loaded once per session start / font change in an executor thread
(FontIndex keeps an LRU of loaded fonts, this module keeps the measured
metrics); typing only does in-memory glyph lookups.
"""
import collections
import statistics
import threading
import unicodedata

from . import font as mono_font
from .tty import normalize

MONO_ID = 'mono'
MONO_NAME = '内置等宽（ASCII）'
_CJK_REFS = '中国永田日口国电书写'
_CAP_REFS = 'HEIKLNTZ'


def char_width(ch, cjk=False):
    """Grid cells taken by ch: 2 for East-Asian wide/full-width, 0 for
    combining / format characters (dropped), else 1. In a CJK font the
    'ambiguous' punctuation (“” ‘’ … — ·) is drawn full width as well."""
    if not ch:
        return 0
    cat = unicodedata.category(ch)
    if cat in ('Mn', 'Me', 'Cf', 'Cc', 'Cs'):
        return 0
    eaw = unicodedata.east_asian_width(ch)
    if eaw in ('W', 'F'):
        return 2
    if cjk and eaw == 'A' and (0x2010 <= ord(ch) <= 0x206F or ch == '·'):
        return 2
    return 1


def is_wide(ch):
    return unicodedata.east_asian_width(ch) in ('W', 'F')


def _rdp(pts, tol):
    if len(pts) < 3 or tol <= 0:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        n2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if n2 == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / n2
                t = 0.0 if t < 0 else 1.0 if t > 1 else t
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best:
                best, bi = d, i
        if bi > 0 and best > tol * tol:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def _clean(strokes, tol):
    out = []
    for s in strokes:
        pts = []
        for x, y in s:
            p = (round(x, 2), round(y, 2))
            if not pts or pts[-1] != p:
                pts.append(p)
        if len(pts) == 1:
            pts.append(pts[0])           # a dot: pen down/up in place
        if pts:
            out.append(_rdp(pts, tol))
    return out


def box(w, geo):
    """Visible placeholder for a missing glyph: hollow box over the cells."""
    cw, h = geo['cw'], geo['h']
    x0, x1 = cw * 0.15, w * cw - cw * 0.15
    y0, y1 = h * 0.12, h
    return [[(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]]


def path_d(strokes):
    return ''.join('M' + 'L'.join('%s %s' % (_n(x), _n(y)) for x, y in s) for s in strokes)


def _n(v):
    s = ('%.2f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


class MonoGlyphs:
    font_id = MONO_ID
    name = MONO_NAME
    cjk = False
    cell_ratio = 4.0 / 6.0           # glyph width / char_h
    line_default = 1.6

    def has(self, ch):
        return ch in mono_font.GLYPHS

    def strokes(self, ch, geo, w):
        g = mono_font.GLYPHS.get(ch)
        if g is None:
            return None
        u = min(geo['h'] / 6.0, geo['cw'] * w * 0.9 / 4.0)
        x0 = (geo['cw'] * w - 4 * u) / 2
        y0 = geo['h'] - 6 * u                 # shrunk glyphs keep the baseline
        return [[(x0 + gx * u, y0 + gy * u) for gx, gy in s] for s in g]

    def info(self):
        return {'id': self.font_id, 'name': self.name, 'cjk': False}


MONO = MonoGlyphs()


class FontGlyphs:
    """A library font measured for grid use."""
    line_default = 1.45

    def __init__(self, font_id, font, name=None):
        self.font_id = font_id
        self.font = font
        self.name = name or font_id
        self._measure()

    def _bbox(self, ch):
        g = self.font.glyph(ch)
        if g is None or not g.ops or not g.coords:
            return None
        xs, ys = g.coords[0::2], g.coords[1::2]
        return min(xs), min(ys), max(xs), max(ys)

    def _measure(self):
        cjk = [b for b in (self._bbox(c) for c in _CJK_REFS) if b and b[3] - b[1] > 0]
        cap = [b for b in (self._bbox(c) for c in _CAP_REFS) if b and b[3] - b[1] > 0]
        refs = cjk or cap
        self.cjk = bool(cjk)
        if refs:
            self.ref_h = statistics.median(b[3] - b[1] for b in refs)
            self.base = statistics.median(b[3] for b in refs)
            self.cx = statistics.median((b[0] + b[2]) / 2 for b in refs)
            self.em_w = statistics.median(b[2] - b[0] for b in refs)
        else:
            size = float(getattr(self.font, 'size', 100) or 100)
            self.ref_h, self.base, self.cx, self.em_w = size * 0.7, 0.0, size / 2, size
        self.ref_h = max(self.ref_h, 1e-6)
        self.cell_ratio = 0.5 if self.cjk else 0.6

    def has(self, ch):
        g = self.font.glyph(ch)
        return g is not None and bool(g.ops)

    def strokes(self, ch, geo, w):
        g = self.font.glyph(ch)
        if g is None or not g.ops:
            return None
        polys, cur = [], None
        c = g.coords
        for i, op in enumerate(g.ops):
            p = (c[2 * i], c[2 * i + 1])
            if op == 0 or cur is None:
                cur = [p]
                polys.append(cur)
            else:
                cur.append(p)
        xs = c[0::2]
        bx0, bx1 = min(xs), max(xs)
        span = geo['cw'] * w
        k = geo['h'] / self.ref_h
        if self.cjk and w == 2 and is_wide(ch):
            # em-box placement: full-width punctuation keeps its corner
            ox = self.cx
            half = max(self.cx - bx0, bx1 - self.cx, self.em_w / 2)
            k = min(k, span * 0.47 / half) if half > 0 else k
            x0 = span / 2
        else:
            ox = (bx0 + bx1) / 2
            bw = bx1 - bx0
            x0 = span / 2
            if bw * k > span * 0.92:
                # too wide for its cell (m, w, W in a proportional font): condense
                # horizontally only, like a typewriter face - shrinking uniformly
                # made these letters visibly smaller than their neighbours
                kx = span * 0.92 / bw
                h = geo['h']
                return [[(x0 + (x - ox) * kx, h + (y - self.base) * k) for x, y in s] for s in polys]
        # reference glyphs span y 0..h of the row; shrunk glyphs keep the baseline
        h = geo['h']
        return [[(x0 + (x - ox) * k, h + (y - self.base) * k) for x, y in s] for s in polys]

    def info(self):
        return {'id': self.font_id, 'name': self.name, 'cjk': self.cjk}


class Glyphs:
    """Session glyph source: the chosen font, then the built-in font, then
    a visible box. Strokes are cached per (char, width) for one geometry."""

    def __init__(self, primary=None):
        self.primary = primary or MONO
        self._cache = collections.OrderedDict()
        self._geo_key = None

    @property
    def font_id(self):
        return self.primary.font_id

    @property
    def cjk(self):
        return self.primary.cjk

    @property
    def cell_ratio(self):
        return self.primary.cell_ratio

    @property
    def line_default(self):
        return self.primary.line_default

    def info(self):
        return self.primary.info()

    def width(self, ch):
        return char_width(ch, self.cjk)

    def prepare(self, ch):
        """Text to put on paper for one typed char: itself when some font can
        draw it; the ASCII form of full-width / CJK punctuation when only the
        built-in font can (old demo behaviour, now just a fallback)."""
        if self.primary.has(ch) or MONO.has(ch):
            return ch
        n = normalize(ch)
        if n != ch and all(self.primary.has(c) or MONO.has(c) or c == ' ' for c in n):
            return n
        return ch

    def draw(self, ch, w, geo, mono_only=False):
        """-> (strokes, source) with source 'font' | 'mono' | 'box'."""
        gk = (geo['h'], geo['cw'])
        if gk != self._geo_key:
            self._cache.clear()
            self._geo_key = gk
        key = (ch, w, mono_only)
        hit = self._cache.get(key)
        if hit is not None:
            self._cache.move_to_end(key)
            return hit
        st, src = None, 'font'
        if not mono_only and self.primary is not MONO:
            st = self.primary.strokes(ch, geo, w)
        if st is None:
            st, src = MONO.strokes(ch, geo, w), 'mono'
        if st is None:
            st, src = box(w, geo), 'box'
        out = (_clean(st, max(0.02, geo['h'] * 0.006)), src)
        self._cache[key] = out
        while len(self._cache) > 3000:
            self._cache.popitem(last=False)
        return out


# ---------------------------------------------------------------- loading
_MEASURED = collections.OrderedDict()     # (font_id, mtime, size) -> FontGlyphs
_MEASURED_LOCK = threading.Lock()


def load_blocking(fonts, font_id):
    """FontGlyphs for a library font (blocking: run in an executor).
    fonts: the FontIndex. Raises ApiError font_not_found."""
    from ..errors import ApiError
    if not font_id or font_id == MONO_ID:
        return MONO
    if not fonts.exists(font_id):
        raise ApiError(404, 'font_not_found', '字体不存在：%s' % font_id, {'font_id': font_id})
    r = fonts._row(font_id)
    key = (font_id, r['mtime'], r['size_bytes'])
    with _MEASURED_LOCK:
        g = _MEASURED.get(key)
        if g is not None:
            _MEASURED.move_to_end(key)
            return g
    f = fonts.font(font_id)
    g = FontGlyphs(font_id, f, r['custom_name'] or r['display_name'])
    with _MEASURED_LOCK:
        _MEASURED[key] = g
        while len(_MEASURED) > 4:
            _MEASURED.popitem(last=False)
    return g
