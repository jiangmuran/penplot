# -*- coding: utf-8 -*-
"""TTF/TTC/OTF -> PSF converter with handwriting-style strokes.

skeleton mode (default):
    cmap filter (no .notdef tofu) -> render (cropped to the ink, baseline
    anchored) -> thinning -> adaptive spur pruning (1.2x stroke width)
    -> junction-joined STROKE extraction (crossings do not cut strokes)
    -> orientation & pen-order -> per-component dot fallback -> RDP
    simplification -> PSF with advance widths (from hmtx, so spacing is
    the font's own, spaces preserved).

outline mode:
    fontTools pens flatten the vector contours directly (TrueType quadratic
    AND CFF cubic curves, composites decomposed) - resolution independent,
    in font units.

Scale convention: the built-in stroke fonts draw CJK ink about 0.70 x
`size` tall (y = -0.63 .. +0.07 size). A TTF em box holds ~0.9 em of
CJK ink, so the PSF `size` is set to EM_TO_SIZE x em: converted fonts then
come out the same size, on the same baseline, as the built-in ones.

Dependencies: Pillow, numpy, fontTools (no scikit-image needed).
"""
import math
import os
import struct
import sys

from .psf import StrokeFont, StrokeGlyph, write_psf
from .geometry import Path

# numpy / Pillow / fontTools / strokes are imported lazily: the web main
# process imports this module only for sniff_font() / charset_chars().

EM_TO_SIZE = 1.3
MODES = ('skeleton', 'outline')


class TtfError(ValueError):
    """Conversion error with an API error code and a user-facing message."""

    def __init__(self, code, message, detail=None):
        super().__init__(message)
        self.code, self.message, self.detail = code, message, detail


class TtfFaceError(TtfError, OSError):
    """The requested face cannot be opened (also an IOError, as before)."""


