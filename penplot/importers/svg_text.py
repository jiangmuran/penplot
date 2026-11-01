# -*- coding: utf-8 -*-
"""SVG <text> -> single-stroke glyph paths (svgelements drops text content).

The file is walked with ElementTree (after svg._check_safe), so text runs keep
their real structure: x/y/dx/dy/rotate lists on <text>/<tspan> (descendants
override ancestors, per character), the ancestor transform chain (plus the
root viewport transform svgelements computed), font-size with units / em / %
/ keywords, text-anchor per text chunk, dominant-/alignment-baseline,
baseline-shift, letter-/word-spacing, xml:space / white-space and simple
<style> rules (tag / .class / #id selectors). <textPath> falls back to plain
text at the current position (warning); vertical writing-mode is laid out top
to bottom with upright glyphs (best effort, warning).

Size mapping (documented in docs/design/04-contract-notes.md): the SVG
font-size is the CSS em. Stroke fonts have no reliable em, so it is estimated
per font: the advance width of a CJK ideograph (= 1 em) when the font stores
advances, else the CJK ink height / 0.80, else the cap height of 'H' / 0.70,
else font.size / 1.3 (the ttffont EM_TO_SIZE convention). Glyph baselines
(y=0 in font units) sit exactly on the SVG baseline.

Output coordinates are svgelements' document px (same space svg.load_svg
flattens shapes into); the caller multiplies by its unit factor.
"""
import math
import re
import unicodedata
import xml.etree.ElementTree as ET

from ..geometry import Path

SVG_NS = 'http://www.w3.org/2000/svg'
XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space'
XLINK_HREF = '{http://www.w3.org/1999/xlink}href'
INKSCAPE_LABEL = '{http://www.inkscape.org/namespaces/inkscape}label'
INKSCAPE_GROUPMODE = '{http://www.inkscape.org/namespaces/inkscape}groupmode'

# properties that inherit down the tree (CSS / SVG 2 semantics)
INHERITED = ('font-family', 'font-size', 'text-anchor', 'dominant-baseline', 'letter-spacing',
             'word-spacing', 'writing-mode', 'fill', 'stroke', 'visibility', 'white-space', 'xml:space')
STYLE_PROPS = INHERITED + ('display', 'alignment-baseline', 'baseline-shift')
SKIP_TAGS = {'defs', 'symbol', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient',
             'radialGradient', 'metadata', 'title', 'desc', 'style', 'script', 'foreignObject',
             'filter', 'font', 'font-face', 'cursor', 'view'}
FONT_KEYWORDS = {'xx-small': 9.0, 'x-small': 10.0, 'small': 13.0, 'medium': 16.0, 'large': 18.0,
                 'x-large': 24.0, 'xx-large': 32.0, 'xxx-large': 48.0}
UNIT_PX = {'': 1.0, 'px': 1.0, 'pt': 96.0 / 72.0, 'pc': 16.0, 'mm': 96.0 / 25.4, 'cm': 96.0 / 2.54,
           'in': 96.0, 'q': 96.0 / 101.6}
# baseline offsets in em, y down: the alphabetic baseline sits this far below the
# position the SVG asks for (approximate font-independent metrics)
BASELINE_EM = {'middle': 0.25, 'central': 0.35, 'mathematical': 0.25, 'hanging': 0.8,
               'text-before-edge': 0.88, 'text-top': 0.88, 'before-edge': 0.88,
               'text-after-edge': -0.12, 'text-bottom': -0.12, 'after-edge': -0.12,
               'ideographic': -0.12}
VERTICAL = ('tb', 'tb-rl', 'vertical-rl', 'vertical-lr')
CJK_REF = '国中永一'
CJK_INK_EM = 0.80     # centre-line ink height of an ideograph, in em
CAP_EM = 0.70         # cap height, in em
SPACE_EM = 0.30
SIDE_EM = 0.06        # side bearing for glyphs without a stored advance
MAX_CHARS = 20000     # per document; more text than this is truncated (warning)

_NUM = re.compile(r'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')
_LEN = re.compile(r'^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$')


