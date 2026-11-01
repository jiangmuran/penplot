# -*- coding: utf-8 -*-
"""Text layout engine (排版): PageInfo + TextDocument, faithful port of the
word package (word.c / word.entites.b/c/d/e/f).

Pipeline: text + gfont stroke font -> per-char Path entities in pixel coords
-> page export (rotate / origin offset / flip-Y / axes mapping / px->mm).
"""
import random

from .geometry import Path, Affine2D, bbox_of, translate_all, scale_all, rotate_all_around
from .settings import AxesSettings


# ---------------------------------------------------------------- PageInfo
def page_presets():
    """PageInfo.defaultPapers()."""
    def p(name, w, h, lg, rg, tg, bg):
        return dict(name=name, pageWidth=w, pageHeight=h, leftGap=lg, rightGap=rg,
                    topGap=tg, bottomGap=bg, lineNum=20, fontSize=95.0)
    return [
        p('A4普通边距', 209, 296, 31.8, 31.8, 25.4, 25.4),
        p('A4窄边距', 209, 296, 12.7, 12.7, 12.7, 12.7),
        p('A4适中边距', 209, 296, 19.1, 19.1, 25.4, 25.4),
        p('A4宽边距', 209, 296, 50.8, 50.8, 25.4, 25.4),
        p('A3普通边距', 296, 419.1, 31.8, 31.8, 25.4, 25.4),
        p('A3窄边距', 296, 419.1, 12.7, 12.7, 12.7, 12.7),
        p('A3适中边距', 296, 419.1, 19.1, 19.1, 25.4, 25.4),
        p('A3宽边距', 296, 419.1, 50.8, 50.8, 25.4, 25.4),
        p('16开普通边距', 183, 259, 31.8, 31.8, 25.4, 25.4),
        p('16开窄边距', 183, 259, 12.7, 12.7, 12.7, 12.7),
        p('16开适中边距', 183, 259, 19.1, 19.1, 25.4, 25.4),
        p('16开宽边距', 183, 259, 50.8, 50.8, 25.4, 25.4),
    ]


class PageInfo:
    def __init__(self, **kw):
        d = dict(page_presets()[0])
        d.update(kw)
        self.name = d.get('name', '')
        self.pageWidth = float(d.get('pageWidth', 209))
        self.pageHeight = float(d.get('pageHeight', 296))
        self.leftGap = float(d.get('leftGap', 31.8))
        self.rightGap = float(d.get('rightGap', 31.8))
        self.topGap = float(d.get('topGap', 25.4))
        self.bottomGap = float(d.get('bottomGap', 25.4))
        self.lineNum = int(d.get('lineNum', 20))
        self.fontSize = float(d.get('fontSize', 95.0))
        self.space = float(d.get('space', 1.0))
        self.lineGap = float(d.get('lineGap', 0.0))
        self.lineGapOffset = float(d.get('lineGapOffset', 0.0))
        self.baseLine = float(d.get('baseLine', 1.0))
        self.fontPath = d.get('fontPath') or []
        self.fontChance = d.get('fontChance')
        self.rotation = float(d.get('rotation', 0.0))

    def clone(self) -> 'PageInfo':
        import copy
        return copy.deepcopy(self)


class ParagraphFormat:
    """word.entites.f: spe_type 0=无 1=首行缩进 2=悬挂; values in mm."""

    def __init__(self, spe_type=0, spe_value=0.0, left=0.0, right=0.0):
        self.spe_type = spe_type
        self.spe_value = spe_value
        self.left = left
        self.right = right


class FontsSet:
    """FontsSetData - handwriting randomisation knobs."""

    def __init__(self, **kw):
        self.chars = kw.get('chars', '，,.。')
        self.widthAdd = kw.get('widthAdd', 0.0)
        self.simple = kw.get('simple', 0.0)          # RDP tolerance (px), 0=off
        self.tabWidthAdd = kw.get('tabWidthAdd', 0.0)
        self.baseLine = kw.get('baseLine', 1.0)
        self.spaceWidthAdd = kw.get('spaceWidthAdd', 0.0)
        self.randomY = kw.get('randomY', 0.0)
        self.randomFirstPos = kw.get('randomFirstPos', 0.0)
        self.randomFontSize = kw.get('randomFontSize', [1.0, 1.0])
        self.randomSpace = kw.get('randomSpace', [1.0, 1.0])
        self.randomRotate = kw.get('randomRotate', [0.0, 0.0])
        self.randomXScale = kw.get('randomXScale', [1.0, 1.0])
        self.randomYScale = kw.get('randomYScale', [1.0, 1.0])

    def is_special_char(self, ch) -> bool:
        return self.chars is not None and ch in self.chars


