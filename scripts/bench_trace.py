#!/usr/bin/env python3
"""Benchmark image -> path tracing (penplot.compose.trace_image).

    python scripts/bench_trace.py [--out DIR] [--modes edge,skeleton,dots] [IMAGE ...]

Without IMAGE arguments it generates three realistic synthetic inputs in --out
(default: a temp dir): a 3000x4000 phone-photo-like JPEG, an A4 300 dpi scan of
a line drawing (JPEG) and a 1000x1000 flat-colour logo (PNG). For every image
and mode it prints wall time, peak RSS growth, path count, point count and
drawn length (mm), so before/after runs can be compared for speed and quality.
"""
import argparse
import math
import os
import resource
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))


def make_inputs(d):
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
    rng = np.random.default_rng(1)
    out = []
    # --- phone photo: smooth shading, a few objects, sensor noise, JPEG q90
    p = os.path.join(d, 'photo-3000x4000.jpg')
    if not os.path.exists(p):
        W, H = 3000, 4000
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        base = 120 + 60 * np.sin(xx / 700.0) * np.cos(yy / 900.0) + 0.01 * yy
        im = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)).convert('RGB')
        dr = ImageDraw.Draw(im)
        for i in range(40):
            x, y = int(rng.uniform(0, W)), int(rng.uniform(0, H))
            r = int(rng.uniform(80, 500))
            col = tuple(int(c) for c in rng.integers(0, 255, 3))
            if i % 3 == 0:
                dr.ellipse([x - r, y - r, x + r, y + r], fill=col)
            elif i % 3 == 1:
                dr.rectangle([x - r, y - r // 2, x + r, y + r // 2], fill=col)
            else:
                dr.polygon([(x, y - r), (x + r, y + r), (x - r, y + r)], fill=col)
        im = im.filter(ImageFilter.GaussianBlur(3))
        a = np.asarray(im).astype(np.int16) + rng.normal(0, 6, (H, W, 3)).astype(np.int16)
        Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(p, quality=90)
    out.append(p)
    # --- scanned line drawing: grey paper, 3..6 px dark pen strokes, JPEG
    p = os.path.join(d, 'scan-a4-300dpi.jpg')
    if not os.path.exists(p):
        W, H = 2480, 3508
        im = Image.new('L', (W, H), 235)
        dr = ImageDraw.Draw(im)
        for i in range(60):
            cx, cy = rng.uniform(200, W - 200), rng.uniform(200, H - 200)
            r = rng.uniform(60, 400)
            pts = []
            for t in np.linspace(0, rng.uniform(2, 6.5), 80):
                pts.append((cx + r * math.cos(t) * (1 + 0.2 * math.sin(3 * t)),
                            cy + r * math.sin(t) * 0.7))
            dr.line(pts, fill=int(rng.uniform(20, 70)), width=int(rng.uniform(3, 7)), joint='curve')
        for i in range(30):
            x0, y0 = rng.uniform(100, W - 100), rng.uniform(100, H - 100)
            dr.line([(x0, y0), (x0 + rng.uniform(-600, 600), y0 + rng.uniform(-600, 600))],
                    fill=40, width=4)
        a = np.asarray(im.filter(ImageFilter.GaussianBlur(1))).astype(np.int16)
        a = a + rng.normal(0, 5, a.shape).astype(np.int16)
        Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(p, quality=85)
    out.append(p)
    # --- logo: flat colours + text-ish bars, PNG
    p = os.path.join(d, 'logo-1000.png')
    if not os.path.exists(p):
        im = Image.new('RGB', (1000, 1000), 'white')
        dr = ImageDraw.Draw(im)
        dr.ellipse([100, 100, 900, 900], fill=(200, 30, 30))
        dr.ellipse([250, 250, 750, 750], fill='white')
        dr.polygon([(500, 150), (800, 800), (200, 800)], fill=(20, 20, 120))
        for k in range(5):
            dr.rectangle([150 + k * 150, 880, 230 + k * 150, 960], fill='black')
        im.save(p)
    out.append(p)
    return out


def peak_rss_mb():
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('images', nargs='*')
    ap.add_argument('--out', default=os.path.join(tempfile.gettempdir(), 'penplot-bench-img'))
    ap.add_argument('--modes', default='edge,skeleton,dots')
    ap.add_argument('--width-mm', type=float, default=120.0)
    ap.add_argument('--max-px', type=int, default=None)
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    imgs = args.images or make_inputs(args.out)
    from penplot.compose import trace_image
    print('%-24s %-9s %8s %8s %7s %9s %10s' % ('image', 'mode', 'time_s', 'rss_mb', 'paths', 'points',
                                                'draw_mm'))
    for path in imgs:
        for mode in args.modes.split(','):
            pr = {'mode': mode, 'width_mm': args.width_mm}
            if args.max_px:
                pr['max_px'] = args.max_px
            r0 = peak_rss_mb()
            t0 = time.perf_counter()
            paths = trace_image(path, pr)
            dt = time.perf_counter() - t0
            pts = sum(p.n_points for p in paths)
            draw = sum(p.total_length() for p in paths)
            print('%-24s %-9s %8.2f %8.0f %7d %9d %10.0f' % (os.path.basename(path)[:24], mode, dt,
                                                           peak_rss_mb() - r0, len(paths), pts, draw),
                  flush=True)


if __name__ == '__main__':
    main()
