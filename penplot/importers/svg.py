# -*- coding: utf-8 -*-
"""SVG -> polylines in mm (y down) via svgelements (optional dep `vector`).

XML entity expansion is rejected before parsing (billion laughs).
<text> is handled by svg_text (svgelements keeps no usable text geometry).
"""
import math
import re

from ..geometry import Path, bbox_of

PX_MM = 25.4 / 96.0
_HAS_TEXT = re.compile(rb'<(?:[\w-]+:)?(?:text|flowRoot)[\s>/]')


class SvgError(ValueError):
    pass


def _check_safe(path):
    with open(path, 'rb') as f:
        data = f.read().lower()
    if b'<!entity' in data or b'<!doctype' in data:
        raise SvgError('SVG 含有 DOCTYPE/XML 实体定义，已拒绝')


UNIT_MM = {'px': PX_MM, 'auto': PX_MM, 'mm': 1.0, 'cm': 10.0, 'in': 25.4, 'pt': 25.4 / 72.0, 'm': 1000.0}


TEXT_WARN = {'textpath': 'SVG 文字路径（textPath）不支持，已按普通文字排布',
             'vertical': 'SVG 竖排文字按近似方式排布（字头朝上、自上而下）',
             'flowroot': 'SVG 含 Inkscape 流动文字（flowRoot），不支持，已忽略；请在 Inkscape 中转换为普通文字',
             'too_many': 'SVG 文字过多，只绘制了前 20000 个字符',
             'outline': 'SVG 中的文字没有可用的轮廓（需在设计软件中“转为路径/创建轮廓”），%d 段文字未绘制'}


def load_svg(path, tol_mm=0.1, layers=None, stroke_filter=None, units='auto', text=None):
    """Returns (paths mm y-down, info{bbox_mm, width_mm, height_mm, paths, layers, units,
    text_runs, text_families}).

    units: 'auto' honours width/height + viewBox (CSS units; unit-less = px at 96 dpi).
    'mm'/'cm'/'in'/'pt'/'px' force the size of ONE user unit when the file has no
    physical size (common with CAD exports that mean millimetres).

    text: None = do not draw <text> (metadata only; bbox_mm then includes a
    font-independent estimate of the text). Otherwise a dict: mode
    'font'|'outline'|'skip', font_for(families)->stroke font, size_scale,
    fonts_set (layout.FontsSet|None), rng, missing (set, filled), messages
    (list, filled), missing_glyph 'box'|'skip'."""
    try:
        import svgelements as se
    except ImportError:
        raise ImportError('svgelements not installed')
    _check_safe(path)
    svg = se.SVG.parse(path, reify=True, ppi=96.0)
    k = UNIT_MM.get(units or 'auto', PX_MM)
    has_size = bool(svg.values.get('width')) and any(u in str(svg.values.get('width')) for u in
                                                     ('mm', 'cm', 'in', 'pt', 'pc'))
    if units not in (None, 'auto', 'px') and has_size:
        k = PX_MM          # the file states its physical size: that wins
    out = []
    layer_names = []
    tol_px = max(0.01, tol_mm / PX_MM)
    del tol_px
    tol_px = max(0.01, tol_mm / (UNIT_MM.get(units or 'auto', PX_MM)))
    for el in svg.elements():
        if isinstance(el, se.Group):
            gid = el.values.get('inkscape:label') or el.values.get('id')
            if gid and el.values.get('inkscape:groupmode') == 'layer' and gid not in layer_names:
                layer_names.append(gid)
            continue
        if not isinstance(el, se.Shape):
            continue
        if layers:
            lab = _layer_of(el)
            if lab not in layers:
                continue
        if stroke_filter:
            st = el.values.get('stroke') or ''
            if str(st).lower() != str(stroke_filter).lower():
                continue
        if el.values.get('visibility') == 'hidden' or el.values.get('display') == 'none':
            continue
        try:
            sp = se.Path(el)
        except Exception:
            continue
        for sub in sp.as_subpaths():
            pts = _flatten(se.Path(sub), tol_px)
            if len(pts) < 2:
                continue
            p = Path()
            p.move_to(pts[0][0] * k, pts[0][1] * k)
            for x, y in pts[1:]:
                p.line_to(x * k, y * k)
            out.append(p)
    n_shapes = len(out)
    blocks, twarn = _text_blocks(path, svg, layers, stroke_filter)
    from . import svg_text as st
    mode = (text or {}).get('mode') or 'font'
    est = None
    if blocks and text is None:
        eb = st.estimate_bbox(blocks)
        if eb:
            est = [eb[0] * k, eb[1] * k, eb[2] * k, eb[3] * k]
    elif blocks and mode == 'font':
        msgs = text.get('messages')
        for b in blocks:
            for p in st.layout_block(b, text['font_for'], size_scale=float(text.get('size_scale') or 1.0),
                                     fonts_set=text.get('fonts_set'), rng=text.get('rng'),
                                     missing=text.get('missing'),
                                     missing_glyph=text.get('missing_glyph') or 'box'):
                c = p.coords
                for i in range(len(c)):
                    c[i] *= k
                out.append(p)
        if msgs is not None:
            flags = set(twarn) | set().union(*[b.flags for b in blocks])
            msgs.extend(TEXT_WARN[f] for f in ('textpath', 'vertical', 'flowroot', 'too_many') if f in flags)
    elif blocks and mode == 'outline' and text.get('messages') is not None:
        text['messages'].append(TEXT_WARN['outline'] % len(blocks))
    if text is not None and text.get('messages') is not None and 'flowroot' in twarn and mode != 'font':
        text['messages'].append(TEXT_WARN['flowroot'])
    bb = bbox_of(out)
    if est is not None:
        bb = (min(bb[0], est[0]), min(bb[1], est[1]), max(bb[2], est[2]), max(bb[3], est[3])) if bb else est
    info = {'bbox_mm': [round(v, 3) for v in bb] if bb else None,
            'width_mm': round(bb[2] - bb[0], 3) if bb else 0.0,
            'height_mm': round(bb[3] - bb[1], 3) if bb else 0.0,
            'paths': len(out), 'shape_paths': n_shapes, 'layers': layer_names, 'physical_size': has_size,
            'text_runs': st.text_runs(blocks, k), 'text_families': st.text_families(blocks)}
    return out, info