def _fmt_key(fmt):
    if fmt is None:
        return None
    return (fmt.spe_type, fmt.spe_value, fmt.left, fmt.right)


class LineAlign:
    LEFT, CENTER, RIGHT, DISPERSE = 'Left', 'Center', 'Right', 'Disperse'


# characters that may not start a line (word.c wrap rule, verbatim)
_NO_LINE_START = set(',，;；.。!！?？>》}}]】)）)、…"°%：:\n')


class _CharBox:
    """Laid-out char: path (px, local), visual advance i(), step j()."""
    __slots__ = ('ch', 'path', 'adv', 'step', 'q', 'p')

    def __init__(self, ch, path, adv, step, q, p):
        self.ch = ch
        self.path = path
        self.adv = adv      # b.i()  visual width
        self.step = step    # b.j()  advance incl. trailing space (0 for \n)
        self.q = q
        self.p = p


class _Line:
    __slots__ = ('chars', 'first')

    def __init__(self, chars, first):
        self.chars = chars
        self.first = first

    def __iter__(self):
        return iter(self.chars)

    def __len__(self):
        return len(self.chars)

    def __getitem__(self, i):
        return self.chars[i]


class TextDocument:
    """Lays out text on ruled pages using stroke fonts (gfont)."""

    def __init__(self, page: PageInfo, font, fonts_set: FontsSet = None,
                 settings=None, rng=None, text_size=1.0, char_space=0.0,
                 font_mix=None):
        self.page = page
        self.font = font
        self.fs = fonts_set or FontsSet()
        self.settings = settings
        self.rng = rng or random.Random()
        self.text_size = text_size
        self.char_space = char_space
        # font_mix: [(font, weight), ...] - per-char weighted random font
        # selection with automatic substitution when a glyph is missing
        # (the original's fontPath[]/fontChance[] feature)
        self.font_mix = font_mix
        # B16: chars without a glyph in any font are collected here;
        # missing_glyph='box' (default, original behaviour) draws a box,
        # 'skip' leaves a blank of the same width
        self.missing = set()
        self.missing_glyph = 'box'

    # helpers -----------------------------------------------------
    def _pick_font(self, ch):
        if not self.font_mix:
            return self.font
        total = sum(w for _f, w in self.font_mix if w > 0)
        if total <= 0:
            return self.font_mix[0][0] if self.font_mix else self.font
        r = self.rng.random() * total
        acc = 0.0
        pick = self.font_mix[0][0]
        for f, w in self.font_mix:
            if w <= 0:
                continue
            acc += w
            if r <= acc:
                pick = f
                break
        if pick.has_glyph(ch):
            return pick
        for f, _w in self.font_mix:
            if f.has_glyph(ch):
                return f
        return pick
    def _mm2px(self, mm):
        return mm * 0.03937008 * (self.settings.dpi if self.settings else 96)

    def _rand(self, pair):
        lo, hi = pair[0], pair[1]
        if lo == hi:
            return lo
        return lo + self.rng.random() * (hi - lo)

    # character entity (word.entites.b.n) --------------------------
    def _char_path(self, ch, line_height):
        """Returns (path|None, visual_advance i())."""
        fs = self.fs
        baseline = line_height * 0.75 * fs.baseLine
        font = self._pick_font(ch)
        g = font.glyph(ch)
        if g is not None and g.ops:
            scale = line_height / font.size * self._rand(fs.randomFontSize) * self.text_size
            p = Path(list(g.coords), list(g.ops))
            aff = Affine2D()
            aff.pre_scale(scale * self._rand(fs.randomXScale),
                          scale * self._rand(fs.randomYScale))
            p.transform(aff)
            rot = self._rand(fs.randomRotate)
            if rot:
                p.transform(Affine2D().rotate_deg_around(rot, 0.0, 0.0))
            bb = p.bbox()
            if bb is None:
                return None, 0.0
            shift = -bb[0] if bb[0] < 0.0 else 0.0
            # original quirk kept exactly: d = width + max(0,minX);
            # special chars add the *whole* shift (incl. -minX part) to advance
            adv = (bb[2] - bb[0]) + max(0.0, bb[0])
            # advance stored on the glyph (psf v1.1 from TTF conversion)
            # overrides the bbox guess with the real advance width
            if getattr(g, 'advance', None):
                adv = g.advance * (line_height / font.size) * self.text_size
            if fs.is_special_char(ch):
                shift += self._mm2px(fs.widthAdd)
                adv += shift
            p.transform(Affine2D().translate(shift, baseline +
                       self.rng.uniform(-fs.randomY, fs.randomY) * line_height))
            if fs.simple > 0:
                p.rdp_simplify(fs.simple)
            return p, adv
        if ch == '\t':
            # Java adds tabWidthAdd RAW (already px in FontsSetData)
            adv = line_height * self.text_size * 0.3 * 2.0 + fs.tabWidthAdd
            return None, adv
        if ch in '\n\f':
            return None, line_height * 0.5
        # glyph present but stroke-less (space etc. from TTF conversion):
        # use its real advance width when available
        if g is not None and getattr(g, 'advance', None):
            adv = g.advance * (line_height / font.size) * self.text_size
            return None, adv
        # Java adds spaceWidthAdd RAW (already px in FontsSetData)
        adv = line_height * self.text_size * 0.3 + fs.spaceWidthAdd
        p = None
        if ch != ' ':
            self.missing.add(ch)
            if self.missing_glyph != 'skip':
                p = Path()
                p.rect(0.0, 0.0, adv, line_height * self.text_size)
        return p, adv

    # layout (word.c.d + a(List,int,float)) ------------------------
    def layout(self, text, fmt: ParagraphFormat = None):
        """Returns list of pages; page = list of lines; line = list[_CharBox].

        The result is cached per (text, fmt): handwriting jitter draws from
        self.rng, so laying the same text out twice would give different
        glyphs and even different page breaks. entities() reuses this cache,
        which keeps "count pages", per-page export and preview consistent.
        """
        key = (text, _fmt_key(fmt))
        cached = getattr(self, '_layout_cache', None)
        if cached is not None and cached[0] == key:
            return cached[1]
        pages = self._layout(text, fmt)
        self._layout_cache = (key, pages)
        return pages

    def _layout(self, text, fmt: ParagraphFormat = None):
        fmt = fmt or ParagraphFormat()
        page = self.page
        self._line_h = self._mm2px(page.pageHeight - page.topGap - page.bottomGap) / page.lineNum
        line_w = self._mm2px(page.pageWidth - page.leftGap - page.rightGap)
        space_px = self._mm2px(page.space)
        q_px = self._mm2px(self.char_space)

        pages = []
        lines = []
        cur = []
        para_first_line = True        # next line is the first line of its paragraph
        line_idx = 0
        # line start x: left indent + (first-line ? spe(type1) : hanging(type2))
        indent = fmt.spe_value if (para_first_line and fmt.spe_type == 1) or \
            (not para_first_line and fmt.spe_type == 2) else 0.0
        x = self._mm2px(fmt.left) + self._mm2px(indent)
        right_px = self._mm2px(fmt.right)

        def new_line(by_page_break, new_para=False):
            nonlocal cur, lines, line_idx, pages, para_first_line, x, indent
            lines.append(_Line(cur, para_first_line))
            cur = []
            line_idx += 1
            if by_page_break or line_idx >= page.lineNum:
                pages.append(lines)
                lines = []
                line_idx = 0
            para_first_line = new_para
            indent = fmt.spe_value if (para_first_line and fmt.spe_type == 1) or \
                (not para_first_line and fmt.spe_type == 2) else 0.0
            x = self._mm2px(fmt.left) + self._mm2px(indent)

        i = 0
        n = len(text)
        while i < n:
            ch = text[i]
            i += 1
            if ch == '\r':
                continue
            if ch == '\n':
                p_gap = space_px * self._rand(self.fs.randomSpace)
                cur.append(_CharBox(ch, None, self._line_h * 0.5,
                                    self._line_h * 0.5 + q_px + p_gap, q_px, p_gap))
                new_line(False, new_para=True)
                continue
            if ch == '\f':
                # Java: \f occupies a slot in the line, then forces a page break
                p_gap = space_px * self._rand(self.fs.randomSpace)
                cur.append(_CharBox(ch, None, self._line_h * 0.5,
                                    self._line_h * 0.5 + q_px + p_gap, q_px, p_gap))
                new_line(True, new_para=True)
                continue
            path, adv = self._char_path(ch, self._line_h)
            p_gap = space_px * self._rand(self.fs.randomSpace)
            # wrap check (word.c: cursor + i() + rightIndent > lineW, unless
            # the char may not start a line)
            if x + adv + right_px > line_w and cur and ch not in _NO_LINE_START:
                i -= 1                     # rewind char to next line
                new_line(False)
                continue
            step = adv + q_px + p_gap          # Java j() uniform for all chars
            cur.append(_CharBox(ch, path, adv, step, q_px, p_gap))
            x += step
        if cur:
            lines.append(_Line(cur, para_first_line))
        if lines:
            pages.append(lines)
        while pages and not any(len(ln) for ln in pages[-1]):
            pages.pop()
        return pages

    # entities (word.entites.d/c transforms) ------------------------
    def entities(self, text, align=LineAlign.LEFT, fmt: ParagraphFormat = None,
                 page_index=None):
        """Flatten to Path entities in page pixel coords (screen space, y down).

        page_index=None flattens every page, stacking pages vertically one
        page-height apart (previews never overlap); an index exports just
        that page at the page origin (the original exports per page / per
        file). Odd lines emit chars in reverse order (serpentine, matching
        word.entites.d.c()).
        """
        pages = self.layout(text, fmt)
        line_h = self._line_h
        page = self.page
        top = self._mm2px(page.topGap)
        left = self._mm2px(page.leftGap)
        page_h_px = self._mm2px(page.pageHeight)
        line_w = self._mm2px(page.pageWidth - page.leftGap - page.rightGap)
        fmt = fmt or ParagraphFormat()
        out = []
        for pi, lines in enumerate(pages):
            if page_index is not None and pi != page_index:
                continue
            for li, line in enumerate(lines):
                if not line.chars:
                    continue
                first_of_para = line.first
                indent = fmt.spe_value if (first_of_para and fmt.spe_type == 1) or \
                    (not first_of_para and fmt.spe_type == 2) else 0.0
                g = self._mm2px(fmt.left) + self._mm2px(indent)
                h = self._mm2px(fmt.right)
                content = sum(cb.step for cb in line.chars)   # e(): incl. trailing gap
                if align == LineAlign.RIGHT:
                    off = line_w - content - h
                elif align == LineAlign.CENTER:
                    off = (line_w - content - g - h) / 2.0
                else:                                          # Left / Disperse
                    off = g
                off += self.rng.random() * self.fs.randomFirstPos   # j.b.c: [0, v]
                extra = 0.0
                if align == LineAlign.DISPERSE:
                    # Java: denominator = (n-1) - #zero-advance chars;
                    # the extra gap is added after EVERY char uniformly
                    denom = (len(line.chars) - 1) - \
                        sum(1 for cb in line.chars if cb.adv == 0.0)
                    extra = (line_w - content - g - h) / denom if denom > 0 else 0.0
                y = top + li * line_h
                if page_index is None:
                    y += pi * page_h_px
                # place every char in reading order, THEN reverse only the
                # emission order on odd lines (serpentine pen travel). Reversing
                # before placing would mirror the text order on the page.
                placed = []
                rel = 0.0
                for cb in line.chars:
                    if cb.path is not None:
                        e = cb.path.clone()
                        e.transform(Affine2D().translate(left + off + rel, y))
                        placed.append(e)
                    rel += cb.step + extra
                out.extend(placed if li % 2 == 0 else reversed(placed))
        return out