# ---------------------------------------------------------------- charsets
def gb2312_charset(level2=False):
    """GB2312 hanzi in encoding order (0xB0.. level1, ..0xF7 level2)."""
    out = []
    for hi in range(0xB0, 0xF8 if level2 else 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                out.append(bytes([hi, lo]).decode('gb2312'))
            except UnicodeDecodeError:
                pass
    return out


def gb2312_symbols():
    """GB2312 symbol rows 0xA1..0xA3: full-width punctuation ,。、;:?!""
    ()[]《》【】... plus math/currency symbols."""
    out = []
    for hi in range(0xA1, 0xA4):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes([hi, lo]).decode('gb2312')
                if ch.isprintable():
                    out.append(ch)
            except UnicodeDecodeError:
                pass
    return out


def default_charset(level2=False, latin=True):
    cs = [chr(c) for c in range(0x20, 0x7F)] if latin else []
    return cs + gb2312_symbols() + gb2312_charset(level2)


CHARSETS = ('gb2312-1', 'gb2312-2', 'latin', 'custom')
MAX_CHARS = 30000


def charset_chars(charset, extra=None):
    """API charset name (+ extra chars) -> de-duplicated list of chars.
    'latin' = printable ASCII; 'gb2312-1/-2' = ASCII + GB2312 symbols + hanzi
    level 1 (3755) / levels 1+2 (6763); 'custom' = only `extra`."""
    if charset not in CHARSETS:
        raise TtfError('bad_input', '未知的字符集 %r（可选 %s）' % (charset, ' / '.join(CHARSETS)))
    if charset == 'custom':
        base = []
    elif charset == 'latin':
        base = [chr(c) for c in range(0x20, 0x7F)]
    else:
        base = default_charset(level2=(charset == 'gb2312-2'), latin=True)
    out = []
    seen = set()
    for c in list(base) + list(extra or ''):
        if c in seen or c in '\r\n\t\f\v':
            continue
        seen.add(c)
        out.append(c)
    if charset == 'custom' and not any(not c.isspace() for c in out):
        raise TtfError('bad_input', '自定义字符集需要输入要转换的字符')
    if len(out) > MAX_CHARS:
        raise TtfError('bad_input', '一次最多转换 %d 个字符' % MAX_CHARS)
    return out


# ---------------------------------------------------------------- font file
def sniff_font(data_or_path):
    """-> number of faces. Raises TtfError('bad_font') for non-sfnt data.
    Reads only the header (safe to call on untrusted uploads in the main
    process)."""
    if isinstance(data_or_path, (bytes, bytearray, memoryview)):
        head = bytes(data_or_path[:12])
    else:
        with open(data_or_path, 'rb') as f:
            head = f.read(12)
    tag = head[:4]
    if tag == b'ttcf':
        if len(head) < 12:
            raise TtfError('bad_font', '字体文件已损坏（文件头不完整）')
        n = struct.unpack('>I', head[8:12])[0]
        if not 1 <= n <= 1000:
            raise TtfError('bad_font', '字体集文件已损坏（字体数量 %d）' % n)
        return n
    if tag in (b'\x00\x01\x00\x00', b'OTTO', b'true'):
        return 1
    if tag in (b'wOFF', b'wOF2'):
        raise TtfError('bad_font', '这是 WOFF 网页字体，请先转换成 TTF 或 OTF 再导入')
    if tag == b'typ1' or head[:2] == b'\x80\x01' or head[:2] == b'%!':
        raise TtfError('bad_font', '不支持 PostScript Type 1 字体，请使用 TTF 或 OTF')
    raise TtfError('bad_font', '不是有效的 TTF / OTF / TTC 字体文件')


def open_face(src, face_index=0):
    """fontTools TTFont for one face, with clear errors."""
    from fontTools.ttLib import TTFont
    n = sniff_font(src)
    if not 0 <= face_index < n:
        raise TtfError('bad_input', '字体序号 %d 不存在：这个文件里只有 %d 个字体（序号 0–%d）'
                       % (face_index, n, n - 1), {'faces': n})
    try:
        tt = TTFont(src, fontNumber=face_index if n > 1 else -1, lazy=True)
        _ = tt['head'].unitsPerEm  # force-parse the essentials
        tt.getBestCmap()
    except TtfError:
        raise
    except Exception as e:
        raise TtfError('bad_font', '字体文件已损坏或格式不支持（%s）' % e.__class__.__name__)
    if not tt.getBestCmap():
        raise TtfError('bad_font', '字体里没有 Unicode 字符映射表（cmap），无法转换')
    return tt


def face_names(tt):
    """(family, subfamily) preferring a Chinese localisation."""
    name = tt['name'] if 'name' in tt else None
    if name is None:
        return '', ''

    def pick(ids):
        best = None
        for rec in name.names:
            if rec.nameID not in ids:
                continue
            try:
                s = rec.toUnicode().strip()
            except Exception:
                continue
            if not s:
                continue
            zh = rec.platformID == 3 and rec.langID in (0x804, 0x404, 0xC04, 0x1004, 0x1404)
            en = rec.platformID == 3 and rec.langID == 0x409
            rank = (0 if zh else 1 if en else 2, ids.index(rec.nameID))
            if best is None or rank < best[0]:
                best = (rank, s)
        return best[1] if best else ''
    return pick([16, 1]), pick([17, 2])


def font_display_name(tt, mode, fallback=''):
    fam, sub = face_names(tt)
    fam = fam or fallback or 'font'
    if sub and sub.lower() not in ('regular', 'book', 'normal', 'roman', 'standard', '常规', '標準', '标准'):
        fam = '%s %s' % (fam, sub)
    return fam + (' 手写' if mode == 'skeleton' else ' 空心轮廓')


def _load_cmap(src, face_index=0):
    """cmap of the exact face (kept for the old scripts)."""
    try:
        return open_face(src, face_index).getBestCmap()
    except Exception as e:
        print('warning: cmap unavailable (%s)' % e, file=sys.stderr)
        return None


def _load_pil_font(src, size_px, face_index=0):
    """Strict face loading - never silently substitute another face."""
    from PIL import ImageFont
    try:
        return ImageFont.truetype(src, size_px, index=face_index,
                                  layout_engine=ImageFont.Layout.BASIC)
    except Exception as e:
        raise TtfFaceError('bad_font', '无法打开字体第 %d 号字形集（%s）' % (face_index, e))


# ---------------------------------------------------------------- skeleton
def render_ink(font, ch, pad=6):
    """Render one char into a canvas cropped to its ink (+pad).
    Returns (ink float 0..1, baseline_y, x0): glyph coords = (x - x0, y - baseline_y)."""
    import numpy as np
    from PIL import Image
    from PIL.ImageDraw import Draw
    try:
        bbox = font.getbbox(ch, anchor='ls')     # relative to the baseline origin
    except Exception as e:
        print('warning: render failed for %r: %s' % (ch, e), file=sys.stderr)
        return None, 0, 0
    if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
        return None, 0, 0
    w = bbox[2] - bbox[0] + 2 * pad
    h = bbox[3] - bbox[1] + 2 * pad
    ox, oy = pad - bbox[0], pad - bbox[1]
    img = Image.new('L', (w, h), 0)
    Draw(img).text((ox, oy), ch, fill=255, font=font, anchor='ls')
    arr = np.asarray(img, dtype=np.float32) * (1.0 / 255.0)
    return arr, oy, ox


def _components(mask, pool=False):
    """8-connected components via row runs + union-find (fast in pure Python:
    work is per run, not per pixel). -> [(None, centroid(x,y), bbox(x0,y0,x1,y1))]."""
    import numpy as np
    m = np.asarray(mask, dtype=np.int8)
    if not m.any():
        return []
    sc = 1
    if pool and min(m.shape) >= 32:
        # 2x2 max-pool: 4x fewer runs; only merges blobs closer than ~2 px
        H, W = (m.shape[0] + 1) // 2 * 2, (m.shape[1] + 1) // 2 * 2
        mm = np.zeros((H, W), dtype=np.int8)
        mm[:m.shape[0], :m.shape[1]] = m
        m = mm.reshape(H // 2, 2, W // 2, 2).max(axis=(1, 3))
        sc = 2
    z = np.zeros((m.shape[0], 1), dtype=np.int8)
    d = np.diff(np.concatenate((z, m, z), axis=1), axis=1)
    sy, sx = np.nonzero(d == 1)                 # row-major: sorted by (y, x)
    ex = np.nonzero(d == -1)[1] - 1
    runs = list(zip(sy.tolist(), sx.tolist(), ex.tolist()))   # (y, x0, x1) inclusive
    parent = list(range(len(runs)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a
    prev_lo = prev_hi = 0          # run index range of the previous row
    cur_lo = 0
    cur_y = None
    for k, (y, x0, x1) in enumerate(runs):
        if y != cur_y:
            if cur_y is not None and y == cur_y + 1:
                prev_lo, prev_hi = cur_lo, k
            else:
                prev_lo = prev_hi = k
            cur_lo, cur_y = k, y
            j = prev_lo
        # 8-connectivity: previous-row runs overlapping [x0-1, x1+1]
        while j < prev_hi and runs[j][2] < x0 - 1:
            j += 1
        jj = j
        while jj < prev_hi and runs[jj][1] <= x1 + 1:
            ra, rb = find(jj), find(k)
            if ra != rb:
                parent[rb] = ra
            jj += 1
    comps = {}
    for k, (y, x0, x1) in enumerate(runs):
        r = find(k)
        n = x1 - x0 + 1
        c = comps.get(r)
        if c is None:
            comps[r] = [n, (x0 + x1) * 0.5 * n, y * n, x0, y, x1, y]
        else:
            c[0] += n
            c[1] += (x0 + x1) * 0.5 * n
            c[2] += y * n
            c[3] = min(c[3], x0)
            c[5] = max(c[5], x1)
            c[6] = y
    if sc == 1:
        return [(None, (c[1] / c[0], c[2] / c[0]), (c[3], c[4], c[5], c[6])) for c in comps.values()]
    return [(None, (c[1] / c[0] * 2 + 0.5, c[2] / c[0] * 2 + 0.5),
             (c[3] * 2, c[4] * 2, c[5] * 2 + 1, c[6] * 2 + 1)) for c in comps.values()]


def skeleton_glyph(font, ch, simplify_tol=1.2, min_pts=3, advance=None):
    """Handwriting strokes for one char. Returns (Path|None, advance_px)."""
    from . import image as imgmod
    from .strokes import skeleton_strokes
    if advance is None:
        advance = font.getlength(ch)
    ink, baseline_y, x0 = render_ink(font, ch)
    if ink is None or ink.max() < 0.5:
        # no ink (space, zero-width chars): advance-only glyph
        return None, advance
    skel = imgmod.thin(ink)
    strokes, w = skeleton_strokes(ink, skel)

    _extend_free_ends(strokes, ink, w)
    out = Path()
    for s in strokes:
        c = _rdp(s.coords, simplify_tol) if simplify_tol else s.coords
        if len(c) < 4:                    # < 2 points after simplify
            continue
        out.move_to(c[0] - x0, c[1] - baseline_y)
        for i in range(2, len(c), 2):
            out.line_to(c[i] - x0, c[i + 1] - baseline_y)

    # per-component dot fallback: any ink blob that produced no stroke
    # becomes a small stroke at ITS OWN centroid (i/j/:/! dots survive)
    stroke_boxes = [_path_bbox(s) for s in strokes if s.coords]
    for _comp, (cx, cy), bbox in _components(ink > 0.5, pool=True):
        if not any(_bbox_overlap(bbox, sb) for sb in stroke_boxes):
            out.move_to(cx - 0.5 - x0, cy - 0.5 - baseline_y)
            out.line_to(cx + 0.5 - x0, cy + 0.5 - baseline_y)
    return (out if out.ops else None), advance


def _rdp(flat, eps):
    """Ramer-Douglas-Peucker for a skeleton pixel chain [x0,y0,x1,y1,...].
    Interior points of straight pixel runs are dropped first (vectorised):
    the distance to a line is linear along a segment, so they can never be
    the farthest point; RDP then runs on the few remaining corners."""
    from .geometry import rdp
    n = len(flat) // 2
    if n < 3:
        return list(flat)
    import numpy as np
    P = np.asarray(flat, dtype=np.float64).reshape(-1, 2)
    d = np.diff(P, axis=0)
    turn = np.any(d[1:] != d[:-1], axis=1)
    keep = np.concatenate(([True], turn, [True]))
    return rdp(P[keep].ravel().tolist(), eps)


def _extend_free_ends(strokes, ink, w):
    """Thinning eats about half a stroke width off every free stroke end
    (an 'H' would float above the baseline and under the cap height).
    Extend each FREE end (no other stroke within ~w: not a junction or a
    corner) along its end direction to just inside the ink edge."""
    import numpy as np
    if not strokes:
        return
    pts = [np.asarray(s.coords, dtype=np.float64).reshape(-1, 2) for s in strokes]
    owner = np.concatenate([np.full(len(p), i) for i, p in enumerate(pts)])
    allp = np.concatenate(pts)
    ends = np.array([p[0] for p in pts] + [p[-1] for p in pts])
    eown = np.concatenate([np.arange(len(pts)), np.arange(len(pts))])
    # squared distance of every stroke end to every point of the OTHER strokes
    d2 = ((ends[:, None, :] - allp[None, :, :]) ** 2).sum(axis=2)
    d2[eown[:, None] == owner[None, :]] = np.inf
    free = d2.min(axis=1) >= (0.9 * w) ** 2 if allp.size else np.ones(len(ends), bool)
    h, wd = ink.shape
    reach = 0.75 * w
    back = max(2, int(round(w)))
    S = len(pts)
    for i, s in enumerate(strokes):
        p = pts[i]
        if len(p) < 2:
            continue
        for head in (True, False):
            if not free[i if head else S + i]:
                continue                 # meets another stroke: junction / corner
            ex, ey = (p[0] if head else p[-1]).tolist()
            qx, qy = (p[min(back, len(p) - 1)] if head else p[max(0, len(p) - 1 - back)]).tolist()
            dx, dy = ex - qx, ey - qy
            n = math.hypot(dx, dy)
            if n < 1e-6:
                continue
            dx, dy = dx / n, dy / n
            t = 0.0
            last = None
            while t + 0.5 <= reach:
                t += 0.5
                x, y = ex + dx * t, ey + dy * t
                xi, yi = int(x), int(y)
                if not (0 <= xi < wd and 0 <= yi < h) or ink[yi, xi] < 0.5:
                    break
                last = (float(x), float(y))
            if last is None:
                continue
            c = s.coords
            if head:
                s.coords = [last[0], last[1]] + c
                s.ops = [0, 1] + s.ops[1:]
            else:
                c.extend(last)
                s.ops.append(1)


def _path_bbox(s):
    c = s.coords
    xs = c[0::2]
    ys = c[1::2]
    return (min(xs), min(ys), max(xs), max(ys))


def _bbox_overlap(a, b, tol=3.0):
    return not (a[2] < b[0] - tol or b[2] < a[0] - tol or
                a[3] < b[1] - tol or b[3] < a[1] - tol)


# ---------------------------------------------------------------- outline
def _flat_pen_cls():
    from fontTools.pens.basePen import BasePen

    class FlatPen(BasePen):
        """Flattens quadratic (TrueType) and cubic (CFF) curves into a Path in
        PSF coords (font units, y down, baseline 0). BasePen decomposes
        components through the glyph set and resolves implied on-curve points."""

        def __init__(self, glyph_set, tol):
            super().__init__(glyph_set)
            self.p = Path()
            self.tol = max(0.05, float(tol))
            self._start = None

        def _n(self, *pts):
            L = 0.0
            for a, b in zip(pts, pts[1:]):
                L += math.hypot(b[0] - a[0], b[1] - a[1])
            return max(2, min(64, int(math.ceil(math.sqrt(L / self.tol)))))

        def _moveTo(self, pt):
            self.p.move_to(pt[0], -pt[1])
            self._start = pt

        def _lineTo(self, pt):
            self.p.line_to(pt[0], -pt[1])

        def _curveToOne(self, p1, p2, p3):
            p0 = self._getCurrentPoint()
            n = self._n(p0, p1, p2, p3)
            for i in range(1, n + 1):
                t = i / n
                m = 1.0 - t
                a, b, c, d = m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t
                self.p.line_to(a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                               -(a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))

        def _qCurveToOne(self, p1, p2):
            p0 = self._getCurrentPoint()
            n = self._n(p0, p1, p2)
            for i in range(1, n + 1):
                t = i / n
                m = 1.0 - t
                self.p.line_to(m * m * p0[0] + 2 * m * t * p1[0] + t * t * p2[0],
                               -(m * m * p0[1] + 2 * m * t * p1[1] + t * t * p2[1]))

        def _closePath(self):
            if self._start is not None:
                self.p.line_to(self._start[0], -self._start[1])
            self._start = None

        def _endPath(self):
            self._start = None
    return FlatPen


def outline_glyph(tt, gname, tol=None):
    """Vector outline (closed contours, font units) for one glyph."""
    glyph_set = tt.getGlyphSet()
    if gname not in glyph_set:
        return None
    if tol is None:
        tol = tt['head'].unitsPerEm / 400.0
    pen = _flat_pen_cls()(glyph_set, tol)
    glyph_set[gname].draw(pen)
    p = pen.p
    # drop degenerate subpaths (a lone move_to)
    if sum(1 for op in p.ops if op == 1) < 1:
        return None
    return p


# ---------------------------------------------------------------- convert
def convert_ttf(src, out_psf=None, chars=None, mode='skeleton', size_px=256,
                face_index=0, level2=False, simplify_tol=1.2, name=None,
                spur=None, progress=None):
    """Convert a system font to .psf.

    mode 'skeleton': handwriting strokes (junction-joined, oriented).
    mode 'outline' : closed vector contours via fontTools (laser).
    progress(fraction, message) is called once per glyph; it may raise to
    cancel. The returned StrokeFont carries .missing (requested chars the
    font does not have) and .requested.
    Raises TtfError(code, message) on bad input / no convertible glyph.
    """
    if mode not in MODES:
        raise TtfError('bad_input', '未知的转换模式 %r（skeleton 或 outline）' % (mode,))
    size_px = int(size_px)
    if not 16 <= size_px <= 1024:
        raise TtfError('bad_input', '栅格尺寸应在 16–1024 px 之间')
    face_index = int(face_index or 0)
    tt = open_face(src, face_index)
    cmap = tt.getBestCmap()
    upem = float(tt['head'].unitsPerEm or 1000)
    hmtx = tt['hmtx'] if 'hmtx' in tt else None

    if chars is None:
        chars = default_charset(level2)
    seen = set()
    req = []
    for c in chars:
        if c not in seen and c not in '\r\n\t\f\v':
            seen.add(c)
            req.append(c)
    have = [c for c in req if ord(c) in cmap]
    missing = [c for c in req if ord(c) not in cmap]
    if missing:
        print('cmap filter: %d/%d chars not in font (skipped, no tofu)'
              % (len(missing), len(req)), file=sys.stderr)
    if not [c for c in have if not c.isspace()]:
        raise TtfError('no_glyphs', '这个字体里没有所选的任何字符（缺 %d 个，例如「%s」）'
                       % (len(missing), ''.join(missing[:10])),
                       {'missing_count': len(missing), 'missing': ''.join(missing[:200])})
    if out_psf is None:
        out_psf = os.path.splitext(os.path.basename(src))[0] + \
            ('-hand.psf' if mode == 'skeleton' else '-outline.psf')

    sf = StrokeFont()
    fam, _sub = face_names(tt)
    sf.family = fam or os.path.splitext(os.path.basename(src))[0]
    sf.name = (name or '').strip() or font_display_name(tt, mode, sf.family)
    if mode != 'skeleton' and not any(w in sf.name for w in ('轮廓', '描边', 'outline', 'Outline')):
        sf.name += ' 空心轮廓'          # an outline font writes hollow glyphs: make that visible in the library
    sf.author = 'penplot ttf-' + mode
    sf.type_ordinal = 0 if mode == 'skeleton' else 1
    sf.missing = missing
    sf.requested = len(req)

    if mode == 'skeleton':
        font = _load_pil_font(src, size_px, face_index)
        unit = size_px / upem                # font units -> px
        sf.size = round(size_px * EM_TO_SIZE, 3)
    else:
        font = None
        unit = 1.0                           # outline stays in font units
        sf.size = round(upem * EM_TO_SIZE, 3)
        tol = max(0.2, float(simplify_tol or 0)) * upem / 400.0

    def adv_of(ch):
        g = cmap.get(ord(ch))
        if hmtx is not None and g is not None:
            try:
                return hmtx[g][0] * unit
            except KeyError:
                pass
        return font.getlength(ch) if font is not None else upem * 0.5

    n = len(have)
    for i, ch in enumerate(have):
        if progress is not None and (i % 4 == 0):
            progress(0.02 + 0.96 * i / max(1, n), '%d / %d 字' % (i, n))
        code = ord(ch)
        adv = adv_of(ch)
        if mode == 'skeleton':
            p, adv = skeleton_glyph(font, ch, simplify_tol=simplify_tol, advance=adv)
        else:
            p = outline_glyph(tt, cmap[code], tol)
        sf.glyphs[code] = StrokeGlyph(code, p.coords if p else [], p.ops if p else [],
                                      advance=round(float(adv), 4))   # survives write_psf's %.9g
    if not any(g.ops for g in sf.glyphs.values()):
        raise TtfError('no_glyphs', '没有转换出任何笔画（字体里可能只有空白字形）')
    if progress is not None:
        progress(0.99, '写入字体文件')
    write_psf(sf, out_psf)
    return sf