# ---------------------------------------------------------------- small helpers
def _local(tag):
    if not isinstance(tag, str):
        return ''
    return tag.rsplit('}', 1)[-1]


def _mul(m, n):
    """m o n (apply n first). Matrices are (a, b, c, d, e, f) like SVG."""
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return (a * a2 + c * b2, b * a2 + d * b2, a * c2 + c * d2, b * c2 + d * d2,
            a * e2 + c * f2 + e, b * e2 + d * f2 + f)


IDENT = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def parse_transform(s):
    if not s or not str(s).strip():
        return IDENT
    try:
        import svgelements as se
        m = se.Matrix(str(s))
        return (m.a, m.b, m.c, m.d, m.e, m.f)
    except Exception:
        return IDENT


def _scale_of(m):
    return math.sqrt(abs(m[0] * m[3] - m[1] * m[2])) or 1.0


def parse_length(s, font_size=16.0, ref=None):
    """CSS length -> px (user units). em/ex relative to font_size, % to ref."""
    if s is None:
        return None
    mt = _LEN.match(str(s))
    if not mt:
        return None
    v, u = float(mt.group(1)), mt.group(2).lower()
    if u == 'em':
        return v * font_size
    if u == 'ex':
        return v * font_size * 0.5
    if u == 'rem':
        return v * 16.0
    if u == '%':
        return v / 100.0 * (ref if ref is not None else font_size)
    if u in UNIT_PX:
        return v * UNIT_PX[u]
    return None


def parse_length_list(s, font_size, ref):
    if s is None:
        return None
    out = []
    for tok in re.split(r'[\s,]+', str(s).strip()):
        if not tok:
            continue
        v = parse_length(tok, font_size, ref)
        if v is not None:
            out.append(v)
    return out or None


def font_size_px(value, parent):
    if value is None:
        return parent
    v = str(value).strip().lower()
    if v in FONT_KEYWORDS:
        return FONT_KEYWORDS[v]
    if v == 'larger':
        return parent * 1.2
    if v == 'smaller':
        return parent / 1.2
    if v in ('inherit', 'unset', ''):
        return parent
    px = parse_length(v, parent, parent)
    return px if px is not None and px > 0 else parent


def split_families(s):
    out = []
    for part in str(s or '').split(','):
        p = part.strip().strip('"\'').strip()
        if p:
            out.append(p)
    return out


def norm_family(s):
    return re.sub(r'\s+', ' ', str(s or '').strip().strip('"\'')).lower()


def _parse_decls(text):
    out = {}
    for decl in str(text or '').split(';'):
        if ':' not in decl:
            continue
        k, v = decl.split(':', 1)
        k, v = k.strip().lower(), v.strip()
        if v.lower().endswith('!important'):
            v = v[:-10].strip()
        if k == 'font':
            out.update(_parse_font_shorthand(v))
        elif k:
            out[k] = v
    return out


def _parse_font_shorthand(v):
    # "[style] [weight] size[/line-height] family, family"
    mt = re.search(r'(?:^|\s)([-+]?[\d.]+[a-zA-Z%]*|' + '|'.join(FONT_KEYWORDS) + r')(?:/\S+)?\s+(.+)$', v)
    if not mt:
        return {}
    return {'font-size': mt.group(1), 'font-family': mt.group(2)}


# ---------------------------------------------------------------- CSS (<style>)
_SEL = re.compile(r'^(\*|[a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$')