# ---------------------------------------------------------------- export
def export_transform(paths, page: PageInfo, settings, origin=(0.0, 0.0),
                     rotation=None, machine_type=None, axes=None):
    """h.a(List) + coordinate/a.a(List): page px -> machine mm.

    origin: user origin marker position in page px (canvas translate c).
    axes: AxesSettings (default: identity mapping, pos=LeftUp).
    """
    rot = page.rotation if rotation is None else rotation
    w_px = settings.mm2px(page.pageWidth)
    h_px = settings.mm2px(page.pageHeight)
    ox, oy = origin
    if rot % 180 != 0:
        dx = (h_px - w_px) / 2.0
        dy = -dx
    else:
        dx = dy = 0.0
    rotate_all_around(paths, rot, w_px / 2.0, h_px / 2.0)
    translate_all(paths, dx - ox, dy - oy)
    scale_all(paths, 1.0, -1.0)   # flip Y: screen -> machine

    # the coordinate mapper receives the page rect with W/H SWAPPED when
    # the page is rotated 90/270 (canvas h.a(float) behaviour)
    aw_px, ah_px = (h_px, w_px) if rot % 180 != 0 else (w_px, h_px)

    axes = axes or AxesSettings()
    if machine_type == 'Ebb':
        # coordinate/a: EBB forces revxy/xr/yr, g==0 branch: (x,y) -> (-y, w-x)
        for p in paths:
            c = p.coords
            for i in range(0, len(c), 2):
                x, y = c[i], c[i + 1]
                c[i], c[i + 1] = -y, aw_px - x
    else:
        revxy, xr, yr = axes.revxy, axes.xAxeRev, axes.yAxeRev
        for p in paths:
            c = p.coords
            for i in range(0, len(c), 2):
                x, y = c[i], c[i + 1]
                if revxy:
                    x, y = y, x
                if xr:
                    x = -x
                if yr:
                    y = -y
                c[i], c[i + 1] = x, y
        # quadrant origin a(1): LeftUp(0,0) RightUp(w,0) LeftDown(0,-h) RightDown(w,-h)
        pos = axes.pos or 0
        qx = aw_px if pos in (1, 3) else 0.0
        qy = -ah_px if pos in (2, 3) else 0.0
        f6, f7 = -qx, -qy
        if revxy:
            if xr:
                f7 = -f7
            if yr:
                f6 = -f6
        else:
            if xr:
                f6 = -f6
            if yr:
                f7 = -f7
        if revxy:
            f6, f7 = f7, f6
        translate_all(paths, f6, f7)
    scale_all(paths, 25.4 / settings.dpi, 25.4 / settings.dpi)   # px -> mm
    return paths


