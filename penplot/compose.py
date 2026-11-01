# -*- coding: utf-8 -*-
"""Project rendering: Project.doc (pages -> elements) -> per-page toolpaths
and G-code (03 §3.3). Pure functions of JSON-like data plus a resolver, so
they run in a task child process.

Coordinate chain: element-local mm -> transform -> page mm (y down) ->
ordering (page space) -> export_transform_mm (OriginSpec) -> machine mm ->
generate_gcode (no re-ordering, so preview order == G-code order).
"""
import collections
import hashlib
import json
import os
import math
import random
import re
import struct
import sys
import zlib
from array import array

from .gcode import analyze_gcode, generate_gcode, optimize_paths, parse_gcode, split_paths
from .geometry import Path, bbox_of, translate_all
from .layout import (FontsSet, LineAlign, PageInfo, ParagraphFormat, TextDocument,
                     check_bounds, export_transform_mm)

ALIGN = {'L': LineAlign.LEFT, 'C': LineAlign.CENTER, 'R': LineAlign.RIGHT, 'D': LineAlign.DISPERSE}
_VAR = re.compile(r'\{\{\s*([^{}\s]+)\s*\}\}')


class ComposeError(Exception):
    def __init__(self, code, message, detail=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


def substitute(text, variables):
    if not text or '{{' not in text:
        return text
    return _VAR.sub(lambda m: str(variables.get(m.group(1), m.group(0))), text)


# ---------------------------------------------------------------- resolver
_FONT_LRU = collections.OrderedDict()   # (path, mtime, size) -> font; per process
_FONT_LRU_MAX = 8


def _load_font_cached(path):
    """Fonts are immutable once loaded (layout copies glyph coords), so a
    long-lived task worker keeps the last few in memory: a big .gfont costs
    ~2 s to open on the A53, a cache hit costs nothing."""
    import os
    from .psf import load_font
    try:
        st = os.stat(path)
        key = (path, st.st_mtime_ns, st.st_size)
    except OSError:
        return load_font(path)
    f = _FONT_LRU.get(key)
    if f is not None:
        _FONT_LRU.move_to_end(key)
        return f
    f = load_font(path)
    _FONT_LRU[key] = f
    while len(_FONT_LRU) > _FONT_LRU_MAX:
        _FONT_LRU.popitem(last=False)
    return f


class Resolver:
    """Maps ids to loaded objects. fonts: {font_id: path}; files: {file_id: path}."""

    def __init__(self, fonts=None, files=None, default_font=None, cache_dir=None, progress=None):
        self.fonts = fonts or {}
        self.files = files or {}
        self.default_font = default_font
        self.cache_dir = cache_dir      # element path cache (03 §3.3), None = off
        self.progress = progress        # sub-progress of the element being built
        self._cache = {}

    def font(self, font_id):
        fid = font_id or self.default_font
        if fid in self._cache:
            return self._cache[fid]
        path = self.fonts.get(fid) if fid else None
        if path is None:
            if fid and fid not in ('penplot-sans', 'builtin'):
                raise ComposeError('font_not_found', '字体不存在：%s' % fid, {'font_id': fid})
            from .builtin_font import load_builtin
            f = load_builtin()
        else:
            f = _load_font_cached(path)
        self._cache[fid] = f
        return f

    def file(self, file_id):
        p = self.files.get(file_id)
        if not p:
            raise ComposeError('file_not_found', '文件不存在：%s' % file_id, {'file_id': file_id})
        return p


# ---------------------------------------------------------------- papers
def paper_dims(paper):
    """(w, h) after orientation."""
    w, h = float(paper['width_mm']), float(paper['height_mm'])
    if paper.get('orientation') == 'landscape':
        w, h = h, w
    return w, h


def page_info(paper, line_num=None):
    w, h = paper_dims(paper)
    m = paper.get('margins') or {}
    r = paper.get('ruling') or {}
    return PageInfo(pageWidth=w, pageHeight=h, leftGap=m.get('l', 0.0), rightGap=m.get('r', 0.0),
                    topGap=m.get('t', 0.0), bottomGap=m.get('b', 0.0),
                    lineNum=int(line_num or r.get('line_num') or 20),
                    lineGap=r.get('line_gap', 0.0), lineGapOffset=r.get('line_gap_offset', 0.0),
                    baseLine=r.get('base_line', 1.0), rotation=0.0)


# ---------------------------------------------------------------- elements
def _fonts_set(jitter):
    j = dict(jitter or {})
    return FontsSet(**{k: v for k, v in j.items() if v is not None})


def _seed(props, eid):
    s = props.get('seed')
    if s is None:
        return zlib.crc32(str(eid).encode('utf-8'))
    return int(s)


def _font_mix(props, res):
    mix = props.get('font_mix')
    if not mix:
        return None
    out = [(res.font(m['font_id']), float(m.get('weight', 1.0))) for m in mix if m.get('font_id')]
    return out or None


def flow_text_pages(el, paper, res, variables, settings, warn):
    """-> list of path lists (page mm, y down), one per laid-out page."""
    pr = el.get('props') or {}
    text = substitute(pr.get('text', ''), variables)
    page = page_info(paper, pr.get('line_num'))
    mix = _font_mix(pr, res)
    font = mix[0][0] if mix else res.font(pr.get('font_id'))
    doc = TextDocument(page, font, _fonts_set(pr.get('jitter')), settings=settings,
                       rng=random.Random(_seed(pr, el.get('id'))),
                       text_size=float(pr.get('text_size', 1.0)),
                       char_space=float(pr.get('char_space', 0.0)), font_mix=mix)
    doc.missing_glyph = pr.get('missing_glyph', 'box')
    para = pr.get('paragraph') or {}
    fmt = ParagraphFormat(int(para.get('spe_type', 0)), float(para.get('spe_value', 0.0)),
                          float(para.get('left', 0.0)), float(para.get('right', 0.0)))
    align = ALIGN.get(pr.get('align', 'L'), LineAlign.LEFT)
    pages = doc.layout(text, fmt)
    k = 25.4 / settings.dpi
    out = []
    for pi in range(len(pages)):
        ents = doc.entities(text, align=align, fmt=fmt, page_index=pi)
        for p in ents:
            c = p.coords
            for i in range(len(c)):
                c[i] = c[i] * k
        out.append(ents)
    warn['missing'] |= doc.missing
    return out or [[]]


def text_box_paths(el, res, variables, settings, warn):
    pr = el.get('props') or {}
    text = substitute(pr.get('text', ''), variables)
    size = float(pr.get('size_mm', 8.0))
    lh = float(pr.get('line_height', 1.3))
    pitch = size * lh
    box = pr.get('box') or None
    nlines = text.count('\n') + 1
    if box and box.get('w'):
        width = float(box['w'])
        lines = max(1, int(math.floor(float(box.get('h') or pitch * nlines) / pitch + 1e-9)))
    else:
        width = 100000.0
        lines = nlines
    page = PageInfo(pageWidth=width, pageHeight=lines * pitch, leftGap=0, rightGap=0, topGap=0,
                    bottomGap=0, lineNum=lines, rotation=0.0)
    mix = _font_mix(pr, res)
    font = mix[0][0] if mix else res.font(pr.get('font_id'))
    doc = TextDocument(page, font, _fonts_set(pr.get('jitter')), settings=settings,
                       rng=random.Random(_seed(pr, el.get('id'))), text_size=1.0 / lh,
                       char_space=float(pr.get('char_space', 0.0)), font_mix=mix)
    doc.missing_glyph = pr.get('missing_glyph', 'box')
    align = ALIGN.get(pr.get('align', 'L'), LineAlign.LEFT)
    pages = doc.layout(text)
    if len(pages) > 1:
        warn['overflow'] = True
    ents = doc.entities(text, align=align, page_index=0) if pages else []
    k = 25.4 / settings.dpi
    for p in ents:
        c = p.coords
        for i in range(len(c)):
            c[i] = c[i] * k
    warn['missing'] |= doc.missing
    return ents


def _normalize_top_left(paths):
    bb = bbox_of(paths)
    if bb is not None and (bb[0] or bb[1]):
        translate_all(paths, -bb[0], -bb[1])
    return bb


def _scale_to_width(paths, width_mm):
    bb = bbox_of(paths)
    if not width_mm or bb is None:
        return
    w = bb[2] - bb[0]
    if w <= 0:
        return
    k = float(width_mm) / w
    for p in paths:
        c = p.coords
        for i in range(len(c)):
            c[i] *= k


def image_paths(el, res):
    pr = el.get('props') or {}
    try:
        from . import image as im
    except ImportError:
        raise ComposeError('feature_unavailable', '图片描摹需要 numpy/pillow', {'feature': 'image'})
    return trace_image(res.file(pr['file_id']), pr, im, cache_dir=getattr(res, 'cache_dir', None),
                       progress=getattr(res, 'progress', None))


# ---------------------------------------------------------------- image trace (+ cache)
TRACE_VERSION = 2          # bump when the trace algorithm changes (invalidates caches)
TRACE_DEFAULTS = {'mode': 'edge', 'width_mm': 80.0, 'invert': False, 'th_low': 0.10, 'th_high': 0.25,
                  'blur': 1.4, 'binarize': 0.5, 'min_len': 6, 'simplify': 0.6, 'spacing_mm': 1.2,
                  'gamma': 1.0, 'max_px': 1200, 'px_per_mm': 8.0}
TRACE_MAX_PX = 4000        # absolute ceiling even when the user asks for more


def trace_params(pr):
    """Normalised trace parameters (defaults filled, types coerced)."""
    out = {}
    for k, d in TRACE_DEFAULTS.items():
        v = (pr or {}).get(k)
        if v is None:
            v = d
        if isinstance(d, bool):
            v = bool(v)
        elif isinstance(d, int):
            v = int(v)
        elif isinstance(d, float):
            v = float(v)
        out[k] = v
    out['max_px'] = max(16, min(TRACE_MAX_PX, out['max_px']))
    return out


def _file_ident(path):
    st = os.stat(path)
    return [os.path.basename(path), st.st_size, st.st_mtime_ns]


def trace_key(path, p, work_px):
    """Cache key: file identity + the params that affect the px-space trace
    + working resolution. width_mm is NOT part of it for line modes (output
    is scaled afterwards), so resizing the element reuses the trace as long
    as the working resolution bucket is unchanged."""
    keys = {'edge': ('invert', 'th_low', 'th_high', 'blur', 'min_len', 'simplify'),
            'skeleton': ('invert', 'binarize', 'min_len', 'simplify'),
            'dots': ('invert', 'spacing_mm', 'gamma', 'width_mm')}.get(p['mode'], ())
    k = {'v': TRACE_VERSION, 'f': _file_ident(path), 'mode': p['mode'], 'px': work_px}
    k.update({n: p[n] for n in keys})
    return hashlib.sha256(json.dumps(k, sort_keys=True).encode('utf-8')).hexdigest()[:32]


def _cache_get(cache_dir, key):
    if not cache_dir:
        return None
    fn = os.path.join(cache_dir, key + '.bin')
    try:
        with open(fn, 'rb') as f:
            data = f.read()
        os.utime(fn)                   # LRU touch
        return data
    except OSError:
        return None


def _cache_put(cache_dir, key, data):
    if not cache_dir:
        return
    try:
        os.makedirs(cache_dir, exist_ok=True)
        tmp = os.path.join(cache_dir, '.%s.%d.tmp' % (key, os.getpid()))
        with open(tmp, 'wb') as f:
            f.write(data)
        os.replace(tmp, os.path.join(cache_dir, key + '.bin'))
    except OSError:
        pass


def prune_cache_dir(cache_dir, limit_bytes):
    """LRU (mtime) prune of a flat cache directory."""
    try:
        ents = []
        for n in os.listdir(cache_dir):
            fn = os.path.join(cache_dir, n)
            st = os.stat(fn)
            ents.append((st.st_mtime, st.st_size, fn))
    except OSError:
        return
    total = sum(e[1] for e in ents)
    for _mt, size, fn in sorted(ents):
        if total <= limit_bytes:
            break
        try:
            os.unlink(fn)
            total -= size
        except OSError:
            pass


def trace_image_px(path, p, im, work, progress=None):
    """-> (polylines as (n,2) px arrays, working image width px)."""
    if progress:
        progress(0.05, '读取图片')
    ink = im.load_gray(path, invert=p['invert'], max_px=work)
    img_w = ink.shape[1]
    if progress:
        progress(0.2, '描摹中')
    if p['mode'] == 'skeleton':
        mask = im.zhang_suen(ink > p['binarize'])
        if progress:
            progress(0.5, '提取路径')
        polys = im.trace_lines(mask, min_points=p['min_len'])
    else:
        polys = im.canny_lines(ink, low=p['th_low'], high=p['th_high'], sigma=p['blur'],
                               min_points=p['min_len'])
    if progress:
        progress(0.75, '简化路径')
    if p['simplify'] > 0:
        polys = [im.rdp_xy(a, p['simplify']) for a in polys]
    return polys, img_w


def _dot_paths(xs, ys, vals, k, r, step=0.7):
    """Dots -> small closed ellipses (same vertices as Path.ellipse)."""
    import numpy as np
    ts = []
    t = 0.0
    while t <= 2.0 * math.pi:
        ts.append(t)
        if t != 2.0 * math.pi and t + step > 2.0 * math.pi:
            t = 2.0 * math.pi
            continue
        t += step
    if not xs:
        return []
    ts = np.array(ts)
    rr = r * (0.3 + 0.7 * np.asarray(vals, dtype=np.float64))
    cx = np.asarray(xs, dtype=np.float64) * k
    cy = np.asarray(ys, dtype=np.float64) * k
    pts = np.empty((len(xs), len(ts), 2))
    pts[:, :, 0] = cx[:, None] + np.cos(ts)[None, :] * rr[:, None]
    pts[:, :, 1] = cy[:, None] + np.sin(ts)[None, :] * rr[:, None]
    ops = [0] + [1] * (len(ts) - 1)
    return [Path(c, ops) for c in pts.reshape(len(xs), -1).tolist()]


def trace_image(path, pr, im=None, cache_dir=None, progress=None):
    """Image file -> paths in element-local mm (y down, top-left origin).

    The px-space trace is cached in `cache_dir` (keyed by file identity,
    trace params and working resolution), so re-rendering a page or moving /
    scaling the element never re-traces."""
    if im is None:
        from . import image as im
    p = trace_params(pr)
    width_mm = p['width_mm']
    if p['mode'] == 'dots':
        try:
            w0, h0 = im.image_size(path)
        except Exception as e:
            raise ComposeError('bad_image', '无法读取图片：%s' % e)
        work = im.working_px(w0, h0, width_mm, max(p['px_per_mm'], 2.0 / max(p['spacing_mm'], 0.05)),
                             p['max_px'])
        key = trace_key(path, p, work)
        data = _cache_get(cache_dir, key)
        if data is not None:
            return decode_paths(data)
        ink = im.load_gray(path, invert=p['invert'], max_px=work)
        img_w = ink.shape[1]
        spacing_px = max(1, int(round(p['spacing_mm'] / width_mm * img_w)))
        xs, ys, vals = im.halftone_dots(ink, spacing_px, gamma=p['gamma'])
        paths = _dot_paths(xs, ys, vals, width_mm / img_w, p['spacing_mm'] * 0.35)
        _cache_put(cache_dir, key, encode_paths(paths))
        return paths
    try:
        w0, h0 = im.image_size(path)
    except Exception as e:
        raise ComposeError('bad_image', '无法读取图片：%s' % e)
    work = im.working_px(w0, h0, width_mm, p['px_per_mm'], p['max_px'])
    key = trace_key(path, p, work)
    data = _cache_get(cache_dir, key)
    if data is not None:
        img_w = struct.unpack_from('<f', data, 0)[0]
        paths = decode_paths(data[4:])
    else:
        polys, img_w = trace_image_px(path, p, im, work, progress)
        paths = im.arrays_to_paths(polys)
        _cache_put(cache_dir, key, struct.pack('<f', float(img_w)) + encode_paths(paths))
    if progress:
        progress(0.9, '缩放')
    k = width_mm / float(img_w)
    for q in paths:
        q.coords = [v * k for v in q.coords]
    return paths


def _svg_font_for(pr, res):
    """SVG font-family list -> stroke font: text_font_map (family names,
    case-insensitive, first listed family that is mapped wins) -> text_font_id
    -> app default font."""
    from .importers.svg_text import norm_family
    fmap = {norm_family(k): v for k, v in (pr.get('text_font_map') or {}).items() if v}

    def font_for(families):
        for fam in families:
            fid = fmap.get(norm_family(fam))
            if fid:
                return res.font(fid)
        return res.font(pr.get('text_font_id'))
    return font_for


def _svg_text_opts(el, pr, res, warn):
    mode = pr.get('text_mode') or 'font'
    if mode == 'skip':
        return {'mode': 'skip'}
    jit = pr.get('text_jitter')
    seed = pr.get('text_seed')
    return {'mode': mode, 'font_for': _svg_font_for(pr, res),
            'size_scale': float(pr.get('text_size_scale') or 1.0),
            'fonts_set': _fonts_set(jit) if jit else None,
            'rng': random.Random(zlib.crc32(str(el.get('id')).encode('utf-8')) if seed is None else int(seed)),
            'missing': warn['missing'] if warn is not None else set(),
            'messages': warn['messages'] if warn is not None else [],
            'missing_glyph': pr.get('missing_glyph') or 'box'}


def vector_paths(el, res, kind, warn=None):
    pr = el.get('props') or {}
    path = res.file(pr['file_id'])
    if kind == 'svg':
        from .importers.svg import load_svg
        paths, _info = load_svg(path, tol_mm=float(pr.get('flatten_tol_mm', 0.1)),
                                layers=pr.get('layers'), stroke_filter=pr.get('stroke_filter'),
                                units=pr.get('units') or 'auto', text=_svg_text_opts(el, pr, res, warn))
    else:
        from .importers.dxf import load_dxf
        paths, _info = load_dxf(path, tol_mm=float(pr.get('flatten_tol_mm', 0.1)),
                                layers=pr.get('layers'), units=pr.get('units') or 'auto')
    _normalize_top_left(paths)
    if pr.get('width_mm'):
        _scale_to_width(paths, pr['width_mm'])
    return paths


def gcode_paths(el, res, mc):
    pr = el.get('props') or {}
    with open(res.file(pr['file_id']), encoding='utf-8', errors='replace') as f:
        text = f.read()
    paths = parse_gcode(text, mc)
    for p in paths:
        c = p.coords
        for i in range(1, len(c), 2):
            c[i] = -c[i]
    _normalize_top_left(paths)
    return paths


def shape_paths(el):
    pr = el.get('props') or {}
    kind = pr.get('kind', 'rect')
    w, h = float(pr.get('w', 20.0)), float(pr.get('h', 20.0))
    out = []
    if kind == 'rect':
        p = Path()
        p.rect(0.0, 0.0, w, h)
        out.append(p)
    elif kind == 'ellipse':
        p = Path()
        rx, ry = w / 2.0, h / 2.0
        n = max(24, int(math.pi * (rx + ry) / 1.0))
        p.ellipse(rx, ry, rx, ry, 2 * math.pi / n)
        out.append(p)
    elif kind in ('line', 'polygon'):
        pts = pr.get('points') or [[0, 0], [w, h]]
        p = Path()
        p.move_to(float(pts[0][0]), float(pts[0][1]))
        for q in pts[1:]:
            p.line_to(float(q[0]), float(q[1]))
        if kind == 'polygon' and pr.get('closed', True):
            p.line_to(float(pts[0][0]), float(pts[0][1]))
        out.append(p)
    elif kind == 'grid':
        rows, cols = max(1, int(pr.get('rows', 1))), max(1, int(pr.get('cols', 1)))
        cw, ch = w / cols, h / rows
        for r in range(rows + 1):
            p = Path()
            p.move_to(0.0, r * ch)
            p.line_to(w, r * ch)
            out.append(p)
        for c in range(cols + 1):
            p = Path()
            p.move_to(c * cw, 0.0)
            p.line_to(c * cw, h)
            out.append(p)
        style = pr.get('grid_style', 'plain')
        if style in ('tian', 'mi'):
            for r in range(rows):
                for c in range(cols):
                    x0, y0 = c * cw, r * ch
                    segs = [((x0 + cw / 2, y0), (x0 + cw / 2, y0 + ch)),
                            ((x0, y0 + ch / 2), (x0 + cw, y0 + ch / 2))]
                    if style == 'mi':
                        segs += [((x0, y0), (x0 + cw, y0 + ch)), ((x0 + cw, y0), (x0, y0 + ch))]
                    for a, b in segs:
                        p = _dashed(a, b, 1.5, 1.5)
                        out.extend(p)
    hatch = pr.get('hatch')
    if hatch and kind in ('rect', 'ellipse'):
        out.extend(_hatch(kind, w, h, float(hatch.get('angle', 45.0)), float(hatch.get('spacing', 2.0))))
    return out


def _dashed(a, b, dash, gap):
    (x0, y0), (x1, y1) = a, b
    L = math.hypot(x1 - x0, y1 - y0)
    out = []
    t = 0.0
    while t < L:
        e = min(L, t + dash)
        p = Path()
        p.move_to(x0 + (x1 - x0) * t / L, y0 + (y1 - y0) * t / L)
        p.line_to(x0 + (x1 - x0) * e / L, y0 + (y1 - y0) * e / L)
        out.append(p)
        t = e + gap
    return out


def _hatch(kind, w, h, angle, spacing):
    """Parallel lines clipped to a rect/ellipse, serpentine order."""
    if spacing <= 0.05:
        spacing = 0.05
    a = math.radians(angle)
    dx, dy = math.cos(a), math.sin(a)          # line direction
    nx, ny = -dy, dx                            # normal
    cx, cy = w / 2.0, h / 2.0
    R = math.hypot(w, h) / 2.0
    out = []
    k = 0
    s = -R
    while s <= R:
        px, py = cx + nx * s, cy + ny * s
        ts = []
        if kind == 'rect':
            lo, hi = -1e9, 1e9
            ok = True
            for o, d, mn, mx in ((px, dx, 0.0, w), (py, dy, 0.0, h)):
                if abs(d) < 1e-12:
                    if o < mn or o > mx:
                        ok = False
                else:
                    t0, t1 = (mn - o) / d, (mx - o) / d
                    lo, hi = max(lo, min(t0, t1)), min(hi, max(t0, t1))
            if ok and lo < hi:
                ts = [lo, hi]
        else:
            rx, ry = w / 2.0, h / 2.0
            ox, oy = (px - cx) / rx, (py - cy) / ry
            ddx, ddy = dx / rx, dy / ry
            A = ddx * ddx + ddy * ddy
            B = 2 * (ox * ddx + oy * ddy)
            C = ox * ox + oy * oy - 1
            disc = B * B - 4 * A * C
            if disc > 0:
                r = math.sqrt(disc)
                ts = [(-B - r) / (2 * A), (-B + r) / (2 * A)]
        if ts:
            t0, t1 = ts if k % 2 == 0 else (ts[1], ts[0])
            p = Path()
            p.move_to(px + dx * t0, py + dy * t0)
            p.line_to(px + dx * t1, py + dy * t1)
            out.append(p)
            k += 1
        s += spacing
    return out


def apply_transform(paths, tr):
    if not tr:
        return paths
    x, y = float(tr.get('x', 0.0)), float(tr.get('y', 0.0))
    sc = float(tr.get('scale', 1.0))
    sx, sy = sc * float(tr.get('sx', 1.0)), sc * float(tr.get('sy', 1.0))
    rot = float(tr.get('rotation', 0.0))
    if sx == 1.0 and sy == 1.0 and rot == 0.0:
        if x or y:
            translate_all(paths, x, y)
        return paths
    r = math.radians(rot)
    cs, sn = math.cos(r), math.sin(r)
    for p in paths:
        c = p.coords
        for i in range(0, len(c), 2):
            px, py = c[i] * sx, c[i + 1] * sy
            c[i] = px * cs - py * sn + x
            c[i + 1] = px * sn + py * cs + y
    return paths


# ---------------------------------------------------------------- pages
class RenderedPage:
    __slots__ = ('index', 'source_page', 'width_mm', 'height_mm', 'page_paths', 'machine_paths',
                 'gcode', 'analysis', 'bbox', 'machine_bbox', 'out_of_work_area', 'warnings',
                 'origin', 'bounds')

    def info(self):
        a = self.analysis
        return {'index': self.index, 'source_page': self.source_page,
                'width_mm': self.width_mm, 'height_mm': self.height_mm,
                'stats': {'draw_mm': round(a.draw_mm, 1), 'travel_mm': round(a.travel_mm, 1),
                          'pen_lifts': a.pen_lifts, 'strokes': len(self.page_paths)},
                'bbox': _r(self.bbox), 'machine_bbox': _r(self.machine_bbox),
                'est_s': round(a.est_s, 1), 'gcode_lines': a.lines,
                'out_of_work_area': self.out_of_work_area, 'warnings': self.warnings}


def _r(bb):
    return [round(v, 3) for v in bb] if bb else None


# ---------------------------------------------------------------- element cache
ELEMENT_CACHE_VERSION = 1


def _jsonable(o):
    d = getattr(o, '__dict__', None)
    if d is not None:
        return d
    slots = getattr(o, '__slots__', None)
    if slots:
        return {k: getattr(o, k, None) for k in slots}
    if isinstance(o, (set, frozenset)):
        return sorted(o, key=str)
    return str(o)


def _font_idents(pr, res):
    ids = [pr.get('font_id')] + [m.get('font_id') for m in pr.get('font_mix') or []]
    out = []
    for fid in ids:
        fid = fid or res.default_font
        path = res.fonts.get(fid) if fid else None
        try:
            out.append(_file_ident(path) if path else 'builtin:%s' % fid)
        except OSError:
            out.append('missing:%s' % fid)
    return out


_SVG_TEXT = {}     # file ident -> has <text> (per process)


def _svg_has_text(path):
    try:
        ident = tuple(_file_ident(path))
    except OSError:
        return True
    v = _SVG_TEXT.get(ident)
    if v is None:
        from .importers.svg import _HAS_TEXT
        try:
            with open(path, 'rb') as f:
                v = bool(_HAS_TEXT.search(f.read()))
        except OSError:
            v = True
        if len(_SVG_TEXT) > 256:
            _SVG_TEXT.clear()
        _SVG_TEXT[ident] = v
    return v


def _svg_font_idents(pr, res):
    """Identity (name, size, mtime) of every font an svg element's text may use."""
    ids = [pr.get('text_font_id')] + sorted(v for v in (pr.get('text_font_map') or {}).values() if v)
    return _font_idents({'font_id': ids[0], 'font_mix': [{'font_id': f} for f in ids[1:]]}, res)


def _cached_element(res, kind, keyobj, build, warn):
    """element -> paths (element-local mm) through the on-disk element cache
    `res.cache_dir/<hash>.bin` (transform is not part of the key). The
    result always goes through the float32 blob, so a hit and a miss
    produce byte-identical G-code."""
    cd = getattr(res, 'cache_dir', None)
    if not cd:
        return build(warn)
    try:
        raw = json.dumps({'v': ELEMENT_CACHE_VERSION, 't': kind, 'k': keyobj}, sort_keys=True,
                         default=_jsonable)
    except (TypeError, ValueError):
        return build(warn)
    key = 'el-' + hashlib.sha256(raw.encode('utf-8')).hexdigest()[:32]
    data = _cache_get(cd, key)
    if data is not None:
        try:
            n = struct.unpack_from('<I', data, 0)[0]
            meta = json.loads(data[4:4 + n].decode('utf-8'))
            paths = decode_paths(data[4 + n:])
            warn['missing'] |= set(meta.get('missing') or [])
            if meta.get('overflow'):
                warn['overflow'] = True
            for m in meta.get('messages') or []:
                if m not in warn['messages']:
                    warn['messages'].append(m)
            return paths
        except (ValueError, struct.error, UnicodeDecodeError):
            pass
    w = {'missing': set(), 'overflow': False, 'messages': []}
    paths = build(w)
    warn['missing'] |= w['missing']
    warn['overflow'] = warn.get('overflow') or w['overflow']
    for m in w['messages']:
        if m not in warn['messages']:
            warn['messages'].append(m)
    meta = json.dumps({'missing': sorted(w['missing']), 'overflow': bool(w['overflow']),
                       'messages': w['messages']}).encode('utf-8')
    blob = encode_paths(paths)
    _cache_put(cd, key, struct.pack('<I', len(meta)) + meta + blob)
    return decode_paths(blob)


def _element_paths(el, paper, res, variables, mc, warn):
    t = el.get('type')
    pr = el.get('props') or {}
    if t == 'text':
        key = {'props': pr, 'text': substitute(pr.get('text', ''), variables), 'id': el.get('id'),
               'fonts': _font_idents(pr, res), 'settings': mc.settings}
        return _cached_element(res, t, key, lambda w: text_box_paths(el, res, variables, mc.settings, w),
                               warn)
    if t == 'image':
        return image_paths(el, res)
    if t in ('svg', 'dxf'):
        fpath = res.file(pr.get('file_id'))
        key = {'props': pr, 'f': _file_ident(fpath)}
        if t == 'svg' and (pr.get('text_mode') or 'font') == 'font' and _svg_has_text(fpath):
            key['fonts'] = _svg_font_idents(pr, res)
            if pr.get('text_seed') is None and pr.get('text_jitter'):
                key['id'] = el.get('id')
        return _cached_element(res, t, key, lambda w: vector_paths(el, res, t, w), warn)
    if t == 'shape':
        return shape_paths(el)
    if t == 'gcode':
        key = {'props': pr, 'f': _file_ident(res.file(pr.get('file_id'))), 'mc': mc}
        return _cached_element(res, t, key, lambda w: gcode_paths(el, res, mc), warn)
    raise ComposeError('bad_element', '未知元素类型：%s' % t)


def compose_pages(doc, papers, res, mc, variables=None, page_filter=None, progress=None):
    """-> list of (source_page, paper, [paths page mm]). papers: resolved
    paper dict per doc page. flow_text overflow adds pages after its page."""
    variables = dict(variables or {})
    for v in doc.get('variables') or []:
        variables.setdefault(v['name'], v.get('default', ''))
    out = []
    pages = doc.get('pages') or []
    for pi, page in enumerate(pages):
        if page_filter is not None and pi not in page_filter:
            continue
        paper = papers[pi]
        warn = {'missing': set(), 'overflow': False, 'messages': []}
        base = []
        extra = []        # overflow pages from flow_text
        els = sorted([e for e in page.get('elements') or [] if not e.get('hidden')],
                     key=lambda e: e.get('z', 0))
        for ei, el in enumerate(els):
            if el.get('type') == 'flow_text':
                fps = flow_text_pages(el, paper, res, variables, mc.settings, warn)
                for k, fp in enumerate(fps):
                    apply_transform(fp, el.get('transform'))
                    if k == 0:
                        base.extend(fp)
                    else:
                        while len(extra) < k:
                            extra.append([])
                        extra[k - 1].extend(fp)
            else:
                if progress:
                    lo = (pi + ei / max(1, len(els))) / max(1, len(pages)) * 0.6
                    hi = (pi + (ei + 1) / max(1, len(els))) / max(1, len(pages)) * 0.6
                    res.progress = lambda f, m='', lo=lo, hi=hi: progress(lo + (hi - lo) * f, m)
                try:
                    ps = _element_paths(el, paper, res, variables, mc, warn)
                finally:
                    res.progress = None
                base.extend(apply_transform(ps, el.get('transform')))
            if progress:
                progress((pi + (ei + 1) / max(1, len(els))) / max(1, len(pages)) * 0.6)
        for k, paths in enumerate([base] + extra):
            out.append((pi, paper, paths, warn))
    return out


def finish_page(index, source_page, paper, paths, warn, mc, origin, work_area, opts):
    """Ordering, machine transform, G-code, analysis for one output page."""
    w, h = paper_dims(paper)
    pl = opts.get('placement') or {}
    if pl.get('dx_mm') or pl.get('dy_mm'):
        translate_all(paths, float(pl.get('dx_mm') or 0.0), float(pl.get('dy_mm') or 0.0))
    tol = float(opts.get('simplify') or 0.0)
    if tol > 0:
        for p in paths:
            p.rdp_simplify(tol)
    copies = int(opts.get('copies') or 1)
    mode = opts.get('copy_mode') or 'repeat_same'
    if copies > 1 and mode in ('tile_x', 'tile_y'):
        bb = bbox_of(paths)
        if bb:
            gap = float(opts.get('copy_gap_mm') or 10.0)
            base = [p.clone() for p in paths]
            for n in range(1, copies):
                cp = [p.clone() for p in base]
                if mode == 'tile_x':
                    translate_all(cp, n * (bb[2] - bb[0] + gap), 0.0)
                else:
                    translate_all(cp, 0.0, n * (bb[3] - bb[1] + gap))
                paths.extend(cp)
    if opts.get('optimize'):
        ordered = optimize_paths(split_paths([p.clone() for p in paths]), mc.settings.nearDst)
    else:
        ordered = []
        for p in paths:
            ordered.extend(p.subpaths())
    ordered = [p for p in ordered if p.ops]
    machine = [p.clone() for p in ordered]
    export_transform_mm(machine, w, h, origin, machine_type=mc.type)
    g = generate_gcode(machine, mc, optimize=False)
    a = analyze_gcode(g, mc, keep_arrays=False)
    rp = RenderedPage()
    rp.index, rp.source_page = index, source_page
    rp.width_mm, rp.height_mm = w, h
    rp.page_paths, rp.machine_paths = ordered, machine
    rp.gcode, rp.analysis = g, a
    rp.bbox = bbox_of(ordered)
    rp.machine_bbox = bbox_of(machine)
    rp.origin = origin
    clipped = bool(rp.bbox and (rp.bbox[0] < -0.5 or rp.bbox[1] < -0.5 or rp.bbox[2] > w + 0.5
                                or rp.bbox[3] > h + 0.5))
    bad = check_bounds(rp.machine_bbox, work_area[0], work_area[1], origin) if work_area else []
    rp.bounds = bad
    rp.out_of_work_area = bool(bad)
    msgs = list(warn.get('messages') or [])
    if bad:
        msgs.append('超出工作区：%s' % ', '.join(bad))
    rp.warnings = {'missing_glyphs': sorted(warn['missing']), 'clipped': clipped,
                   'overflow': bool(warn.get('overflow')), 'messages': msgs}
    return rp


def render_document(doc, papers, res, mc, origin=None, work_area=None, opts=None,
                    variables=None, page_filter=None, progress=None):
    """Full render. Returns [RenderedPage]. opts: optimize, simplify, copies,
    copy_mode, copy_gap_mm, multi_page."""
    opts = opts or {}
    composed = compose_pages(doc, papers, res, mc, variables, page_filter, progress)
    if opts.get('multi_page') == 'first_only':
        composed = composed[:1]
    out = []
    n = max(1, len(composed))
    for i, (src, paper, paths, warn) in enumerate(composed):
        origin_i = origin
        pg = (doc.get('pages') or [])[src] if src < len(doc.get('pages') or []) else {}
        if pg.get('origin'):
            origin_i = pg['origin']
        out.append(finish_page(i, src, paper, paths, warn, mc, origin_i, work_area, opts))
        if progress:
            progress(0.6 + 0.4 * (i + 1) / n)
    return out


# ---------------------------------------------------------------- binary paths
MAGIC = 0x314C5050    # 'PPL1'


def encode_paths(paths, flip_y=False):
    """u32 magic, u32 n, u32 offsets[n+1], f32 xy[] (little endian).
    One polyline per subpath."""
    offs = [0]
    flat = array('f')
    for p in paths:
        c = p.coords
        if flip_y:
            c = list(c)
            c[1::2] = [-v for v in c[1::2]]
        ops = p.ops
        if not ops:
            continue
        if ops.count(0) <= 1 and ops[0] == 0:
            flat.extend(c)
            offs.append(offs[-1] + len(ops))
            continue
        start = 0
        for i in range(1, len(ops) + 1):
            if i == len(ops) or ops[i] == 0:
                flat.extend(c[2 * start:2 * i])
                offs.append(offs[-1] + i - start)
                start = i
    oa = array('I', offs)
    if sys.byteorder != 'little':
        flat.byteswap()
        oa.byteswap()
    return struct.pack('<II', MAGIC, len(offs) - 1) + oa.tobytes() + flat.tobytes()


def decode_paths(data):
    magic, n = struct.unpack_from('<II', data, 0)
    if magic != MAGIC:
        raise ValueError('bad paths blob')
    oa = array('I')
    oa.frombytes(data[8:8 + 4 * (n + 1)])
    xa = array('f')
    xa.frombytes(data[8 + 4 * (n + 1):8 + 4 * (n + 1) + 8 * (oa[-1] if n >= 0 else 0)])
    if sys.byteorder != 'little':
        oa.byteswap()
        xa.byteswap()
    offs = oa.tolist()
    xy = xa.tolist()
    out = []
    for k in range(n):
        o0, o1 = offs[k], offs[k + 1]
        out.append(Path(xy[2 * o0:2 * o1], [0] + [1] * (o1 - o0 - 1) if o1 > o0 else []))
    return out


# ---------------------------------------------------------------- preview
def preview_svg(paths, width_mm, height_mm, travel=False, y_up=False, page_rect=True,
                margins=None, origin_marker=None, stroke=0.25):
    """SVG with a mm viewBox. Page space: y down, viewBox = the page. Machine
    space (y_up=True): drawn with y flipped, viewBox = content bbox ∪ origin."""
    bb = bbox_of(paths)
    if y_up:
        xs = [0.0] + ([bb[0], bb[2]] if bb else [])
        ys = [0.0] + ([-bb[3], -bb[1]] if bb else [])
        if width_mm and height_mm:
            pass
        minx, maxx = min(xs) - 5, max(xs) + 5
        miny, maxy = min(ys) - 5, max(ys) + 5
    else:
        minx, miny, maxx, maxy = 0.0, 0.0, float(width_mm), float(height_mm)
        if bb:
            minx, miny = min(minx, bb[0]), min(miny, bb[1])
            maxx, maxy = max(maxx, bb[2]), max(maxy, bb[3])
    W, H = maxx - minx, maxy - miny
    fy = (lambda y: -y) if y_up else (lambda y: y)
    o = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="%.3f %.3f %.3f %.3f" width="%.3fmm" '
         'height="%.3fmm">' % (minx, miny, W, H, W, H)]
    if page_rect and not y_up:
        o.append('<rect x="0" y="0" width="%.3f" height="%.3f" fill="#fff" stroke="#ccc" '
                 'stroke-width="0.3"/>' % (width_mm, height_mm))
        if margins:
            o.append('<rect x="%.3f" y="%.3f" width="%.3f" height="%.3f" fill="none" stroke="#9cc" '
                     'stroke-width="0.2" stroke-dasharray="1 1"/>' % (
                         margins.get('l', 0), margins.get('t', 0),
                         width_mm - margins.get('l', 0) - margins.get('r', 0),
                         height_mm - margins.get('t', 0) - margins.get('b', 0)))
    d = []
    tr = []
    last = None
    for p in paths:
        c = p.coords
        for i, op in enumerate(p.ops):
            x, y = c[2 * i], fy(c[2 * i + 1])
            if op == 0:
                if travel and last is not None:
                    tr.append('M%.2f %.2fL%.2f %.2f' % (last[0], last[1], x, y))
                d.append('M%.2f %.2f' % (x, y))
            else:
                d.append('L%.2f %.2f' % (x, y))
            last = (x, y)
    if tr:
        o.append('<path d="%s" fill="none" stroke="#e55" stroke-width="%.2f" stroke-dasharray="1 1" '
                 'opacity="0.6"/>' % (''.join(tr), stroke * 0.6))
    if d:
        o.append('<path d="%s" fill="none" stroke="#111" stroke-width="%.2f" stroke-linecap="round" '
                 'stroke-linejoin="round"/>' % (''.join(d), stroke))
    if y_up or origin_marker:
        ox, oy = origin_marker or (0.0, 0.0)
        o.append('<g stroke="#07f" stroke-width="0.4"><path d="M%.2f %.2fh6M%.2f %.2fv-6"/>'
                 '<circle cx="%.2f" cy="%.2f" r="1.2" fill="none"/></g>' % (ox, oy, ox, oy, ox, oy))
    o.append('</svg>')
    return ''.join(o)
