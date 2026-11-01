# -*- coding: utf-8 -*-
"""Image to toolpath: edge tracing (Canny), skeletonising (Zhang-Suen),
and laser dot-halftone with power/dwell modulation.

Pure numpy + Pillow (no OpenCV / scikit-image needed; `thin()` uses
scikit-image when it is installed). Everything that touches every pixel is
vectorised; the only per-pixel Python loop left is the stroke walk over the
(sparse) 1-px edge/skeleton pixels. Output paths are in pixel coordinates
(y down, origin at top-left, +0.5 pixel centres).

Speed notes (Orange Pi Zero 3, A53): the caller should trace at a working
resolution derived from the output size (see `working_px`), not at camera
resolution; `load_gray` decodes JPEGs at reduced DCT scale and area-averages
down to that size.
"""
import itertools
import math

import numpy as np

from .geometry import Path, MOVE, LINE

# (dx, dy) ring, clockwise from top-left (kept for penplot.strokes)
_NEIGHBORS = [(-1, -1), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0)]


# ---------------------------------------------------------------- load
def working_px(img_w, img_h, width_mm=None, px_per_mm=8.0, max_px=1200, step=100):
    """Long side (px) to trace at: enough for `px_per_mm` at the output width,
    rounded UP to a multiple of `step` (so small rescales of the element hit
    the same trace cache entry), capped by `max_px` and the image itself."""
    long_side = max(img_w, img_h)
    lim = long_side
    if max_px:
        lim = min(lim, int(max_px))
    if width_mm and px_per_mm and img_w:
        want = float(width_mm) * float(px_per_mm) * long_side / float(img_w)
        want = int(math.ceil(want / step) * step) if step else int(math.ceil(want))
        lim = min(lim, max(step or 1, want))
    return max(1, int(lim))


def image_size(path):
    """(w, h) as displayed (EXIF orientation applied), without decoding."""
    from PIL import Image
    with Image.open(path) as im:
        w, h = im.size
        try:
            o = im.getexif().get(0x0112, 1)
        except Exception:
            o = 1
    return (h, w) if o in (5, 6, 7, 8) else (w, h)


def load_gray(path, invert=False, max_px=None):
    """Return float32 array 0..1 where 1 = ink (dark), long side <= max_px.

    EXIF orientation is applied (phone photos), transparency is composited on
    white (logos), JPEGs are decoded at reduced DCT scale when possible and
    the final downscale is area-averaged (no aliasing)."""
    from PIL import Image, ImageOps
    with Image.open(path) as im:
        if max_px and im.format == 'JPEG' and max(im.size) > max_px:
            k = max_px / float(max(im.size))
            try:
                im.draft('L', (int(math.ceil(im.size[0] * k)), int(math.ceil(im.size[1] * k))))
            except Exception:
                pass
        im = ImageOps.exif_transpose(im)
        if im.mode in ('RGBA', 'LA', 'PA') or (im.mode == 'P' and 'transparency' in im.info):
            im = im.convert('RGBA')
            bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
            bg.alpha_composite(im)
            im = bg
        if im.mode != 'L':
            im = im.convert('L')
        if max_px and max(im.size) > max_px:
            k = max_px / float(max(im.size))
            im = im.resize((max(1, int(round(im.size[0] * k))), max(1, int(round(im.size[1] * k)))),
                           Image.BOX)
        a = np.asarray(im, dtype=np.float32)
    ink = 1.0 - a * np.float32(1.0 / 255.0)
    if invert:
        ink = 1.0 - ink
    return ink


# ---------------------------------------------------------------- gaussian/sobel
def _gaussian_kernel(sigma=1.4, radius=None):
    if radius is None:
        radius = int(math.ceil(sigma * 3))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    g = np.exp(-(x * x) / (2 * sigma * sigma))
    g /= g.sum()
    return g