# ---------------------------------------------------------------- mm export
class OriginSpec:
    """Origin as data (03 §3.3): which page corner the pen sits on at job
    start, inward offset from that corner, axis mapping, page rotation."""

    def __init__(self, corner=0, revxy=False, x_rev=False, y_rev=False,
                 offset_x_mm=0.0, offset_y_mm=0.0, rotation=0, set_zero_at_start=None,
                 anchor='paper', **_):
        self.corner = int(corner or 0)
        # 'paper': origin = that corner of the paper (+offset).
        # 'content': origin = that corner of the drawing's bounding box (+offset).
        #   For machines where the paper is held by clips and the pen cannot reach
        #   the paper corner: the operator parks the pen at the top-left of the
        #   area to be written, and that point is (0,0).
        self.anchor = 'content' if anchor == 'content' else 'paper'
        self.revxy = bool(revxy)
        self.x_rev = bool(x_rev)
        self.y_rev = bool(y_rev)
        self.offset_x_mm = float(offset_x_mm or 0.0)
        self.offset_y_mm = float(offset_y_mm or 0.0)
        self.rotation = int(rotation or 0) % 360
        self.set_zero_at_start = set_zero_at_start

    @classmethod
    def from_axes(cls, axes, rotation=0):
        axes = axes or AxesSettings()
        return cls(corner=axes.pos or 0, revxy=axes.revxy, x_rev=axes.xAxeRev,
                   y_rev=axes.yAxeRev, rotation=rotation)

    @classmethod
    def coerce(cls, v):
        if v is None:
            return cls()
        if isinstance(v, cls):
            return v
        if isinstance(v, dict):
            return cls(**v)
        return cls(**{k: getattr(v, k) for k in ('corner', 'revxy', 'x_rev', 'y_rev',
                                                 'offset_x_mm', 'offset_y_mm', 'rotation',
                                                 'set_zero_at_start', 'anchor') if hasattr(v, k)})


