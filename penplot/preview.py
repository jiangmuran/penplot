# -*- coding: utf-8 -*-
"""Preview rendering: SVG (no dependencies) and optional PNG via matplotlib."""
import math

from .geometry import MOVE


def paths_to_svg(paths, width_mm, height_mm, page=None, title='preview',
                 pen_up=False, flip_y=False):
    """Render paths (mm coords) to an SVG string.

    Machine coords are y-up; SVG is y-down, so y is flipped by default.
    """
    all_x, all_y = [], []
    for p in paths:
        all_x.extend(p.coords[0::2])
        all_y.extend(p.coords[1::2])
    if not all_x:
        all_x, all_y = [0, width_mm], [0, height_mm]
    minx, maxx = min(all_x), max(all_x)
    miny, maxy = min(all_y), max(all_y)
    # include full page bounds
    minx, maxx = min(0, minx), max(width_mm, maxx)
    miny, maxy = min(0, miny), max(height_mm, maxy)
    w = maxx - minx
    h = maxy - miny

    def tx(x):
        return (x - minx) * 10.0

    def ty(y):
        return (maxy - y) * 10.0 if flip_y else (y - miny) * 10.0

    out = []
    out.append('<svg xmlns="http://www.w3.org/2000/svg" width="%gmm" height="%gmm" '
               'viewBox="0 0 %g %g">' % (w, h, w * 10, h * 10))
    out.append('<rect x="0" y="0" width="%g" height="%g" fill="white"/>' % (w * 10, h * 10))
    if page is not None:
        # margins
        out.append('<rect x="%g" y="%g" width="%g" height="%g" fill="none" '
                   'stroke="#cccccc" stroke-width="1" stroke-dasharray="4 4"/>' % (
                       tx(page.leftGap), ty(page.pageHeight - page.topGap),
                       (page.pageWidth - page.leftGap - page.rightGap) * 10,
                       (page.pageHeight - page.topGap - page.bottomGap) * 10))
    for p in paths:
        seg = []
        cur = None
        for op, x, y in p.iter_points():
            X, Y = tx(x), ty(y)
            if op == MOVE:
                if cur:
                    seg.append('M%g %g' % cur)
                cur = (X, Y)
            else:
                if cur:
                    seg.append('M%g %gL%g %g' % (cur[0], cur[1], X, Y))
                    cur = None
                else:
                    seg.append('L%g %g' % (X, Y))
        if cur:
            seg.append('M%g %g' % cur)
        if seg:
            out.append('<path d="%s" fill="none" stroke="black" stroke-width="1.5"/>'
                       % ''.join(seg))
    out.append('</svg>')
    return '\n'.join(out)


def paths_to_png(paths, path_out, width_mm=None, height_mm=None, dpi=150, page=None):
    """Render to PNG via matplotlib (if installed)."""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection

    fig, ax = plt.subplots(figsize=(8, 11))
    segs = []
    for p in paths:
        cur = None
        for op, x, y in p.iter_points():
            if op == MOVE:
                cur = (x, y)
            else:
                if cur:
                    segs.append([(cur[0], cur[1]), (x, y)])
                    cur = None
                elif segs:
                    segs[-1].append((x, y))
    ax.add_collection(LineCollection(segs, colors='black', linewidths=0.6))
    ax.set_aspect('equal')
    ax.autoscale()
    fig.savefig(path_out, dpi=dpi, bbox_inches='tight')
    plt.close(fig)
    return path_out


def stats(paths):
    """Draw distance / travel distance / pen lifts."""
    draw = travel = 0.0
    lifts = 0
    pen = False
    px = py = 0.0
    for p in paths:
        for op, x, y in p.iter_points():
            d = math.hypot(x - px, y - py)
            if op == MOVE:
                if pen:
                    lifts += 1
                pen = True
                travel += d
            else:
                draw += d
            px, py = x, y
        if pen:
            lifts += 1
            pen = False
    return {'draw_mm': round(draw, 1), 'travel_mm': round(travel, 1), 'pen_lifts': lifts}