def blur(a, sigma=1.4):
    """Separable gaussian, edge-replicated borders (float32)."""
    a = np.asarray(a, dtype=np.float32)
    if sigma <= 0:
        return a.copy()
    k = _gaussian_kernel(sigma).astype(np.float32)
    r = len(k) // 2
    h, w = a.shape
    p = np.pad(a, ((r, r), (0, 0)), mode='edge')
    v = k[0] * p[0:h]
    for i in range(1, len(k)):
        v += k[i] * p[i:i + h]
    p = np.pad(v, ((0, 0), (r, r)), mode='edge')
    out = k[0] * p[:, 0:w]
    for i in range(1, len(k)):
        out += k[i] * p[:, i:i + w]
    return out


def _sobel(a):
    p = np.pad(np.asarray(a, dtype=np.float32), 1, mode='edge')
    h, w = a.shape
    s = lambda dy, dx: p[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]  # noqa: E731
    gx = (s(-1, 1) + 2 * s(0, 1) + s(1, 1)) - (s(-1, -1) + 2 * s(0, -1) + s(1, -1))
    gy = (s(1, -1) + 2 * s(1, 0) + s(1, 1)) - (s(-1, -1) + 2 * s(-1, 0) + s(-1, 1))
    return gx, gy


# ---------------------------------------------------------------- sparse labelling
def _components(mask, join=True):
    """8-connected components of a sparse bool mask, via its stroke chains.
    -> (chains [flat padded indices], component root per chain, W2).
    The pixels are walked into chains (`_walk`), then chains that touch
    anywhere are merged with a union-find over chain ids (far fewer items
    than pixels)."""
    code, W2 = _line_graph(mask)
    fg = np.flatnonzero(np.pad(np.asarray(mask, dtype=bool), 1).ravel())
    if fg.size == 0:
        return [], [], W2
    chains = _walk(code, W2, fg, join=join)
    owner = np.full(code.size, -1, dtype=np.int64)
    for ci, c in enumerate(chains):
        owner[c] = ci
    parent = list(range(len(chains)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    for d, (dx, dy) in enumerate(_NEIGHBORS):
        src = fg[(code[fg] >> d) & 1 == 1]
        if not src.size:
            continue
        a = owner[src]
        b = owner[src + (dy * W2 + dx)]
        m = a != b
        if not m.any():
            continue
        pairs = np.unique(np.stack([np.minimum(a[m], b[m]), np.maximum(a[m], b[m])], 1), axis=0)
        for x, y in pairs.tolist():
            rx, ry = find(x), find(y)
            if rx != ry:
                parent[max(rx, ry)] = min(rx, ry)
    return chains, [find(i) for i in range(len(chains))], W2


# ---------------------------------------------------------------- canny
_TAN22 = math.tan(math.radians(22.5))


def _canny_nms(ink, low, high, sigma):
    a = blur(ink, sigma)
    gx, gy = _sobel(a)
    mag = np.hypot(gx, gy)
    h, w = mag.shape
    pm = np.pad(mag, 1)
    s = lambda dy, dx: pm[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]  # noqa: E731
    # quantise the gradient direction (edge normal) to 4 bins without atan2
    ax, ay = np.abs(gx), np.abs(gy)
    q0 = ay < _TAN22 * ax                      # ~horizontal gradient
    q2 = ~q0 & (ay * _TAN22 >= ax)             # ~vertical gradient
    q1 = ~q0 & ~q2 & ((gx > 0) == (gy > 0))    # down-right diagonal
    a1 = np.where(q0, s(0, -1), np.where(q1, s(-1, -1), np.where(q2, s(-1, 0), s(-1, 1))))
    a2 = np.where(q0, s(0, 1), np.where(q1, s(1, 1), np.where(q2, s(1, 0), s(1, -1))))
    keep = (mag >= a1) & (mag >= a2)
    keep[0, :] = keep[-1, :] = keep[:, 0] = keep[:, -1] = False
    nms = np.where(keep, mag, np.float32(0))
    mx = float(nms.max()) if nms.size else 0.0
    if mx <= 0:
        z = np.zeros(mag.shape, dtype=bool)
        return z, z
    strong = nms >= (high if high else 0.25) * mx
    cand = nms >= (low if low else 0.10) * mx
    return strong, cand


def _hysteresis(strong, cand):
    """Candidate components that contain a strong pixel -> (chains, W2)."""
    chains, root, W2 = _components(cand)
    if not chains:
        return [], W2
    ps = np.pad(strong, 1).ravel()
    good = set()
    for c, r in zip(chains, root):
        if r not in good and ps[c].any():
            good.add(r)
    return [c for c, r in zip(chains, root) if r in good], W2


def canny(ink, low=None, high=None, sigma=1.4):
    """Bool edge mask. Thresholds are fractions of max gradient (default .10/.25)."""
    strong, cand = _canny_nms(ink, low, high, sigma)
    chains, W2 = _hysteresis(strong, cand)
    h, w = cand.shape
    flat = np.zeros((h + 2) * W2, dtype=bool)
    for c in chains:
        flat[c] = True
    return flat.reshape(h + 2, W2)[1:-1, 1:-1].copy()


def canny_lines(ink, low=None, high=None, sigma=1.4, min_points=6):
    """Canny edges traced straight into centre-line polylines ((n,2) px
    arrays); reuses the hysteresis chains instead of re-walking the mask."""
    strong, cand = _canny_nms(ink, low, high, sigma)
    chains, W2 = _hysteresis(strong, cand)
    return _chains_to_xy(chains, W2, min_points)


# ---------------------------------------------------------------- contour tracing
def mask_to_paths(mask, min_points=6):
    """Moore-neighbour contour tracing of a binary mask -> list[Path] (px).
    Closed outlines (for filled regions). 1-px edge maps are better traced
    with `edges_to_paths` (centre lines, drawn once instead of twice)."""
    pts = set(zip(*np.nonzero(mask)))
    order = sorted(pts)
    oi = 0
    paths = []
    while pts:
        while order[oi] not in pts:
            oi += 1
        start = order[oi]
        contour = _trace_contour(pts, start)
        for p in contour:
            pts.discard(p)
        if len(contour) >= min_points:
            pa = Path()
            pa.move_to(contour[0][1] + 0.5, contour[0][0] + 0.5)
            for (y, x) in contour[1:]:
                pa.line_to(x + 0.5, y + 0.5)
            pa.close()
            paths.append(pa)
    return paths


def _trace_contour(pts, start):
    """Moore boundary following; returns closed pixel ring."""
    if len(pts) == 1:
        return [start]
    contour = [start]
    d0 = None
    for k, (dx, dy) in enumerate(_NEIGHBORS):
        if (start[0] + dy, start[1] + dx) in pts:
            d0 = k
            break
    if d0 is None:
        return contour
    cur = start
    d = d0
    while True:
        for step in range(8):
            k = (d + step) % 8
            dy, dx = _NEIGHBORS[k][1], _NEIGHBORS[k][0]
            nxt = (cur[0] + dy, cur[1] + dx)
            if nxt in pts:
                contour.append(nxt)
                cur = nxt
                d = (k + 5) % 8
                break
        else:
            break
        if cur == start:
            break
        if len(contour) > 4 and cur == contour[1] and contour[-1] == start:
            break
        if len(contour) > 200000:
            break
    return contour


# ---------------------------------------------------------------- thinning
def thin(ink, threshold=0.5):
    """Best available thinning: scikit-image (Lee'94, clean diagonals)
    when installed, else the built-in Zhang-Suen (leaves ladder artefacts
    on diagonal strokes). Returns bool skeleton (same shape as ink)."""
    try:
        from skimage.morphology import skeletonize
        return skeletonize(np.asarray(ink) > threshold)
    except ImportError:
        return zhang_suen(ink, threshold)


def _zs_luts():
    """Zhang-Suen deletion tables indexed by the 8-neighbour code
    bit k-2 = P_k (k = 2..9)."""
    l0 = np.zeros(256, dtype=bool)
    l1 = np.zeros(256, dtype=bool)
    for c in range(256):
        p = [(c >> i) & 1 for i in range(8)]       # p[0]=P2 .. p[7]=P9
        B = sum(p)
        A = sum(1 for i in range(8) if p[i] == 0 and p[(i + 1) % 8] == 1)
        if not (2 <= B <= 6 and A == 1):
            continue
        p2, p4, p6, p8 = p[0], p[2], p[4], p[6]
        l0[c] = p2 * p4 * p6 == 0 and p4 * p6 * p8 == 0
        l1[c] = p2 * p4 * p8 == 0 and p2 * p6 * p8 == 0
    return l0, l1


_ZS = None


def zhang_suen(ink, threshold=0.5):
    """Zhang-Suen thinning. ink: float 0..1 (1=ink) or bool. Returns bool
    skeleton of the same shape. Parallel sub-iterations, evaluated only at
    pixels whose neighbourhood changed (sparse): O(ink pixels), not
    O(iterations x image)."""
    global _ZS
    if _ZS is None:
        _ZS = _zs_luts()
    a = np.asarray(ink)
    b = a if a.dtype == bool else a > threshold
    pm = np.pad(b, 1).astype(np.uint8)
    W2 = pm.shape[1]
    f = pm.ravel()
    # P2..P9 exactly as the reference roll()-based implementation (row +1 first)
    offs = np.array([W2, W2 + 1, 1, -W2 + 1, -W2, -W2 - 1, -1, W2 - 1], dtype=np.int64)
    cand = np.flatnonzero(f)
    stamp = np.zeros(f.size, dtype=np.int64)
    removed = [np.empty(0, np.int64), np.empty(0, np.int64)]
    k = 0
    while True:
        if k >= 2:
            ch = np.concatenate(removed)
            if ch.size == 0:
                break
            nb = (ch[None, :] + offs[:, None]).ravel()
            nb = nb[f[nb] == 1]
            # de-duplicate without sorting: last writer wins
            ar = np.arange(nb.size, dtype=np.int64)
            stamp[nb] = ar
            cand = nb[stamp[nb] == ar]
        elif k == 1:
            cand = np.flatnonzero(f)
        if cand.size:
            code = np.zeros(cand.size, dtype=np.uint8)
            for i, o in enumerate(offs):
                code |= f[cand + o] << i
            rem = cand[_ZS[k & 1][code]]
            f[rem] = 0
        else:
            rem = np.empty(0, np.int64)
        removed = [removed[1], rem]
        k += 1
    return pm[1:-1, 1:-1].astype(bool)


def prune_spurs(skel, min_len=6, passes=2):
    """Remove short spurious branches from a skeleton (thinning artefacts).

    A spur is a chain hanging off a junction that is shorter than min_len.
    Real handwriting has few junctions; this keeps stroke counts sane.
    """
    pm = np.pad(np.asarray(skel, dtype=bool), 1)
    H2, W2 = pm.shape
    offs = [dy * W2 + dx for dx, dy in _NEIGHBORS]
    f = bytearray(pm.ravel().astype(np.uint8).tobytes())

    def neighbours(i):
        return [i + o for o in offs if f[i + o]]

    for _ in range(passes):
        nbc = np.zeros(pm.shape, dtype=np.uint8)
        cur_m = np.frombuffer(bytes(f), dtype=np.uint8).reshape(pm.shape)
        for dx, dy in _NEIGHBORS:
            nbc += np.roll(np.roll(cur_m, -dy, 0), -dx, 1)
        endpoints = np.flatnonzero((cur_m == 1) & (nbc == 1)).tolist()
        removed = False
        for ep in endpoints:
            if not f[ep]:
                continue
            chain = [ep]
            cur = ep
            prev = None
            while True:
                nbs = [q for q in neighbours(cur) if q != prev]
                if len(nbs) != 1:
                    break
                prev, cur = cur, nbs[0]
                chain.append(cur)
                if len(chain) > min_len + 2:
                    break
            if 1 < len(chain) <= min_len:
                for q in chain[:-1] if len(neighbours(chain[-1])) > 2 else chain:
                    f[q] = 0
                    removed = True
        if not removed:
            break
    out = np.frombuffer(bytes(f), dtype=np.uint8).reshape(pm.shape)[1:-1, 1:-1]
    return out.astype(bool)


# ---------------------------------------------------------------- stroke walk
_BITS = [tuple(d for d in range(8) if (c >> d) & 1) for c in range(256)]
_DEG = np.array([len(b) for b in _BITS], dtype=np.uint8)


def _line_graph(mask):
    """1-padded mask -> (flat neighbour bit codes as bytes, padded width).
    Diagonal links are dropped where a 4-connected detour through a shared
    neighbour exists, so stair-stepped lines become simple chains (degree 2)
    and only real junctions have degree >= 3."""
    pm = np.pad(np.asarray(mask, dtype=bool), 1)
    W2 = pm.shape[1]

    def sh(dy, dx):
        return np.roll(np.roll(pm, -dy, 0), -dx, 1)       # sh[y,x] = pm[y+dy, x+dx]
    code = np.zeros(pm.shape, dtype=np.uint8)
    for d, (dx, dy) in enumerate(_NEIGHBORS):
        link = sh(dy, dx)
        if dx and dy:
            link = link & ~sh(dy, 0) & ~sh(0, dx)
        code |= (link & pm).astype(np.uint8) << d
    return code.ravel(), W2


def _walk(code, W2, fg, join=True):
    """Greedy direction-continuous walk over the link graph -> list of
    chains (lists of flat padded indices)."""
    bits = code.tobytes()
    offs = [dy * W2 + dx for dx, dy in _NEIGHBORS]
    nbr_offs = [tuple(offs[d] for d in _BITS[c]) for c in range(256)]
    deg = _DEG[code[fg]]
    starts = fg[deg == 1].tolist() + fg.tolist()
    visited = bytearray(len(bits))
    chains = []
    for s in starts:
        if visited[s]:
            continue
        visited[s] = 1
        chain = [s]
        cur = s
        while True:
            nx = [cur + o for o in nbr_offs[bits[cur]] if not visited[cur + o]]
            if not nx:
                break
            if len(nx) == 1:
                cur = nx[0]
            else:
                ref = chain[-5] if len(chain) >= 5 else chain[0]
                ry, rx = divmod(cur, W2)
                qy, qx = divmod(ref, W2)
                dy, dx = ry - qy, rx - qx
                if dy == 0 and dx == 0:
                    cur = nx[0]
                else:
                    best, bs = None, -9.0
                    for q in nx:
                        sy, sx = divmod(q - cur + W2 + 1, W2)
                        sy -= 1
                        sx -= 1
                        sc = (sy * dy + sx * dx) / (1.4142 if (sy and sx) else 1.0)
                        if sc > bs:
                            best, bs = q, sc
                    cur = best
            visited[cur] = 1
            chain.append(cur)
        if join:
            prev = chain[-2] if len(chain) > 1 else -1
            for o in nbr_offs[bits[cur]]:
                q = cur + o
                if q != prev and (q != s or len(chain) > 2):
                    chain.append(q)
                    break
        chains.append(chain)
    return chains


def trace_lines(mask, min_points=2, join=True, reduce=True):
    """Trace a 1-px-wide mask (skeleton or Canny edges) into polylines.
    -> list of (n, 2) float arrays (x, y) at pixel centres.

    Direction-continuous greedy walk: the pen keeps going straight through
    junctions/crossings (the way a person writes), starting strokes at
    endpoints, then at leftover pixels (loops). With `join`, a stroke that
    runs into an already drawn one ends ON it (no 1-px gap) and loops close.
    `reduce` cuts stair corners and collapses straight runs (exact; use it
    before RDP); without it every pixel is a vertex.
    """
    code, W2 = _line_graph(mask)
    fg = np.flatnonzero(np.pad(np.asarray(mask, dtype=bool), 1).ravel())
    if fg.size == 0:
        return []
    return _chains_to_xy(_walk(code, W2, fg, join), W2, min_points, reduce)


def _chains_to_xy(chains, W2, min_points, reduce=True):
    """Chains of flat padded indices -> (n,2) px arrays, with stair corners
    cut and straight runs collapsed; vectorised over all chains at once."""
    chains = [c for c in chains if len(c) >= min_points]
    if not chains:
        return []
    lens = np.fromiter((len(c) for c in chains), dtype=np.int64, count=len(chains))
    flat = np.fromiter(itertools.chain.from_iterable(chains), dtype=np.int64, count=int(lens.sum()))
    y, x = np.divmod(flat, W2)
    xy = np.stack([x - 0.5, y - 0.5], axis=1)    # -1 pad, +0.5 centre
    if not reduce:
        return np.split(xy, np.cumsum(lens)[:-1])
    end = np.cumsum(lens)
    first = np.zeros(flat.size, dtype=bool)
    first[end - lens] = True
    last = np.zeros(flat.size, dtype=bool)
    last[end - 1] = True
    interior = ~(first | last)
    keep = _cut_mask(xy, interior)
    xy, interior, lens = xy[keep], interior[keep], np.add.reduceat(keep.astype(np.int64), end - lens)
    # straight runs: drop interior points where the step does not change
    n = xy.shape[0]
    if n > 2:
        st = np.diff(xy, axis=0)
        same = np.zeros(n, dtype=bool)
        same[1:-1] = np.all(st[1:] == st[:-1], axis=1)
        keep = ~(same & interior)
        xy, lens = xy[keep], np.add.reduceat(keep.astype(np.int64), np.cumsum(lens) - lens)
    return np.split(xy, np.cumsum(lens)[:-1])


def _cut_mask(xy, interior):
    """Keep-mask that drops the inner pixel of 4-connected L steps (takes the
    diagonal), every other one along a staircase (8-connected result)."""
    n = len(xy)
    keep = np.ones(n, dtype=bool)
    if n < 3:
        return keep
    d = np.abs(xy[2:] - xy[:-2])
    cand = np.zeros(n, dtype=bool)
    cand[1:-1] = (d[:, 0] == 1) & (d[:, 1] == 1)
    cand &= interior
    if not cand.any():
        return keep
    i = np.arange(n)
    starts = np.where(cand & ~np.concatenate([[False], cand[:-1]]), i, 0)
    run0 = np.maximum.accumulate(starts)
    keep[cand & (((i - run0) & 1) == 0)] = False
    return keep


def _rdp_py(xl, yl, eps2):
    n = len(xl)
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        s, e = stack.pop()
        if e - s < 2:
            continue
        ax, ay, bx, by = xl[s], yl[s], xl[e], yl[e]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        dmax, idx = -1.0, -1
        for i in range(s + 1, e):
            px, py = xl[i] - ax, yl[i] - ay
            if l2 > 0:
                t = (px * dx + py * dy) / l2
                t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                px -= t * dx
                py -= t * dy
            d = px * px + py * py
            if d > dmax:
                dmax, idx = d, i
        if dmax > eps2:
            keep[idx] = True
            stack.append((s, idx))
            stack.append((idx, e))
    return keep


def rdp_xy(xy, eps):
    """Ramer-Douglas-Peucker on an (n, 2) array -> simplified (m, 2) array.
    Long spans are measured with numpy, short ones in plain Python."""
    n = len(xy)
    if n < 3 or eps <= 0:
        return xy
    if n <= 40:
        xl, yl = xy[:, 0].tolist(), xy[:, 1].tolist()
        if not (xl[0] == xl[-1] and yl[0] == yl[-1]):
            return xy[_rdp_py(xl, yl, eps * eps)]
    # exact pre-pass: drop interior points of straight pixel runs
    st = np.diff(xy, axis=0)
    turn = np.any(st[1:] != st[:-1], axis=1)
    if not turn.all():
        m = np.ones(n, dtype=bool)
        m[1:-1] = turn
        xy = xy[m]
        n = len(xy)
        if n < 3:
            return xy
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    X = xy[:, 0]
    Y = xy[:, 1]
    xl = X.tolist()
    yl = Y.tolist()
    closed = xl[0] == xl[-1] and yl[0] == yl[-1]
    if closed and n > 3:
        # split a ring at its farthest point so both halves are well-defined
        far = int(np.argmax((X - xl[0]) ** 2 + (Y - yl[0]) ** 2))
        keep[far] = True
        stack = [(0, far), (far, n - 1)]
    else:
        stack = [(0, n - 1)]
    e2 = eps * eps
    while stack:
        s, e = stack.pop()
        if e - s < 2:
            continue
        ax, ay, bx, by = xl[s], yl[s], xl[e], yl[e]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        if e - s > 24:
            px = X[s + 1:e] - ax
            py = Y[s + 1:e] - ay
            if l2 > 0:
                t = np.clip((px * dx + py * dy) / l2, 0.0, 1.0)
                d = (px - t * dx) ** 2 + (py - t * dy) ** 2
            else:
                d = px * px + py * py
            i = int(np.argmax(d))
            dmax, idx = float(d[i]), s + 1 + i
        else:
            dmax, idx = -1.0, -1
            for i in range(s + 1, e):
                px, py = xl[i] - ax, yl[i] - ay
                if l2 > 0:
                    t = (px * dx + py * dy) / l2
                    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                    px -= t * dx
                    py -= t * dy
                d = px * px + py * py
                if d > dmax:
                    dmax, idx = d, i
        if dmax > e2:
            keep[idx] = True
            stack.append((s, idx))
            stack.append((idx, e))
    return xy[keep]


def arrays_to_paths(polys, scale=1.0, close=False):
    """(n, 2) arrays -> list[Path], optionally scaled."""
    out = []
    for a in polys:
        if scale != 1.0:
            a = a * scale
        c = a.ravel().tolist()
        if len(c) < 4:
            continue
        p = Path(c, [MOVE] + [LINE] * (len(c) // 2 - 1))
        if close:
            p.close()
        out.append(p)
    return out


def skeleton_to_paths(skel, min_points=2):
    """Trace skeleton into polylines (list[Path], px)."""
    return arrays_to_paths(trace_lines(skel, min_points=min_points, reduce=False))


def edges_to_paths(edges, min_points=6):
    """Trace a Canny edge map into centre-line polylines (list[Path], px)."""
    return arrays_to_paths(trace_lines(edges, min_points=min_points, reduce=False))


# ---------------------------------------------------------------- halftone dots
def halftone_dots(ink, spacing_px, gamma=1.0):
    """Sample grid -> (xs, ys, darkness 0..1) in pixel coordinates (y down)."""
    h, w = ink.shape
    sp = max(1, int(spacing_px))
    ys = np.arange(int(spacing_px / 2), h, sp)
    xs = np.arange(int(spacing_px / 2), w, sp)
    if not len(ys) or not len(xs):
        return [], [], []
    v = np.asarray(ink, dtype=np.float64)[np.ix_(ys, xs)]
    yy, xx = np.meshgrid(ys, xs, indexing='ij')
    m = v > 0.02
    vals = np.minimum(1.0, v[m]) ** gamma
    return (xx[m] + 0.5).tolist(), (yy[m] + 0.5).tolist(), vals.tolist()


# ---------------------------------------------------------------- to mm
def paths_to_mm(paths, width_mm, img_w, flip_y=True):
    s = width_mm / float(img_w)
    for p in paths:
        c = p.coords
        for i in range(0, len(c), 2):
            c[i] *= s
            c[i + 1] = c[i + 1] * s * (-1.0 if flip_y else 1.0)
    return paths


def dots_to_mm(xs, ys, vs, width_mm, img_w, flip_y=True):
    s = width_mm / float(img_w)
    if flip_y:
        return [x * s for x in xs], [-y * s for y in ys], vs
    return [x * s for x in xs], [y * s for y in ys], vs