def export_transform_mm(paths, page_w_mm, page_h_mm, origin=None, machine_type=None, anchor_bbox=None):
    """Page mm (y down) -> machine mm, in place (generalised export_transform).

    1. rotate the page by origin.rotation around its centre and move the
       rotated page back to (0,0) (W/H swap for 90/270);
    2. origin marker = chosen corner of the (rotated) page + inward offset;
       translate so the marker is (0,0);
    3. flip Y (screen -> machine);
    4. machine axis mapping revxy / x_rev / y_rev.
    For corner 0, no offset, no rotation and identity axes this equals
    export_transform() (scaled to mm) exactly. EBB keeps its forced
    mapping (x,y) -> (-y, w-x) like the original.
    """
    o = OriginSpec.coerce(origin)
    w, h = float(page_w_mm), float(page_h_mm)
    # anchor_bbox (page mm, before rotation): content bbox to anchor to when the
    # paths given are not the content themselves (e.g. a paper outline preview).
    probe = None
    if o.anchor == 'content' and anchor_bbox is not None:
        x0, y0, x1, y1 = anchor_bbox
        probe = Path()
        probe.move_to(x0, y0)
        for px, py in ((x1, y0), (x1, y1), (x0, y1)):
            probe.line_to(px, py)
    moving = list(paths) + ([probe] if probe is not None else [])
    rot = o.rotation
    if rot:
        rotate_all_around(moving, rot, w / 2.0, h / 2.0)
        if rot % 180 != 0:
            d = (h - w) / 2.0
            translate_all(moving, d, -d)
            w, h = h, w
    if o.anchor == 'content':
        bb = bbox_of([probe]) if probe is not None else bbox_of(paths)
        if bb is not None:
            x0, y0, x1, y1 = bb
            cx = x1 if o.corner in (1, 3) else x0
            cy = y1 if o.corner in (2, 3) else y0
        else:
            cx = cy = 0.0
    else:
        cx = w if o.corner in (1, 3) else 0.0
        cy = h if o.corner in (2, 3) else 0.0
    mx = cx - o.offset_x_mm if o.corner in (1, 3) else cx + o.offset_x_mm
    my = cy - o.offset_y_mm if o.corner in (2, 3) else cy + o.offset_y_mm
    if mx or my:
        translate_all(paths, -mx, -my)
    if machine_type == 'Ebb':
        for p in paths:
            c = p.coords
            for i in range(0, len(c), 2):
                x, y = c[i], -c[i + 1]
                c[i], c[i + 1] = -y, w - x
        return paths
    for p in paths:
        c = p.coords
        for i in range(0, len(c), 2):
            x, y = c[i], -c[i + 1]
            if o.revxy:
                x, y = y, x
            if o.x_rev:
                x = -x
            if o.y_rev:
                y = -y
            c[i], c[i + 1] = x, y
    return paths


