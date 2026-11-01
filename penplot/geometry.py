# -*- coding: utf-8 -*-
"""Geometry engine: Path entity + affine transforms + RDP simplification.

Faithful port of the original app.g.e (path), g.f (iterator) and j.a
(AffineTransform wrapper). Coordinates are floats, ops: 0=moveTo, 1=lineTo.
"""
import math

MOVE, LINE = 0, 1


class Affine2D:
    """Java AffineTransform semantics: [m00 m01 m02; m10 m11 m12]."""

    __slots__ = ('m00', 'm01', 'm02', 'm10', 'm11', 'm12')

    def __init__(self):
        self.m00 = self.m11 = 1.0
        self.m01 = self.m02 = self.m10 = self.m12 = 0.0

    def clone(self) -> 'Affine2D':
        a = Affine2D()
        (a.m00, a.m01, a.m02, a.m10, a.m11, a.m12) = (
            self.m00, self.m01, self.m02, self.m10, self.m11, self.m12)
        return a

    @staticmethod
    def _mul(x, a, b):  # compose: x = x * a  (x.concatenate(a))
        (a00, a01, a02, a10, a11, a12) = (a.m00, a.m01, a.m02, a.m10, a.m11, a.m12)
        b00 = x.m00 * a00 + x.m01 * a10
        b01 = x.m00 * a01 + x.m01 * a11
        b02 = x.m00 * a02 + x.m01 * a12 + x.m02
        b10 = x.m10 * a00 + x.m11 * a10
        b11 = x.m10 * a01 + x.m11 * a11
        b12 = x.m10 * a02 + x.m11 * a12 + x.m12
        x.m00, x.m01, x.m02, x.m10, x.m11, x.m12 = b00, b01, b02, b10, b11, b12

    # post-concatenate (applied to result coords afterwards) - Java concatenate()
    def translate(self, tx: float, ty: float) -> 'Affine2D':
        t = Affine2D(); t.m02, t.m12 = tx, ty
        self._post(t)
        return self

    def _post(self, t: 'Affine2D'):
        Affine2D._mul(self, t, None)

    def scale(self, sx: float, sy: float) -> 'Affine2D':
        t = Affine2D(); t.m00, t.m11 = sx, sy
        return self._post_ret(t)

    def rotate_deg(self, deg: float) -> 'Affine2D':
        t = Affine2D._rot(deg)
        return self._post_ret(t)

    # pre-concatenate (applied to source coords beforehand) - Java preConcatenate()
    def pre_translate(self, tx: float, ty: float) -> 'Affine2D':
        t = Affine2D(); t.m02, t.m12 = tx, ty
        return self._pre_ret(t)

    def pre_scale(self, sx: float, sy: float) -> 'Affine2D':
        t = Affine2D(); t.m00, t.m11 = sx, sy
        return self._pre_ret(t)

    def pre_rotate_deg(self, deg: float) -> 'Affine2D':
        return self._pre_ret(Affine2D._rot(deg))

    def rotate_deg_around(self, deg: float, px: float, py: float) -> 'Affine2D':
        # Java: getRotateInstance(rad, px, py).concatenate(this) -> pre
        t = Affine2D._rot(deg)
        t.m02 = px - t.m00 * px - t.m01 * py
        t.m12 = py - t.m10 * px - t.m11 * py
        return self._pre_ret(t)

    def shear_deg(self, dx_deg: float, dy_deg: float) -> 'Affine2D':
        t = Affine2D()
        t.m01, t.m10 = math.tan(math.radians(dx_deg)), math.tan(math.radians(dy_deg))
        return self._post_ret(t)

    def _post_ret(self, t):
        Affine2D._mul(self, t, None)
        return self

    def _pre_ret(self, t):
        Affine2D._mul(t, self, None)
        (self.m00, self.m01, self.m02, self.m10, self.m11, self.m12) = (
            t.m00, t.m01, t.m02, t.m10, t.m11, t.m12)
        return self

    @staticmethod
    def _rot(deg: float) -> 'Affine2D':
        """Java AffineTransform.getRotateInstance(+theta):
        x' = x*cos - y*sin,  y' = x*sin + y*cos."""
        t = Affine2D()
        r = math.radians(deg)
        c, s = math.cos(r), math.sin(r)
        t.m00, t.m01 = c, -s
        t.m10, t.m11 = s, c
        return t

    def transform(self, pts):
        """Transform flat [x0,y0,x1,y1,...] in place (float list)."""
        m00, m01, m02, m10, m11, m12 = self.m00, self.m01, self.m02, self.m10, self.m11, self.m12
        for i in range(0, len(pts) - 1, 2):
            x, y = pts[i], pts[i + 1]
            pts[i] = m00 * x + m01 * y + m02
            pts[i + 1] = m10 * x + m11 * y + m12
        return pts

    def get_matrix(self):
        return (self.m00, self.m01, self.m02, self.m10, self.m11, self.m12)