def parse_css(text):
    """Simple selectors only: tag, .cls, #id, tag.cls.cls2, *, comma groups.
    -> [(specificity, order, (tag, ids, classes), decls)]."""
    text = re.sub(r'/\*.*?\*/', '', text or '', flags=re.S)
    text = text.replace('<![CDATA[', '').replace(']]>', '')
    rules = []
    order = 0
    depth = 0
    buf = ''
    blocks = []
    # flatten one level of @media { ... }; drop other @-rules
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '{':
            depth += 1
            if depth == 1:
                sel = buf.strip()
                buf = ''
                j, d2 = i + 1, 1
                while j < len(text) and d2:
                    if text[j] == '{':
                        d2 += 1
                    elif text[j] == '}':
                        d2 -= 1
                    j += 1
                body = text[i + 1:j - 1]
                if sel.startswith('@media'):
                    blocks.extend(_simple_blocks(body))
                elif not sel.startswith('@'):
                    blocks.append((sel, body))
                depth = 0
                i = j
                continue
        buf += ch
        i += 1
    for sel, body in blocks:
        decls = _parse_decls(body)
        if not decls:
            continue
        for s in sel.split(','):
            s = s.strip()
            mt = _SEL.match(s)
            if not s or not mt:
                continue
            tag = mt.group(1) if mt.group(1) and mt.group(1) != '*' else None
            parts = re.findall(r'([.#])([\w-]+)', mt.group(2) or '')
            ids = tuple(n for k, n in parts if k == '#')
            cls = tuple(n for k, n in parts if k == '.')
            spec = (len(ids), len(cls), 1 if tag else 0)
            rules.append((spec, order, (tag, ids, cls), decls))
            order += 1
    rules.sort(key=lambda r: (r[0], r[1]))
    return rules