def _text_blocks(path, svg, layers, stroke_filter):
    """<text> elements -> svg_text.TextBlock list (svgelements px coordinates)."""
    from . import svg_text as st
    with open(path, 'rb') as f:
        if not _HAS_TEXT.search(f.read()):
            return [], []
    root = st.parse_transform(getattr(svg, 'viewbox_transform', None))
    vb = getattr(svg, 'viewbox', None)
    vw = float(getattr(vb, 'width', None) or getattr(svg, 'width', None) or 100.0) if vb is not None else \
        float(getattr(svg, 'width', None) or 100.0)
    vh = float(getattr(vb, 'height', None) or getattr(svg, 'height', None) or 100.0) if vb is not None else \
        float(getattr(svg, 'height', None) or 100.0)
    try:
        return st.extract_text(path, root, (vw, vh), layers=layers, stroke_filter=stroke_filter)
    except Exception:      # malformed XML svgelements tolerated: no text rather than no drawing
        return [], []


def _layer_of(el):
    # svgelements keeps no parent pointer; inkscape layer id is copied to values
    return el.values.get('inkscape:label') or el.values.get('id')


def _flatten(path, tol):
    import svgelements as se
    pts = []
    for seg in path:
        if isinstance(seg, se.Move):
            pts.append((seg.end.x, seg.end.y))
            continue
        if isinstance(seg, (se.Line, se.Close)):
            if seg.end is not None:
                pts.append((seg.end.x, seg.end.y))
            continue
        try:
            L = seg.length(error=1e-3)
        except Exception:
            L = 10.0
        n = max(2, min(2000, int(math.ceil(math.sqrt(max(L, 1e-9) / max(tol, 1e-6)) * 2))))
        for i in range(1, n + 1):
            q = seg.point(i / n)
            pts.append((q.x, q.y))
    return pts