class Path:
    """Polyline entity equivalent to the original app.g.e."""

    __slots__ = ('coords', 'ops')

    def __init__(self, coords=None, ops=None):
        self.coords = list(coords) if coords else []
        self.ops = list(ops) if ops else []

    # ---- building ----
    @property
    def n_points(self) -> int:
        return len(self.ops)

    def move_to(self, x: float, y: float):
        if self.ops and self.ops[-1] == MOVE:
            self.coords[-2] = x
            self.coords[-1] = y
        else:
            self._ensure_capacity()
            self.ops.append(MOVE)
            self.coords.extend((x, y))
        return self

    def line_to(self, x: float, y: float):
        if not self.ops:
            raise RuntimeError('missing initial moveto in path definition')
        self._ensure_capacity()
        self.ops.append(LINE)
        self.coords.extend((x, y))
        return self

    def _ensure_capacity(self):
        pass  # python lists grow

    def set_closed_polygon(self, pts):
        """b(float[]) in original: set from flat pairs, closed."""
        self.coords = list(pts)
        self.ops = [LINE] * (len(pts) // 2)
        if self.ops:
            self.ops[0] = MOVE
        return self

    def close(self):
        if self.coords and (self.coords[0], self.coords[1]) != (self.coords[-2], self.coords[-1]):
            self.line_to(self.coords[0], self.coords[1])

    # ---- shapes ----
    def ellipse(self, cx: float, cy: float, rx: float, ry: float, step_rad: float):
        """Full ellipse polygonized (a(x,y,rx,ry,step))."""
        two_pi = 2.0 * math.pi
        t = 0.0
        # replicate original loop: while t <= 2pi, with closing snap
        while t <= two_pi:
            x = cx + math.cos(t) * rx
            y = cy + math.sin(t) * ry
            if t == 0.0:
                self.move_to(x, y)
            else:
                self.line_to(x, y)
            if t != two_pi and t + step_rad > two_pi:
                t = two_pi
                continue
            t += step_rad
        return self

    def rect(self, x: float, y: float, w: float, h: float):
        self.move_to(x, y)
        self.line_to(x + w, y)
        self.line_to(x + w, y + h)
        self.line_to(x, y + h)
        self.line_to(x, y)
        return self

    def closed_polygon(self, pts):
        self.move_to(pts[0], pts[1])
        for i in range(2, len(pts) - 1, 2):
            self.line_to(pts[i], pts[i + 1])
        self.line_to(pts[0], pts[1])
        return self

    def arc_to_beziers(self, x1, y1, rx, ry, phi_deg, large_arc, sweep, x2, y2, step=0.02):
        """SVG arc converted to cubic bezier segments (a(9-arg) in original)."""
        if x1 == x2 and y1 == y2:
            return self                 # SVG: zero-length arc is omitted
        if rx == 0.0 or ry == 0.0:
            self.line_to(x2, y2)
            return self
        rx, ry = abs(rx), abs(ry)
        phi = math.radians(phi_deg % 360.0)
        cosp, sinp = math.cos(phi), math.sin(phi)
        dx2 = (x1 - x2) / 2.0
        dy2 = (y1 - y2) / 2.0
        x1p = cosp * dx2 + sinp * dy2
        y1p = -sinp * dx2 + cosp * dy2
        rxs, rys = rx * rx, ry * ry
        lam = (x1p * x1p) / rxs + (y1p * y1p) / rys
        if lam > 1.0:
            s = math.sqrt(lam)
            rx *= s
            ry *= s
            rxs, rys = rx * rx, ry * ry
        num = rxs * y1p * y1p + rys * x1p * x1p
        ratio = (rxs * rys - num) / num  # original computes ratio then clamps at 0
        if ratio < 0:
            ratio = 0.0
        sign = -1 if large_arc != sweep else 1
        co = sign * math.sqrt(ratio)
        cxp = co * rx * y1p / ry
        cyp = -co * ry * x1p / rx
        cx = cosp * cxp - sinp * cyp + (x1 + x2) / 2.0
        cy = sinp * cxp + cosp * cyp + (y1 + y2) / 2.0

        def angle(ux, uy, vx, vy):
            dot = ux * vx + uy * vy
            n = math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
            a = math.acos(max(-1.0, min(1.0, dot / n)))
            if ux * vy - uy * vx < 0:
                a = -a
            return a

        t1 = angle(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
        if not sweep and dt > 0:
            dt -= 2 * math.pi
        elif sweep and dt < 0:
            dt += 2 * math.pi
        n_seg = max(1, int(math.ceil(abs(dt) / (math.pi / 2))))
        delta = dt / n_seg
        kappa = 1.3333333333333333 * math.sin(delta / 2.0) / (1.0 + math.cos(delta / 2.0))
        t = t1
        for i in range(n_seg):
            t2 = t + delta
            ct1, st1 = math.cos(t), math.sin(t)
            ct2, st2 = math.cos(t2), math.sin(t2)
            # control points in unit circle space then map back
            p1 = (ct1 - kappa * st1, st1 + kappa * ct1)
            p2 = (ct2 + kappa * st2, st2 - kappa * ct2)
            p3 = (ct2, st2)
            ep1 = (cx + rx * (cosp * p1[0] - sinp * p1[1]), cy + ry * (sinp * p1[0] + cosp * p1[1]))
            ep2 = (cx + rx * (cosp * p2[0] - sinp * p2[1]), cy + ry * (sinp * p2[0] + cosp * p2[1]))
            ep3 = (cx + rx * (cosp * p3[0] - sinp * p3[1]), cy + ry * (sinp * p3[0] + cosp * p3[1]))
            if i == n_seg - 1:
                ep3 = (x2, y2)
            self.cubic_bezier(ep1[0], ep1[1], ep2[0], ep2[1], ep3[0], ep3[1], step)
            t = t2
        return self

    def cubic_bezier(self, c1x, c1y, c2x, c2y, ex, ey, step=0.02):
        """Append cubic bezier from current point (de Casteljau, b(7-arg))."""
        if not self.coords:
            self.move_to(c1x, c1y)
        x0, y0 = self.coords[-2], self.coords[-1]
        t = 0.0
        while t <= 1.0:
            mt = 1.0 - t
            a = mt * mt * mt
            b = 3.0 * mt * mt * t
            c = 3.0 * mt * t * t
            d = t * t * t
            x = a * x0 + b * c1x + c * c2x + d * ex
            y = a * y0 + b * c1y + c * c2y + d * ey
            self.line_to(x, y)
            t += step
        return self

    def quad_bezier(self, cx, cy, ex, ey, step=0.02):
        x0, y0 = self.coords[-2], self.coords[-1]
        t = 0.0
        while t <= 1.0:
            mt = 1.0 - t
            x = mt * mt * x0 + 2 * mt * t * cx + t * t * ex
            y = mt * mt * y0 + 2 * mt * t * cy + t * t * ey
            self.line_to(x, y)
            t += step
        return self

    # ---- ops ----
    def reverse(self):
        """d(): reverse point order (keeps ops aligned as in original)."""
        a = self.coords
        n = len(a)
        i = 0
        while i < n / 2 - 1:
            j = n - 1 - (i + 1)
            a[i], a[j] = a[j], a[i]
            a[i + 1], a[n - 1 - i] = a[n - 1 - i], a[i + 1]
            i += 2
        # original d() swaps coords but NOT ops ordering beyond alignment;
        # to keep a valid path we rebuild ops: first=MOVE rest=LINE per segment
        self.ops = [LINE] * len(self.ops)
        if self.ops:
            self.ops[0] = MOVE
        return self

    def append(self, other: 'Path'):
        """a(e): concatenate other; joining op becomes LINE."""
        self.coords.extend(other.coords)
        self.ops.append(LINE)
        self.ops.extend(other.ops[1:] if other.ops else [])
        return self

    def clone(self) -> 'Path':
        return Path(list(self.coords), list(self.ops))

    def bbox(self):
        """f(): (minx, miny, maxx, maxy) or None."""
        c = self.coords
        if not c:
            return None
        xs = c[0::2]
        ys = c[1::2]
        return (min(xs), min(ys), max(xs), max(ys))

    def transform(self, aff: Affine2D):
        aff.transform(self.coords)
        return self

    def snap_to_int(self):
        """j(): Java (int) cast truncation toward zero."""
        self.coords = [math.trunc(v) for v in self.coords]
        return self

    def total_length(self) -> float:
        total = 0.0
        px = py = 0.0
        c = self.coords
        for i, op in enumerate(self.ops):
            x, y = c[i * 2], c[i * 2 + 1]
            if op == LINE:
                total += math.hypot(x - px, y - py)
            px, py = x, y
        return total

    def subpaths(self):
        """k(): split at MOVE ops."""
        out = []
        cur = None
        c = self.coords
        for i, op in enumerate(self.ops):
            x, y = c[i * 2], c[i * 2 + 1]
            if op == MOVE:
                cur = Path()
                cur.move_to(x, y)
                out.append(cur)
            elif cur is not None:
                cur.line_to(x, y)
        return out

    def iter_points(self):
        c = self.coords
        for i, op in enumerate(self.ops):
            yield op, c[i * 2], c[i * 2 + 1]

    # ---- RDP ----
    def rdp_simplify(self, tolerance: float):
        """a(float): per-subpath Douglas-Peucker (native RDPppd equivalent)."""
        if tolerance <= 0 or not self.ops:
            return self
        out = Path()
        for sub in self.subpaths():
            pts = sub.coords
            if len(pts) >= 4:
                kept = rdp(pts, tolerance)
            else:
                kept = pts
            if len(kept) >= 2:
                out.move_to(kept[0], kept[1])
                for i in range(2, len(kept), 2):
                    out.line_to(kept[i], kept[i + 1])
        self.coords = out.coords
        self.ops = out.ops
        return self


def _perp_dist(px, py, ax, ay, bx, by) -> float:
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    if l2 == 0:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / l2
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def rdp(flat_pts, eps: float):
    """Iterative Ramer-Douglas-Peucker on flat [x0,y0,...]."""
    n = len(flat_pts) // 2
    if n < 3:
        return list(flat_pts)
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    stack = [(0, n - 1)]
    while stack:
        s, e = stack.pop()
        ax, ay = flat_pts[s * 2], flat_pts[s * 2 + 1]
        bx, by = flat_pts[e * 2], flat_pts[e * 2 + 1]
        dmax, idx = -1.0, -1
        for i in range(s + 1, e):
            d = _perp_dist(flat_pts[i * 2], flat_pts[i * 2 + 1], ax, ay, bx, by)
            if d > dmax:
                dmax, idx = d, i
        if dmax > eps:
            keep[idx] = True
            stack.append((s, idx))
            stack.append((idx, e))
    out = []
    for i in range(n):
        if keep[i]:
            out.extend((flat_pts[i * 2], flat_pts[i * 2 + 1]))
    return out


def bbox_of(paths):
    """l_0.a(List): union bbox."""
    res = [float('nan')] * 4
    for p in paths:
        b = p.bbox()
        if not b:
            continue
        if math.isnan(res[0]) or b[0] < res[0]:
            res[0] = b[0]
        if math.isnan(res[1]) or b[1] < res[1]:
            res[1] = b[1]
        if math.isnan(res[2]) or b[2] > res[2]:
            res[2] = b[2]
        if math.isnan(res[3]) or b[3] > res[3]:
            res[3] = b[3]
    return None if math.isnan(res[0]) else tuple(res)


def translate_all(paths, dx, dy):
    for p in paths:
        for i in range(0, len(p.coords), 2):
            p.coords[i] += dx
            p.coords[i + 1] += dy
    return paths


def scale_all(paths, sx, sy):
    for p in paths:
        for i in range(0, len(p.coords), 2):
            p.coords[i] *= sx
            p.coords[i + 1] *= sy
    return paths


def rotate_all_around(paths, deg, cx, cy):
    aff = Affine2D().rotate_deg_around(deg, cx, cy)
    for p in paths:
        p.transform(aff)
    return paths
