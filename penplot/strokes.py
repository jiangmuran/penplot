# -*- coding: utf-8 -*-
"""Skeleton -> WRITING STROKES extraction (round-4 algorithm).

The plain skeleton walk (image.skeleton_to_paths) outputs graph segments:
every junction cuts a stroke, directions and order are arbitrary. This
module reconstructs human-like strokes:

  1. adaptive spur pruning (1.2 x stroke width, width from a chamfer
     distance transform of the ink)
  2. skeleton -> pixel graph; adjacent junction pixels merged into
     super-nodes
  3. edge polylines extracted between nodes (through degree-2 chains)
  4. at each super-node every incident edge direction is measured
     1..1.5 stroke widths away from the node; edges whose directions
     oppose within `join_deg` are one stroke passing through
  5. the deformed junction region is bridged with a straight segment
  6. stroke orientation (horizontals left->right, others top->bottom)
     and ordering (top->bottom, left->right, then nearest-neighbour
     with reversal allowed)
"""
import math

import numpy as np

from .geometry import Path
from .image import _NEIGHBORS, prune_spurs


# ---------------------------------------------------------------- width
def estimate_stroke_width(ink):
    """Stroke width from a distance transform of the ink.

    Every ink pixel gets its distance to the nearest background pixel
    (= half local thickness), computed by repeated binary erosion with
    alternating 4- / 8-neighbourhoods (octagonal metric, close to the
    old chamfer(1, 1.4) transform but ~w/2 cheap slicing passes instead of
    64 rounds of np.roll).
    width = 2 x 95th percentile of the distance over ink pixels.
    """
    m = np.asarray(ink) > 0.5
    if not m.any():
        return 1.5
    cur = np.pad(m, 1)
    dt = np.zeros(cur.shape, dtype=np.int16)
    k = 0
    while cur.any() and k < 256:
        dt += cur
        e = cur.copy()
        e[1:, :] &= cur[:-1, :]
        e[:-1, :] &= cur[1:, :]
        e[:, 1:] &= cur[:, :-1]
        e[:, :-1] &= cur[:, 1:]
        if k % 2:
            e[1:, 1:] &= cur[:-1, :-1]
            e[1:, :-1] &= cur[:-1, 1:]
            e[:-1, 1:] &= cur[1:, :-1]
            e[:-1, :-1] &= cur[1:, 1:]
        cur = e
        k += 1
    vals = dt[1:-1, 1:-1][m]
    return max(1.5, 2.0 * float(np.percentile(vals, 95)))


# ---------------------------------------------------------------- graph
_PATTERN_OFFS = [[(dy, dx) for k, (dx, dy) in enumerate(_NEIGHBORS) if code >> k & 1]
                 for code in range(256)]


def _adjacency(skel):
    """{(y, x): [8-neighbours in the skeleton, in _NEIGHBORS order]} built
    with one vectorised neighbourhood code per pixel (no per-call set probes)."""
    sk = np.pad(np.asarray(skel, dtype=bool), 1)
    ys, xs = np.nonzero(sk)
    if not len(ys):
        return {}
    code = np.zeros(len(ys), dtype=np.int32)
    for k, (dx, dy) in enumerate(_NEIGHBORS):
        code |= sk[ys + dy, xs + dx].astype(np.int32) << k
    adj = {}
    offs = _PATTERN_OFFS
    for y, x, c in zip((ys - 1).tolist(), (xs - 1).tolist(), code.tolist()):
        adj[(y, x)] = [(y + dy, x + dx) for dy, dx in offs[c]]
    return adj