def _simple_blocks(body):
    return [(m.group(1).strip(), m.group(2)) for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', body)]


def _css_for(el, rules):
    if not rules:
        return {}
    tag = _local(el.tag)
    eid = el.get('id')
    cls = set((el.get('class') or '').split())
    out = {}
    for _spec, _o, (t, ids, cs), decls in rules:
        if t and t != tag:
            continue
        if ids and (len(ids) > 1 or ids[0] != eid):
            continue
        if cs and not all(c in cls for c in cs):
            continue
        out.update(decls)
    return out


def own_style(el, rules):
    """Declared values of `el`: presentation attributes < CSS rules < style=""."""
    d = {}
    for k in STYLE_PROPS:
        if k == 'xml:space':
            v = el.get(XML_SPACE)
        else:
            v = el.get(k)
        if v is not None:
            d[k] = v
    d.update({k: v for k, v in _css_for(el, rules).items() if k in STYLE_PROPS or k == 'font'})
    d.update({k: v for k, v in _parse_decls(el.get('style')).items() if k in STYLE_PROPS})
    return d


def compute_style(parent, own):
    """parent: computed style dict (inherited props only). font-size -> px float."""
    st = {k: parent.get(k) for k in INHERITED}
    for k, v in own.items():
        if k not in INHERITED or v is None:
            continue
        sv = str(v).strip()
        if sv == 'inherit':
            continue
        if k == 'font-size':
            st[k] = font_size_px(sv, parent.get('font-size') or 16.0)
        else:
            st[k] = sv
    return st


ROOT_STYLE = {'font-family': 'sans-serif', 'font-size': 16.0, 'text-anchor': 'start',
              'dominant-baseline': 'auto', 'letter-spacing': 'normal', 'word-spacing': 'normal',
              'writing-mode': 'horizontal-tb', 'fill': 'black', 'stroke': 'none', 'visibility': 'visible',
              'white-space': None, 'xml:space': 'default'}


# ---------------------------------------------------------------- text model
class _Char:
    __slots__ = ('ch', 'chain', 'style', 'own', 'preserve', 'x', 'y', 'dx', 'dy', 'rotate')

    def __init__(self, ch, chain, style, own, preserve):
        self.ch = ch
        self.chain = chain          # frozenset of element ordinals (text .. innermost)
        self.style = style
        self.own = own              # declared (non-inherited) props of the innermost element
        self.preserve = preserve
        self.x = self.y = self.rotate = None
        self.dx = self.dy = 0.0


class TextBlock:
    """One <text> element: positioned chars + its CTM (to svgelements px)."""

    def __init__(self, ctm, chars, layer, flags):
        self.ctm = ctm
        self.chars = chars
        self.layer = layer
        self.flags = flags          # {'textpath', 'vertical'}


def _preserve_of(style):
    ws = (style.get('white-space') or '').lower()
    if ws in ('pre', 'pre-wrap', 'break-spaces', 'pre-line'):
        return True
    if ws in ('normal', 'nowrap'):
        return False
    return (style.get('xml:space') or 'default') == 'preserve'


def _collect_text(text_el, style, rules, viewport, flags):
    """-> retained chars with positions assigned."""
    elems = []           # pre-order: (element, style, own)
    raw = []

    def visit(el, st, chain):
        own = own_style(el, rules)
        if str(own.get('display', '')).strip() == 'none':
            return
        cst = compute_style(st, own) if el is not text_el else st
        idx = len(elems)
        elems.append((el, cst, own))
        ch_chain = chain | {idx}
        tag = _local(el.tag)
        if tag == 'textPath':
            flags.add('textpath')
        pres = _preserve_of(cst)

        def add(s):
            for c in s or '':
                raw.append(_Char(c, ch_chain, cst, own, pres))
        add(el.text)
        for child in el:
            ctag = _local(child.tag)
            if ctag in ('tspan', 'textPath', 'a'):
                visit(child, cst, ch_chain)
            add(child.tail)

    visit(text_el, style, frozenset())
    # white space (SVG 1.1 xml:space / CSS white-space)
    chars = []
    for c in raw:
        ch = c.ch
        if c.preserve:
            if ch in '\r\n\t':
                ch = ' '
            c.ch = ch
            chars.append(c)
            continue
        if ch in '\r\n':
            continue
        if ch == '\t':
            ch = ' '
        if ch == ' ' and (not chars or chars[-1].ch == ' '):
            continue
        c.ch = ch
        chars.append(c)
    while chars and chars[-1].ch == ' ' and not chars[-1].preserve:
        chars.pop()
    # position attributes: pre-order, descendants override ancestors
    vw, vh = viewport
    for k, (el, cst, _own) in enumerate(elems):
        fs = cst.get('font-size') or 16.0
        mine = None
        for attr, ref in (('x', vw), ('y', vh), ('dx', vw), ('dy', vh), ('rotate', None)):
            raw_v = el.get(attr)
            if raw_v is None:
                continue
            if attr == 'rotate':
                lst = [float(v) for v in _NUM.findall(raw_v)] or None
            else:
                lst = parse_length_list(raw_v, fs, ref)
            if not lst:
                continue
            if mine is None:
                mine = [c for c in chars if k in c.chain]
            for i, c in enumerate(mine):
                if attr == 'rotate':
                    c.rotate = lst[min(i, len(lst) - 1)]
                elif i < len(lst):
                    setattr(c, attr, lst[i])
    return chars


def extract_text(path, root_ctm=IDENT, viewport=(100.0, 100.0), layers=None, stroke_filter=None):
    """-> ([TextBlock], warnings[str]). Honours display/visibility, <defs>, <use>."""
    tree = ET.parse(path)
    root = tree.getroot()
    rules = []
    by_id = {}
    for el in root.iter():
        t = _local(el.tag)
        if t == 'style':
            rules.extend(parse_css(''.join(el.itertext())))
        i = el.get('id')
        if i:
            by_id.setdefault(i, el)
    if rules:
        rules.sort(key=lambda r: (r[0], r[1]))
    blocks = []
    warns = []
    total = [0]
    flow = [False]

    def walk(el, ctm, st, layer, depth, via_use=False):
        if depth > 64:
            return
        tag = _local(el.tag)
        if tag in SKIP_TAGS and not (via_use and tag == 'symbol'):
            return
        if tag in ('flowRoot',):
            flow[0] = True
            return
        own = own_style(el, rules)
        if str(own.get('display', '')).strip() == 'none':
            return
        cst = compute_style(st, own)
        if el is not root:
            ctm = _mul(ctm, parse_transform(el.get('transform')))
        if tag == 'svg' and el is not root:
            ctm = _mul(ctm, (1, 0, 0, 1, parse_length(el.get('x'), 16, vw) or 0.0,
                             parse_length(el.get('y'), 16, vh) or 0.0))
        lab = el.get(INKSCAPE_LABEL) if el.get(INKSCAPE_GROUPMODE) == 'layer' else None
        if lab or (el.get(INKSCAPE_GROUPMODE) == 'layer' and el.get('id')):
            layer = lab or el.get('id')
        if tag == 'text':
            lay = layer or el.get(INKSCAPE_LABEL) or el.get('id')
            if layers and lay not in layers:
                return
            if stroke_filter:
                sf = str(stroke_filter).lower()
                if str(cst.get('stroke') or '').lower() != sf and str(cst.get('fill') or '').lower() != sf:
                    return
            flags = set()
            chars = _collect_text(el, cst, rules, (vw, vh), flags)
            chars = [c for c in chars if (c.style.get('visibility') or 'visible') not in ('hidden', 'collapse')]
            if total[0] + len(chars) > MAX_CHARS:
                chars = chars[:max(0, MAX_CHARS - total[0])]
                if 'too_many' not in warns:
                    warns.append('too_many')
            total[0] += len(chars)
            if (cst.get('writing-mode') or '').lower() in VERTICAL:
                flags.add('vertical')
            if chars:
                blocks.append(TextBlock(ctm, chars, lay, flags))
            return
        if tag == 'use':
            ref = el.get(XLINK_HREF) or el.get('href') or ''
            target = by_id.get(ref[1:]) if ref.startswith('#') else None
            if target is not None and target is not el:
                m = _mul(ctm, (1, 0, 0, 1, parse_length(el.get('x'), 16, vw) or 0.0,
                               parse_length(el.get('y'), 16, vh) or 0.0))
                walk(target, m, cst, layer, depth + 1, via_use=True)
            return
        for child in el:
            walk(child, ctm, cst, layer, depth + 1)

    vw, vh = viewport
    walk(root, root_ctm, dict(ROOT_STYLE), None, 0)
    if flow[0]:
        warns.append('flowroot')
    return blocks, warns


# ---------------------------------------------------------------- runs (metadata)
def text_runs(blocks, k_mm=1.0, limit=200):
    """Consecutive chars with the same font-family + size -> run summaries."""
    out = []
    for bi, b in enumerate(blocks):
        sc = _scale_of(b.ctm) * k_mm
        cur = None
        for c in b.chars:
            fam = c.style.get('font-family') or ''
            fs = float(c.style.get('font-size') or 16.0)
            key = (fam, round(fs, 4))
            if cur is None or cur['_k'] != key:
                cur = {'_k': key, 'text_index': bi, 'content': '', 'font_family': fam,
                       'families': split_families(fam), 'font_size': round(fs, 3),
                       'size_mm': round(fs * sc, 3), 'chars': 0}
                out.append(cur)
            cur['content'] += c.ch
            if not c.ch.isspace():
                cur['chars'] += 1
    res = []
    for r in out:
        r.pop('_k')
        r['content'] = r['content'].strip()
        if r['content']:
            r['content'] = r['content'][:200]
            res.append(r)
    return res[:limit]


def text_families(blocks):
    seen = []
    for b in blocks:
        for c in b.chars:
            f = c.style.get('font-family') or ''
            if f not in seen:
                seen.append(f)
    return seen


# ---------------------------------------------------------------- glyph metrics
class _Metrics:
    """Per-font em estimate + per-char (advance, x offset) in font units."""

    def __init__(self, font):
        self.font = font
        self.em = font_em_units(font)
        self.cache = {}

    def glyph(self, ch):
        r = self.cache.get(ch)
        if r is not None:
            return r
        f = self.font
        g = f.glyph(ch)
        em = self.em
        wide = unicodedata.east_asian_width(ch) in ('W', 'F')
        adv = getattr(g, 'advance', None) if g is not None else None
        if g is not None and g.ops:
            p = Path(list(g.coords), list(g.ops))
            bb = p.bbox()
            if bb is None:
                r = (None, adv or SPACE_EM * em, 0.0, False)
            elif adv:
                r = (g, float(adv), 0.0, False)
            elif wide:
                r = (g, em, (bb[0] + bb[2]) / 2.0 - em / 2.0, False)
            else:
                sb = SIDE_EM * em
                r = (g, (bb[2] - bb[0]) + 2 * sb, bb[0] - sb, False)
        elif adv:
            r = (None, float(adv), 0.0, False)
        elif ch == ' ' or unicodedata.category(ch) == 'Zs':
            r = (None, em if wide or ch == '　' else SPACE_EM * em, 0.0, False)
        elif unicodedata.category(ch) in ('Cc', 'Cf', 'Mn'):
            r = (None, 0.0, 0.0, False)
        else:
            r = (None, (1.0 if wide else 0.6) * em, 0.0, True)    # missing glyph
        self.cache[ch] = r
        return r


def font_em_units(font):
    """Estimated em size in font units (see module doc)."""
    cached = getattr(font, '_svg_em', None)
    if cached:
        return cached
    em = None
    for ch in CJK_REF:
        g = font.glyph(ch)
        if g is not None and getattr(g, 'advance', None):
            em = float(g.advance)
            break
    if em is None:
        for ch in CJK_REF[:3]:
            g = font.glyph(ch)
            if g is not None and g.ops:
                bb = Path(list(g.coords), list(g.ops)).bbox()
                if bb and bb[3] - bb[1] > 0:
                    em = (bb[3] - bb[1]) / CJK_INK_EM
                    break
    if em is None:
        g = font.glyph('H')
        if g is not None and g.ops:
            bb = Path(list(g.coords), list(g.ops)).bbox()
            if bb and bb[1] < 0:
                em = -bb[1] / CAP_EM
    if not em or em <= 0:
        em = float(getattr(font, 'size', 100.0) or 100.0) / 1.3
    try:
        font._svg_em = em
    except AttributeError:
        pass
    return em


# ---------------------------------------------------------------- layout
def _rand(rng, pair):
    if pair is None:
        return 1.0
    lo, hi = float(pair[0]), float(pair[1])
    if lo == hi:
        return lo
    return lo + rng.random() * (hi - lo)


def _spacing(v, fs):
    if v is None or str(v).strip().lower() in ('normal', 'inherit', ''):
        return 0.0
    px = parse_length(v, fs, fs)
    return px or 0.0


def _baseline_shift(c, fs):
    off = 0.0
    ab = str(c.own.get('alignment-baseline') or '').strip().lower()
    db = str(c.style.get('dominant-baseline') or '').strip().lower()
    key = ab if ab and ab not in ('auto', 'baseline', 'inherit') else db
    off += BASELINE_EM.get(key, 0.0) * fs
    bs = str(c.own.get('baseline-shift') or '').strip().lower()
    if bs == 'super':
        off -= 0.33 * fs
    elif bs == 'sub':
        off += 0.2 * fs
    elif bs and bs != 'baseline':
        v = parse_length(bs, fs, fs)
        if v:
            off -= v          # positive shift raises the text (y up)
    return off


def layout_block(block, font_for, size_scale=1.0, fonts_set=None, rng=None, missing=None,
                 missing_glyph='box', metrics_cls=None):
    """-> [Path] in svgelements px. font_for(families list) -> stroke font."""
    import random
    rng = rng or random.Random(0)
    fs_j = fonts_set
    metrics = {}
    vertical = 'vertical' in block.flags
    placed = []           # (chunk_id, glyph_path_local or None, x0, x_end)
    chunks = []           # [anchor, start, end]
    cx = cy = 0.0
    chunk = None
    for c in block.chars:
        st = c.style
        fs = float(st.get('font-size') or 16.0) * float(size_scale)
        newchunk = chunk is None
        if c.x is not None:
            cx = c.x
            newchunk = True
        if c.y is not None:
            cy = c.y
            newchunk = True
        cx += c.dx
        cy += c.dy
        if newchunk:
            chunk = [str(st.get('text-anchor') or 'start').strip().lower(), cx if not vertical else cy, None]
            chunks.append(chunk)
        fam = st.get('font-family') or ''
        font = font_for(split_families(fam))
        m = metrics.get(id(font))
        if m is None:
            m = metrics[id(font)] = (metrics_cls or _Metrics)(font)
        g, adv_u, ox, miss = m.glyph(c.ch)
        k = fs / m.em
        jfs = _rand(rng, fs_j.randomFontSize) if fs_j else 1.0
        sx = k * jfs * (_rand(rng, fs_j.randomXScale) if fs_j else 1.0)
        sy = k * jfs * (_rand(rng, fs_j.randomYScale) if fs_j else 1.0)
        rot = (_rand(rng, fs_j.randomRotate) if fs_j else 0.0) + (c.rotate or 0.0)
        jy = 0.0
        if fs_j:
            if fs_j.randomY:
                jy = rng.uniform(-fs_j.randomY, fs_j.randomY) * fs
            jy += (float(fs_j.baseLine) - 1.0) * 0.75 * fs
        adv = adv_u * k
        base = cy + _baseline_shift(c, fs) + jy
        if vertical:
            gx0 = cx - adv / 2.0
            base = cy + 0.88 * fs + jy
        else:
            gx0 = cx
        p = None
        if g is not None:
            co = g.coords
            out = []
            cs, sn = (math.cos(math.radians(rot)), math.sin(math.radians(rot))) if rot else (1.0, 0.0)
            for i in range(0, len(co), 2):
                lx = (co[i] - ox) * sx
                ly = co[i + 1] * sy
                if rot:
                    lx, ly = lx * cs - ly * sn, lx * sn + ly * cs
                out.append(gx0 + lx)
                out.append(base + ly)
            p = Path(out, list(g.ops))
        elif miss:
            if missing is not None:
                missing.add(c.ch)
            if missing_glyph != 'skip':
                p = Path()
                w = adv * 0.8
                p.rect(gx0 + adv * 0.1, base - 0.75 * fs, w, 0.85 * fs)
        if vertical:
            step = fs
        else:
            step = adv
        step += _spacing(st.get('letter-spacing'), fs)
        if c.ch == ' ':
            step += _spacing(st.get('word-spacing'), fs)
        if fs_j and fs_j.randomSpace and list(fs_j.randomSpace) != [1.0, 1.0]:
            step += (_rand(rng, fs_j.randomSpace) - 1.0) * 0.15 * fs
        if vertical:
            cy += step
            chunk[2] = cy
        else:
            cx += step
            chunk[2] = cx
        placed.append((len(chunks) - 1, p))
    # text-anchor per chunk
    shifts = []
    for anchor, start, end in chunks:
        width = (end if end is not None else start) - start
        if anchor == 'middle':
            shifts.append(-width / 2.0)
        elif anchor == 'end':
            shifts.append(-width)
        else:
            shifts.append(0.0)
    a, b, c_, d, e, f = block.ctm
    out = []
    for ci, p in placed:
        if p is None or not p.ops:
            continue
        sh = shifts[ci]
        co = p.coords
        for i in range(0, len(co), 2):
            x = co[i] + (0.0 if vertical else sh)
            y = co[i + 1] + (sh if vertical else 0.0)
            co[i] = a * x + c_ * y + e
            co[i + 1] = b * x + d * y + f
        out.append(p)
    return out


def estimate_bbox(blocks):
    """Font-independent bbox (svgelements px) of the text, for import metadata:
    ideographs 1 em wide, others 0.55 em, ink from -0.8 em to +0.1 em."""
    xs, ys = [], []

    class _Est:
        size = 100.0
        _svg_em = 100.0

        @staticmethod
        def glyph(ch):
            return None

    class _M(_Metrics):
        def glyph(self, ch):
            wide = unicodedata.east_asian_width(ch) in ('W', 'F')
            if ch.isspace():
                return (None, (100.0 if wide else 30.0), 0.0, False)
            w = 100.0 if wide else 55.0
            p = Path()
            p.rect(0.0, -80.0, w, 90.0)
            return (_G(p), w, 0.0, False)

    class _G:
        def __init__(self, p):
            self.coords, self.ops = p.coords, p.ops

    est = _Est()
    for b in blocks:
        for p in layout_block(b, lambda fams: est, metrics_cls=_M):
            bb = p.bbox()
            if bb:
                xs += [bb[0], bb[2]]
                ys += [bb[1], bb[3]]
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))
