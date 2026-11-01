"""Image trace pipeline: working-resolution downscale, trace cache, element
cache, equivalence of the vectorised thinning/Canny with the reference
implementations, and the task time budget."""
import os
import sys
import time

import pytest

np = pytest.importorskip('numpy')
PIL = pytest.importorskip('PIL')
from PIL import Image, ImageDraw  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from penplot import compose, image as im  # noqa: E402


def _drawing(path, w=3000, h=2000):
    img = Image.new('L', (w, h), 240)
    d = ImageDraw.Draw(img)
    for k in range(6):
        d.ellipse([200 + k * 400, 300, 500 + k * 400, 1500], outline=20, width=12)
    d.line([(100, 1800), (2900, 200)], fill=10, width=10)
    img.save(path, quality=90)
    return path


# ---------------------------------------------------------------- downscale
def test_working_px():
    # 80 mm wide @ 8 px/mm on a portrait 3000x4000 photo: 640 px wide -> 853 long -> bucket 900
    assert im.working_px(3000, 4000, 80, 8.0, 1200) == 900
    # big output: hard cap
    assert im.working_px(4000, 3000, 400, 8.0, 1200) == 1200
    # never upscale a small image
    assert im.working_px(300, 200, 400, 8.0, 1200) == 300
    # user asks for more
    assert im.working_px(4000, 3000, 400, 8.0, 2400) == 2400


def test_trace_downscales_early(tmp_path, monkeypatch):
    p = _drawing(str(tmp_path / 'scan.jpg'))
    seen = []
    orig = im.load_gray

    def spy(path, invert=False, max_px=None):
        a = orig(path, invert=invert, max_px=max_px)
        seen.append(a.shape)
        return a
    monkeypatch.setattr(im, 'load_gray', spy)
    t0 = time.time()
    paths = compose.trace_image(p, {'mode': 'edge', 'width_mm': 100})
    assert time.time() - t0 < 5
    assert seen and max(seen[0]) == 800          # 100 mm * 8 px/mm, not 3000 px
    bb = compose.bbox_of(paths)
    assert bb[2] <= 100.5 and bb[2] > 90          # scaled to width_mm
    assert sum(q.total_length() for q in paths) > 500


def test_exif_orientation_and_alpha(tmp_path):
    # transparent PNG with black RGB in the transparent area: must not become all ink
    a = Image.new('RGBA', (200, 100), (0, 0, 0, 0))
    ImageDraw.Draw(a).rectangle([50, 20, 150, 80], fill=(0, 0, 0, 255))
    pa = str(tmp_path / 'logo.png')
    a.save(pa)
    ink = im.load_gray(pa)
    assert ink[5, 5] < 0.05 and ink[50, 100] > 0.95
    # EXIF orientation 6 (rotate 90 CW): displayed size is h x w
    j = Image.new('L', (300, 100), 255)
    ex = Image.Exif()
    ex[0x0112] = 6
    pj = str(tmp_path / 'rot.jpg')
    j.save(pj, exif=ex)
    assert im.image_size(pj) == (100, 300)
    assert im.load_gray(pj).shape == (300, 100)


# ---------------------------------------------------------------- caches
def test_trace_cache_hit_and_rescale(tmp_path, monkeypatch):
    p = _drawing(str(tmp_path / 'scan.jpg'))
    cd = str(tmp_path / 'el')
    a = compose.trace_image(p, {'mode': 'edge', 'width_mm': 100}, cache_dir=cd)
    assert len(os.listdir(cd)) == 1

    def boom(*a, **k):
        raise AssertionError('re-traced')
    monkeypatch.setattr(im, 'load_gray', boom)
    b = compose.trace_image(p, {'mode': 'edge', 'width_mm': 100}, cache_dir=cd)
    assert [q.coords for q in a] == [q.coords for q in b]
    # same resolution bucket (99 mm -> 792 px -> 800): rescaled from cache
    c = compose.trace_image(p, {'mode': 'edge', 'width_mm': 99}, cache_dir=cd)
    assert len(c) == len(a)
    assert abs(compose.bbox_of(c)[2] / compose.bbox_of(a)[2] - 0.99) < 1e-4
    # a different trace parameter misses
    with pytest.raises(AssertionError, match='re-traced'):
        compose.trace_image(p, {'mode': 'edge', 'width_mm': 100, 'th_low': 0.2}, cache_dir=cd)


def _svg(tmp_path):
    p = str(tmp_path / 'a.svg')
    with open(p, 'w') as f:
        f.write('<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">'
                '<path d="M0 0 L40 20 M0 20 L40 0" stroke="black" fill="none"/></svg>')
    return p