def work_area_rect(work_w, work_h, origin=None):
    """Machine-coordinate rectangle reachable from the origin. work_w/h are
    the machine X/Y travel; the origin is assumed to be the work-area corner
    matching the page corner the pen starts on (LeftUp with identity axes:
    x in [0,w], y in [-h,0])."""
    o = OriginSpec.coerce(origin)
    # direction of "into the page" from the chosen corner, in page space
    px = -1.0 if o.corner in (1, 3) else 1.0
    py = -1.0 if o.corner in (2, 3) else 1.0
    x, y = px, -py                     # flip Y
    if o.revxy:
        x, y = y, x
    if o.x_rev:
        x = -x
    if o.y_rev:
        y = -y
    xs = (0.0, float(work_w)) if x > 0 else (-float(work_w), 0.0)
    ys = (0.0, float(work_h)) if y > 0 else (-float(work_h), 0.0)
    return xs[0], ys[0], xs[1], ys[1]


def check_bounds(bbox, work_w, work_h, origin=None, tol=1.0):
    """Machine bbox vs. work area (B11: full coordinate chain, any corner,
    rotation already applied by the transform). Returns a list of
    violated sides ([] = fits), e.g. ['X>300', 'Y<-300']."""
    if bbox is None:
        return []
    if not work_w or not work_h or float(work_w) <= 0 or float(work_h) <= 0:
        return []          # travel not configured: no travel check (paper fit is checked elsewhere)
    x0, y0, x1, y1 = work_area_rect(work_w, work_h, origin)
    bad = []
    if bbox[0] < x0 - tol:
        bad.append('X<%g' % x0)
    if bbox[2] > x1 + tol:
        bad.append('X>%g' % x1)
    if bbox[1] < y0 - tol:
        bad.append('Y<%g' % y0)
    if bbox[3] > y1 + tol:
        bad.append('Y>%g' % y1)
    return bad
