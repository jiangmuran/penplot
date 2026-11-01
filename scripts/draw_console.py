# -*- coding: utf-8 -*-
"""Draw a retro computer console (CRT monitor + keyboard) as single-line paths.

usage: python scripts/draw_console.py [--config configs/grbl-zpen.json]
                                      [--x0 30] [--y0 -58] [-o out/console.gcode]

Coordinates are machine millimetres: origin = pen start, X right, Y negative
downwards (the original software's default "left-up" origin). (x0, y0) is the
top-left corner of the drawing; it is about 82 x 86 mm.
"""
import argparse
import math
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

from penplot.geometry import Path  # noqa: E402
from penplot.gcode import generate_gcode  # noqa: E402
from penplot.psf import read_psf  # noqa: E402
from penplot.settings import MachineConfig  # noqa: E402


def polyline(pts, closed=False):
    p = Path()
    p.move_to(*pts[0])
    for q in pts[1:]:
        p.line_to(*q)
    if closed:
        p.line_to(*pts[0])
    return p


def round_rect(x, y, w, h, r, seg=6):
    """Axis-aligned rounded rectangle; (x, y) = top-left, y grows downward
    in the drawing, which is negative in machine space (handled by caller)."""
    pts = []
    corners = [(x + w - r, y + r, -90), (x + w - r, y + h - r, 0),
               (x + r, y + h - r, 90), (x + r, y + r, 180)]
    for cx, cy, a0 in corners:
        for i in range(seg + 1):
            a = math.radians(a0 + 90.0 * i / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return polyline(pts, closed=True)


def circle(cx, cy, r, seg=16):
    return polyline([(cx + r * math.cos(2 * math.pi * i / seg),
                      cy + r * math.sin(2 * math.pi * i / seg)) for i in range(seg)],
                    closed=True)


def text(font, s, x, y_base, height):
    """Builtin stroke font; glyph y is negative upward, baseline 0."""
    out = []
    k = height / 70.0
    cx = x
    for ch in s:
        g = font.glyph(ch)
        if ch == ' ' or g is None:
            cx += 30 * k
            continue
        xs = g.coords[0::2]
        p = Path()
        for op, gx, gy in zip(g.ops, xs, g.coords[1::2]):
            X, Y = cx + gx * k, y_base + gy * k
            (p.move_to if op == 0 else p.line_to)(X, Y)
        out.append(p)
        cx += (max(xs) + 14) * k
    return out


def build(font):
    """Drawing in local mm, y DOWN. Returns list of Path."""
    P = []
    # ---- monitor ----------------------------------------------------------
    P.append(round_rect(0, 0, 76, 54, 6))            # bezel
    P.append(round_rect(5, 5, 66, 40, 4))            # screen glass
    # prompt lines on the screen
    # the builtin font has no '>' / '$': draw the prompt chevron by hand
    def prompt(y):
        return polyline([(9, y - 4.2), (11.6, y - 2.1), (9, y)])
    P.append(prompt(15))
    P += text(font, 'PENPLOT', 13.5, 15, 4.5)
    P += text(font, 'HELLO WORLD', 9, 24, 4.5)
    P.append(prompt(33))
    P.append(round_rect(13.5, 28.6, 3.0, 4.4, 0.4, seg=1))   # block cursor
    P.append(polyline([(14.2, 29.4), (14.2, 32.2)]))         # fill hint
    P.append(polyline([(15.0, 29.4), (15.0, 32.2)]))
    P.append(polyline([(15.8, 29.4), (15.8, 32.2)]))
    # screen glare
    P.append(polyline([(62, 8.5), (66.5, 8.5), (66.5, 13)]))
    # chin: power LED + vents
    P.append(circle(68, 49.5, 1.3))
    for i in range(4):
        P.append(polyline([(8 + i * 3, 48), (8 + i * 3, 51)]))
    # ---- stand ------------------------------------------------------------
    P.append(polyline([(31, 54), (29, 61), (47, 61), (45, 54)]))
    P.append(round_rect(22, 61, 32, 3.5, 1.5))
    # ---- keyboard ---------------------------------------------------------
    kx, ky, kw, kh = -3, 69, 82, 21.5
    P.append(round_rect(kx, ky, kw, kh, 2.5))
    rows = [(13, 0.0), (12, 2.0), (11, 4.0)]
    key = 4.6
    gap = 1.1
    for r, (n, indent) in enumerate(rows):
        y = ky + 2 + r * (key + 0.4)
        x = kx + 3 + indent
        for _ in range(n):
            P.append(round_rect(x, y, key, key - 0.8, 0.6, seg=1))
            x += key + gap
    # space bar
    P.append(round_rect(kx + 22, ky + 2 + 3 * (key + 0.4) - 0.2, 38, 2.6, 0.8, seg=1))
    return P


def to_machine(paths, x0, y0):
    for p in paths:
        c = p.coords
        for i in range(0, len(c), 2):
            c[i] = x0 + c[i]
            c[i + 1] = y0 - c[i + 1]
    return paths


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', default=os.path.join(REPO, 'configs', 'grbl-zpen.json'))
    ap.add_argument('--x0', type=float, default=30.0)
    ap.add_argument('--y0', type=float, default=-58.0)
    ap.add_argument('-o', '--out', default=os.path.join(REPO, 'out', 'console.gcode'))
    ap.add_argument('--png', default=None, help='also render a preview PNG (matplotlib)')
    a = ap.parse_args()

    font = read_psf(os.path.join(REPO, 'fonts', 'penplot-sans.psf'))
    paths = to_machine(build(font), a.x0, a.y0)
    mc = MachineConfig.load(a.config)
    g = generate_gcode(paths, mc, optimize=True)
    os.makedirs(os.path.dirname(a.out) or '.', exist_ok=True)
    with open(a.out, 'w', newline='', encoding='utf-8') as fh:
        fh.write(g)
    xs = [v for p in paths for v in p.coords[0::2]]
    ys = [v for p in paths for v in p.coords[1::2]]
    print('paths: %d  bbox X[%.1f..%.1f] Y[%.1f..%.1f]  gcode: %s (%d lines)'
          % (len(paths), min(xs), max(xs), min(ys), max(ys), a.out, g.count('\n')))
    if a.png:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(figsize=(6, 6.5))
        for p in paths:
            for sp in p.subpaths():
                pts = [(x, y) for _, x, y in sp.iter_points()]
                ax.plot(*zip(*pts), 'k-', lw=0.9)
        ax.set_aspect('equal')
        ax.grid(alpha=0.25)
        fig.tight_layout()
        fig.savefig(a.png, dpi=110)
        print('preview:', a.png)


if __name__ == '__main__':
    main()