def test_element_cache_render_identical(tmp_path, monkeypatch):
    pytest.importorskip('svgelements')
    from penplot.settings import MachineConfig
    img = _drawing(str(tmp_path / 'scan.jpg'), 1200, 800)
    svg = _svg(tmp_path)
    doc = {'pages': [{'elements': [
        {'id': 'i', 'type': 'image', 'transform': {'x': 10, 'y': 10}, 'props': {'file_id': 'img', 'width_mm': 60}},
        {'id': 's', 'type': 'svg', 'transform': {'x': 10, 'y': 120}, 'props': {'file_id': 'svg'}},
        {'id': 't', 'type': 'text', 'transform': {'x': 10, 'y': 200}, 'props': {'text': 'Hi 你好', 'size_mm': 8}},
    ]}]}
    papers = [{'width_mm': 210, 'height_mm': 297}]
    mc = MachineConfig()
    cd = str(tmp_path / 'el')

    def render(move=0):
        d = {'pages': [{'elements': [dict(e, transform=dict(e['transform'], x=e['transform']['x'] + move))
                                     for e in doc['pages'][0]['elements']]}]}
        res = compose.Resolver(files={'img': img, 'svg': svg}, cache_dir=cd)
        return compose.render_document(d, papers, res, mc, origin=None)
    first = render()
    n = len(os.listdir(cd))
    assert n == 3                                   # image trace + svg + text
    monkeypatch.setattr(im, 'load_gray', lambda *a, **k: (_ for _ in ()).throw(AssertionError('re-traced')))
    monkeypatch.setattr(compose, 'vector_paths', lambda *a, **k: (_ for _ in ()).throw(AssertionError('re-parsed')))
    monkeypatch.setattr(compose, 'text_box_paths', lambda *a, **k: (_ for _ in ()).throw(AssertionError('re-laid')))
    again = render()
    assert again[0].gcode == first[0].gcode         # hit == miss, byte for byte
    assert again[0].warnings == first[0].warnings
    moved = render(move=5)                          # moving never re-traces
    assert len(os.listdir(cd)) == n
    assert abs(moved[0].bbox[0] - first[0].bbox[0] - 5) < 1e-3


def test_prune_cache_dir(tmp_path):
    for i in range(5):
        with open(tmp_path / ('%d.bin' % i), 'wb') as f:
            f.write(b'x' * 1000)
        os.utime(tmp_path / ('%d.bin' % i), (i, i))
    compose.prune_cache_dir(str(tmp_path), 2500)
    assert sorted(os.listdir(tmp_path)) == ['3.bin', '4.bin']


# ---------------------------------------------------------------- equivalence
def _zs_reference(ink):
    """The original roll()-based Zhang-Suen (unpadded result)."""
    b = np.pad(ink > 0.5, 1)
    changed = True
    while changed:
        changed = False
        for phase in (0, 1):
            p = b.astype(np.uint8)
            r = lambda dy, dx: np.roll(np.roll(p, dy, 0), dx, 1)  # noqa: E731
            p2, p3, p4, p5 = r(-1, 0), r(-1, -1), r(0, -1), r(1, -1)
            p6, p7, p8, p9 = r(1, 0), r(1, 1), r(0, 1), r(-1, 1)
            for arr in (p2, p3, p4, p5, p6, p7, p8, p9):
                arr[0, :] = arr[-1, :] = arr[:, 0] = arr[:, -1] = 0
            B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
            seq = np.stack([p2, p3, p4, p5, p6, p7, p8, p9, p2]).astype(np.int8)
            A = ((seq[:-1] == 0) & (seq[1:] == 1)).sum(axis=0)
            c = (p == 1) & (2 <= B) & (B <= 6) & (A == 1)
            if phase == 0:
                c &= (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                c &= (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            if c.any():
                b &= ~c
                changed = True
    return b[1:-1, 1:-1]


def test_zhang_suen_matches_reference():
    rng = np.random.default_rng(3)
    for _ in range(3):
        img = Image.new('L', (160, 120), 0)
        d = ImageDraw.Draw(img)
        for _k in range(6):
            x, y = rng.integers(0, 160), rng.integers(0, 120)
            d.ellipse([x - 20, y - 15, x + 20, y + 15], fill=255)
            d.line([tuple(rng.integers(0, 120, 2)), tuple(rng.integers(0, 120, 2))], fill=255, width=7)
        ink = np.asarray(img) / 255.0
        ref = _zs_reference(ink)
        got = im.zhang_suen(ink)
        assert got.shape == ink.shape
        assert np.array_equal(ref, got)


def test_trace_lines_cover_skeleton_and_edges_drawn_once():
    img = Image.new('L', (200, 200), 0)
    ImageDraw.Draw(img).ellipse([30, 30, 170, 170], outline=255, width=9)
    ink = np.asarray(img) / 255.0
    skel = im.zhang_suen(ink)
    lines = im.trace_lines(skel, min_points=2, reduce=False)
    covered = {(int(y), int(x)) for a in lines for x, y in a}
    assert len(covered) >= 0.98 * skel.sum()
    # Canny on a ring: two concentric centre lines, each drawn once (~2 * 2*pi*r)
    paths = im.arrays_to_paths(im.canny_lines(ink, min_points=6))
    L = sum(p.total_length() for p in paths)
    expect = 2 * np.pi * (70 + 4.5) + 2 * np.pi * (70 - 4.5)
    assert 0.85 * expect < L < 1.2 * expect
    assert len(paths) <= 4


def test_encode_decode_roundtrip():
    from penplot.geometry import Path
    a = Path()
    a.move_to(0, 0)
    a.line_to(1.5, 2.25)
    a.move_to(3, 3)
    a.line_to(4, 4)
    b = Path([5.0, 6.0, 7.0, 8.0], [0, 1])
    out = compose.decode_paths(compose.encode_paths([a, b]))
    assert [p.coords for p in out] == [[0, 0, 1.5, 2.25], [3, 3, 4, 4], [5, 6, 7, 8]]
    flipped = compose.decode_paths(compose.encode_paths([b], flip_y=True))
    assert flipped[0].coords == [5, -6, 7, -8]


# ---------------------------------------------------------------- budget
def test_task_budget(monkeypatch):
    from penplot.web.tasks import kinds
    monkeypatch.setenv('PENPLOT_TRACE_BUDGET_S', '0.2')
    t0 = time.time()
    with pytest.raises(kinds.BudgetExceeded) as ei:
        with kinds.budget('PENPLOT_TRACE_BUDGET_S', 60, '超时 %.1f'):
            while time.time() - t0 < 5:
                pass
    assert time.time() - t0 < 2
    assert kinds.error_dict(ei.value)['code'] == 'task_timeout'