def skeleton_strokes(ink, skel, join_deg=35.0, min_pts=3, debug=False):
    """Returns (strokes: list[Path in px coords], stroke_width)."""
    w = estimate_stroke_width(ink)
    spur = max(2, int(round(1.2 * w)))
    skel = prune_spurs(skel, min_len=spur, passes=3)
    adj = _adjacency(skel)
    pts = set(adj)
    if not pts:
        return [], w
    nbrs = adj.__getitem__
    deg = {p: len(v) for p, v in adj.items()}
    if debug:
        from collections import Counter
        print('  [dbg] w=%.1f spur=%d pts=%d deg=%s' %
              (w, spur, len(pts), dict(Counter(deg.values()))))

    # ---- super-nodes: cluster junction pixels within ~half a stroke width
    # (wide radius collapses Zhang-Suen diagonal "ladders" - parallel rails
    # joined by rungs - into a single junction region instead of a chain
    # of fake nodes that fragments every stroke)
    R = max(2, int(round(w * 0.5)))
    # (= connected components of the junction pixels under Chebyshev
    # distance <= R; junction pixels are few, so pairwise distances are cheap)
    jlist = sorted(p for p in pts if deg[p] >= 3)
    clusters = []
    if jlist:
        J = np.asarray(jlist, dtype=np.int32)
        par = list(range(len(jlist)))

        def find(a):
            while par[a] != a:
                par[a] = par[par[a]]
                a = par[a]
            return a
        for c0 in range(0, len(J), 512):          # bounded memory on huge glyphs
            B = J[c0:c0 + 512]
            close = np.maximum(np.abs(B[:, None, 0] - J[None, :, 0]),
                               np.abs(B[:, None, 1] - J[None, :, 1])) <= R
            ii, jj = np.nonzero(close)
            for i, j in zip((ii + c0).tolist(), jj.tolist()):
                if j > i:
                    ri, rj = find(i), find(j)
                    if ri != rj:
                        par[rj] = ri
        groups = {}
        for i, p in enumerate(jlist):
            groups.setdefault(find(i), set()).add(p)
        clusters = list(groups.values())
    node_of = {}
    for i, comp in enumerate(clusters):
        for p in comp:
            node_of[p] = i

    # ---- edges: walk from node borders / endpoints through deg-2 chains ----
    edges = []          # (nodeA or None, nodeB or None, chain incl. both ends)
    walked = set()

    def other_end(start, nxt, start_node):
        chain = [start, nxt]
        prev, cur = start, nxt
        while True:
            if cur in node_of:
                return start_node, node_of[cur], chain
            nn = [t for t in nbrs(cur) if t != prev]
            if len(nn) != 1:
                return start_node, None, chain
            prev, cur = cur, nn[0]
            chain.append(cur)

    seeds = []
    for i, comp in enumerate(clusters):
        for p in comp:
            for q in nbrs(p):
                if q not in comp:
                    seeds.append((p, q, i))
    for p in pts:
        if deg[p] <= 1:
            for q in nbrs(p):
                seeds.append((p, q, None))
    for (s, q, ni) in seeds:
        if (s, q) in walked or (q, s) in walked:
            continue
        walked.add((s, q))
        walked.add((q, s))
        a, b, chain = other_end(s, q, ni)
        # an arm may be seeded from BOTH its node end and its endpoint end;
        # register the far end's adjacent pair too so it is not walked twice
        if len(chain) >= 2:
            walked.add((chain[-1], chain[-2]))
            walked.add((chain[-2], chain[-1]))
        edges.append((a, b, chain))

    # closed loops with no node at all (exclude cluster interiors - those
    # pixels are junction regions, not strokes)
    node_pixels = set()
    for comp in clusters:
        node_pixels |= comp
    consumed = {p for (_a, _b, ch) in edges for p in ch}
    consumed |= node_pixels
    strokes = []
    leftover = pts - consumed
    while leftover:
        s0 = next(iter(leftover))
        comp = [s0]
        leftover.discard(s0)
        stack = [s0]
        while stack:
            cur = stack.pop()
            for q in nbrs(cur):
                if q in leftover:
                    leftover.discard(q)
                    comp.append(q)
                    stack.append(q)
        if len(comp) >= min_pts:
            strokes.append(_mk_path(comp))

    # ---- direction of each incident edge at each node (measured away) ----
    probe = max(2.0, min(1.5 * w, 12.0))

    def dir_at(chain, at_head):
        seq = chain if at_head else list(reversed(chain))
        acc = 0.0
        p0 = seq[0]
        for pt in seq[1:]:
            acc += 1.0
            if acc >= probe:
                return (pt[1] - p0[1], pt[0] - p0[0])
        if len(seq) > 1:
            return (seq[-1][1] - p0[1], seq[-1][0] - p0[0])
        return None

    incident = {}
    for ei, (a, b, chain) in enumerate(edges):
        if a is not None:
            incident.setdefault(a, []).append((ei, True))
        if b is not None and b != a:
            incident.setdefault(b, []).append((ei, False))

    def angle(v1, v2):
        d = v1[0] * v2[0] + v1[1] * v2[1]
        n1 = math.hypot(*v1) or 1.0
        n2 = math.hypot(*v2) or 1.0
        return math.degrees(math.acos(max(-1.0, min(1.0, d / (n1 * n2)))))

    pairs = []
    for ni, inc in incident.items():
        dirs = []
        for (ei, head) in inc:
            d = dir_at(edges[ei][2], head)
            if d is not None:
                dirs.append((ei, head, d))
        for i in range(len(dirs)):
            for j in range(i + 1, len(dirs)):
                e1, h1, d1 = dirs[i]
                e2, h2, d2 = dirs[j]
                a = angle(d1, d2)
                if a >= 180.0 - join_deg:      # nearly opposite => continuation
                    pairs.append((a, e1, h1, e2, h2))
    pairs.sort(reverse=True)
    if debug:
        none_ends = sum(1 for (a, b, _c) in edges if a is None and b is None)
        print('  [dbg] clusters=%d edges=%d(free=%d) incident_ends=%d join_pairs=%d' %
              (len(clusters), len(edges), none_ends,
               sum(len(v) for v in incident.values()), len(pairs)))
    end_matched = set()
    link = {}                        # (edge, head) -> (edge, head)
    for (_a, e1, h1, e2, h2) in pairs:
        if (e1, h1) in end_matched or (e2, h2) in end_matched:
            continue
        end_matched.add((e1, h1))
        end_matched.add((e2, h2))
        link[(e1, h1)] = (e2, not h2)
        link[(e2, h2)] = (e1, not h1)

    # ---- assemble strokes by following links ----
    visited = set()
    assemblies = 0
    for ei in range(len(edges)):
        if ei in visited:
            continue
        assemblies += 1
        # find a free end to start
        seq_edges = [ei]
        visited.add(ei)
        # walk backwards through link at head side
        cur_key = (ei, True)
        while cur_key in link and link[cur_key][0] not in visited:
            nxt, nxt_head = link[cur_key]
            visited.add(nxt)
            seq_edges.insert(0, nxt)
            cur_key = (nxt, nxt_head)
        # walk forward through link at tail side
        cur_key = (ei, False)
        while cur_key in link and link[cur_key][0] not in visited:
            nxt, nxt_head = link[cur_key]
            visited.add(nxt)
            seq_edges.append(nxt)
            cur_key = (nxt, nxt_head)
        # build one polyline; orient each edge to chain endpoints,
        # straight-bridging across merged junction clusters
        out = []
        for k, si in enumerate(seq_edges):
            chain = edges[si][2]
            if k == 0:
                out.extend(chain)
            else:
                if out and out[-1] == chain[0]:
                    out.extend(chain[1:])
                elif out and out[-1] == chain[-1]:
                    out.extend(list(reversed(chain))[1:])
                else:
                    # bridge the junction cluster with a straight jump
                    near = chain[0] if (out and _d(chain[0], out[-1]) <=
                                        _d(chain[-1], out[-1])) else chain[-1]
                    out.append(near)
                    rest = chain[1:] if near == chain[0] else list(reversed(chain))[1:]
                    out.extend(rest)
        if len(out) >= min_pts:
            strokes.append(_mk_path(out))

    # node-free edges (both ends open) are already in edges -> emitted above
    for ei, (a, b, chain) in enumerate(edges):
        if ei in visited:
            continue
        visited.add(ei)
        if len(chain) >= min_pts and (a is None or b is None or a != b):
            strokes.append(_mk_path(chain))

    orient_and_order(strokes, width=w)
    if debug:
        print('  [dbg] assemblies=%d emitted=%d' % (assemblies, len(strokes)))
    return strokes, w


def _d(a, b):
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def _mk_path(chain):
    p = Path()
    a = np.asarray(chain, dtype=np.float64)
    p.coords = (a[:, ::-1] + 0.5).ravel().tolist()
    p.ops = [0] + [1] * (len(chain) - 1)
    return p


# ---------------------------------------------------------------- orient/order
def orient_and_order(paths, width=None, nn_reverse=False):
    """Horizontals left->right, others top->bottom; order top->bottom /
    left->right (row-quantised), then nearest-neighbour. nn_reverse (for
    travel optimisation) is OFF by default because reversing would undo
    the writing direction - the gcode stage already optimises travel."""
    for p in paths:
        if len(p.ops) < 2:
            continue
        xs = p.coords[0::2]
        ys = p.coords[1::2]
        h = max(ys) - min(ys)
        wd = max(xs) - min(xs)
        if h >= 0.5 * wd:
            # vertical-ish (incl. 撇/捺 diagonals): write top -> bottom
            if p.coords[1] > p.coords[-1]:
                p.reverse()
        else:
            if p.coords[0] > p.coords[-2]:
                p.reverse()
    q = max(1.0, (width or 4.0) * 1.5)

    def key(p):
        return (round(min(p.coords[1::2]) / q), min(p.coords[0::2]))

    paths.sort(key=key)
    if not nn_reverse:
        return
    if len(paths) > 2:
        remaining = paths[1:]
        ordered = [paths[0]]
        while remaining:
            cx, cy = ordered[-1].coords[-2], ordered[-1].coords[-1]
            best = best_d = best_rev = None
            for i, p in enumerate(remaining):
                for rev in (False, True):
                    ex, ey = (p.coords[-2], p.coords[-1]) if rev \
                        else (p.coords[0], p.coords[1])
                    d = (ex - cx) ** 2 + (ey - cy) ** 2
                    if best_d is None or d < best_d:
                        best_d, best, best_rev = d, i, rev
            p = remaining.pop(best)
            if best_rev:
                p.reverse()
            ordered.append(p)
        paths[:] = ordered
