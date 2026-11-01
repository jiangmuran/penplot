"""TTF/OTF/TTC import (POST /fonts multipart -> ttf_convert task -> .psf).

Uses system fonts; each test skips when its font file is missing. Charsets
are kept tiny so the whole module runs in a few seconds."""
import os
import random

import pytest

from conftest import H, make_app, wait_for

from fastapi.testclient import TestClient

DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
DROID = '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf'
NOTO_TTC = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'   # CFF outlines, 10 faces


def need(path):
    if not os.path.exists(path):
        pytest.skip('system font missing: %s' % path)
    with open(path, 'rb') as f:
        return f.read()


def upload(c, data, fname, **form):
    return c.post('/api/v1/fonts', files={'file': (fname, data)},
                  data={k: str(v) for k, v in form.items()}, headers=H)


def run(c, data, fname, **form):
    r = upload(c, data, fname, **form)
    assert r.status_code == 202, r.text
    tid = r.json()['task_id']
    return wait_for(lambda: (lambda t: t if t['state'] in ('done', 'failed', 'cancelled') else None)(
        c.get('/api/v1/tasks/' + tid).json()), timeout=60)


def glyph_bbox(c, fid, ch):
    from penplot.psf import read_psf
    f = c.get('/api/v1/fonts/' + fid).json()
    path = os.path.join(c.app.state.ctx.cfg.font_dir, f['filename'])
    font = read_psf(path)
    g = font.glyph(ch)
    xs, ys = g.coords[0::2], g.coords[1::2]
    s = font.size
    return min(xs) / s, min(ys) / s, max(xs) / s, max(ys) / s, (g.advance or 0) / s


def render_bbox(c, fid, text):
    r = c.post('/api/v1/render/text', json={'text': text, 'font_id': fid}, headers=H)
    assert r.status_code == 200, r.text
    p = r.json()['pages'][0]
    assert p['warnings']['missing_glyphs'] == [], p['warnings']
    return p['bbox']


def leftovers(c):
    cfg = c.app.state.ctx.cfg
    up = [f for f in os.listdir(cfg.upload_dir) if f.startswith('ttf-')] if os.path.isdir(cfg.upload_dir) else []
    part = [f for f in os.listdir(cfg.font_dir) if f.endswith('.part')]
    return up + part


# ---------------------------------------------------------------- happy paths
def test_latin_skeleton_and_outline_metrics(client):
    data = need(DEJAVU)
    t = run(client, data, 'DejaVuSans.ttf', mode='skeleton', charset='custom', chars='HIxg l')
    assert t['state'] == 'done', t
    res = t['result']
    font = res['font']
    assert font['display_name'] == 'DejaVu Sans 手写'          # family name, not the temp file name
    assert font['id'] == 'DejaVuSans-skeleton' and font['source'] == 'ttf'
    assert res['missing_count'] == 0 and res['glyphs'] == 6
    sk = font['id']
    t = run(client, data, 'DejaVuSans.ttf', mode='outline', charset='latin')
    assert t['state'] == 'done', t
    ol = t['result']['font']['id']
    assert t['result']['glyphs'] == 95
    assert t['result']['font']['display_name'] == 'DejaVu Sans 空心轮廓'
    assert not leftovers(client)

    ids = {f['id'] for f in client.get('/api/v1/fonts').json()}
    assert {sk, ol} <= ids
    d = client.get('/api/v1/fonts/' + sk).json()
    assert d['coverage_summary']['latin'] == 6          # incl. the space (advance-only glyph)
    assert client.get('/api/v1/fonts/%s/coverage?text=Hxq' % sk).json()['missing'] == ['q']
    svg = client.get('/api/v1/fonts/%s/glyphs/u+0048.svg' % sk)
    assert svg.status_code == 200 and '<path d="M' in svg.text
    assert '<path' in client.get('/api/v1/fonts/%s/sample.svg?text=HIx' % ol).text

    # glyphs sit on the baseline (y=0, y down), not mirrored, built-in-like scale
    for fid in (sk, ol):
        x0, y0, x1, y1, adv = glyph_bbox(client, fid, 'H')
        assert -0.62 < y0 < -0.48, (fid, y0)          # cap height ~0.73 em / EM_TO_SIZE
        assert abs(y1) < 0.01, (fid, y1)              # stems reach the baseline (thinning compensated)
        assert 0 < x0 < x1 < adv < 0.7
        _, gy0, _, gy1, _ = glyph_bbox(client, fid, 'g')
        assert gy1 > 0.1 and gy0 > -0.5               # descender below the baseline, x-height above
        _, _, _, ly1, _ = glyph_bbox(client, fid, 'x')
        assert abs(ly1) < 0.01

    # through the real layout: same baseline / same size for skeleton and outline
    hs, ho = render_bbox(client, sk, 'H'), render_bbox(client, ol, 'H')
    assert abs(hs[3] - ho[3]) < 0.15 and abs(hs[1] - ho[1]) < 0.5, (hs, ho)
    xs = render_bbox(client, sk, 'x')
    assert abs(xs[3] - hs[3]) < 0.15, (xs, hs)        # x and H share the baseline
    # proportional spacing from hmtx: W('HHI') - W('HII') = (adv(H) - adv(I)) x scale
    # (the paper's per-char gap and the glyph bboxes cancel out)
    _, hy0, _, hy1, adv_h = glyph_bbox(client, ol, 'H')
    adv_i = glyph_bbox(client, ol, 'I')[4]
    one = render_bbox(client, ol, 'H')
    size_mm = (one[3] - one[1]) / (hy1 - hy0)
    w1, w2 = render_bbox(client, ol, 'HHI'), render_bbox(client, ol, 'HII')
    assert abs((w1[2] - w2[2]) - (adv_h - adv_i) * size_mm) < 0.05, (w1, w2, adv_h, adv_i)

    # rename + delete
    r = client.patch('/api/v1/fonts/' + sk, json={'display_name': '我的手写'}, headers=H)
    assert r.json()['display_name'] == '我的手写'
    path = os.path.join(client.app.state.ctx.cfg.font_dir, sk + '.psf')
    assert os.path.exists(path)
    assert client.delete('/api/v1/fonts/' + sk, headers=H).status_code == 204
    assert not os.path.exists(path)
    assert client.get('/api/v1/fonts/' + sk).status_code == 404


def test_cjk_skeleton_scale_matches_builtin_convention(client):
    data = need(DROID)
    t = run(client, data, 'DroidSansFallbackFull.ttf', charset='custom', chars='永中，。AB', name='测试 宋体')
    assert t['state'] == 'done', t
    res = t['result']
    assert res['font']['display_name'] == '测试 宋体' and res['font']['id'] == '测试 宋体'
    assert res['missing_count'] == 2 and res['missing'] == 'AB'      # Droid fallback has no Latin
    # bundled stroke fonts draw CJK ~0.70 x size tall, y in about -0.65..+0.08
    for ch in '永中':
        x0, y0, x1, y1, adv = glyph_bbox(client, res['font']['id'], ch)
        assert -0.72 < y0 < -0.55 and -0.02 < y1 < 0.1, (ch, y0, y1)
        assert 0 <= x0 < x1 <= adv + 0.01 and abs(adv - 1 / 1.3) < 0.01
    _, y0, _, y1, _ = glyph_bbox(client, res['font']['id'], '。')
    assert y0 > -0.2 and y1 > -0.02                    # full-stop sits low, on the baseline
    # sample preview: chars the font lacks are skipped, never drawn as tofu boxes
    import re
    fid = res['font']['id']
    d = ''.join(re.findall(r' d="([^"]*)"', client.get('/api/v1/fonts/%s/sample.svg?text=AB' % fid).text))
    assert 'L' not in d, d
    d = ''.join(re.findall(r' d="([^"]*)"', client.get('/api/v1/fonts/%s/sample.svg' % fid).text))
    assert d.count('M') > 4                             # default sample = the hanzi it covers
    b = render_bbox(client, res['font']['id'], '永')
    assert 6.0 < b[3] - b[1] < 9.5                      # same size class as the built-in fonts (7-9 mm)


def test_ttc_face_index_and_cff_outline(client):
    data = need(NOTO_TTC)
    t = run(client, data, 'NotoSansCJK-Regular.ttc', mode='outline', charset='custom', chars='中。g',
            face_index=2)
    assert t['state'] == 'done', t
    f = t['result']['font']
    assert f['display_name'].startswith('Noto Sans CJK SC') and t['result']['glyphs'] == 3
    # CFF cubic curves are flattened (the old pen dropped curveTo -> '。' vanished)
    from penplot.psf import read_psf
    font = read_psf(os.path.join(client.app.state.ctx.cfg.font_dir, f['filename']))
    dot = font.glyph('。')
    assert dot is not None and len(dot.ops) > 12
    x0, y0, x1, y1, adv = glyph_bbox(client, f['id'], '中')
    assert -0.72 < y0 < -0.55 and 0 < y1 < 0.1 and abs(adv - 1 / 1.3) < 0.01
    # face 0 (JP) is a different face: name differs
    t = run(client, data, 'NotoSansCJK-Regular.ttc', mode='outline', charset='custom', chars='中', face_index=0)
    assert t['result']['font']['display_name'].startswith('Noto Sans CJK JP')


# ---------------------------------------------------------------- errors
def test_upload_validation_errors(client):
    data = need(DEJAVU)
    bad = [
        (b'\x00' * 3000, 'junk.ttf', {}, 'bad_font'),
        (b'hello', 'hello.txt', {}, 'bad_format'),
        (b'wOFF' + b'\x00' * 100, 'web.woff', {}, 'bad_format'),
        (data, 'a.ttf', {'face_index': 3}, 'bad_input'),
        (data, 'a.ttf', {'face_index': -1}, 'bad_input'),
        (data, 'a.ttf', {'charset': 'custom'}, 'bad_input'),
        (data, 'a.ttf', {'charset': 'custom', 'chars': '   '}, 'bad_input'),
        (data, 'a.ttf', {'charset': 'big5'}, 'bad_input'),
        (data, 'a.ttf', {'mode': 'laser'}, 'bad_input'),
        (data, 'a.ttf', {'size_px': 5000}, 'bad_input'),
        (data, 'a.ttf', {'size_px': 0}, 'bad_input'),
        (data, 'a.ttf', {'simplify_tol': -1}, 'bad_input'),
    ]
    for blob, fn, form, code in bad:
        r = upload(client, blob, fn, **form)
        assert r.status_code == 400, (fn, form, r.text)
        assert r.json()['error']['code'] == code, (fn, form, r.text)
        assert '/tmp' not in r.json()['error']['message'] and 'upload' not in r.json()['error']['message']
    if os.path.exists(NOTO_TTC):
        r = upload(client, need(NOTO_TTC), 'n.ttc', face_index=10, charset='latin')
        assert r.status_code == 400 and '10 个字体' in r.json()['error']['message']
    # a real TTF without extension is sniffed and accepted
    t = run(client, data, 'fontfile', charset='custom', chars='A')
    assert t['state'] == 'done' and t['result']['font']['display_name'] == 'DejaVu Sans 手写'
    assert not leftovers(client)


def test_task_failures_are_clean(client):
    data = need(DEJAVU)
    # truncated font: header ok, tables broken -> failed task, readable message
    t = run(client, data[:20000], 'cut.ttf', charset='latin')
    assert t['state'] == 'failed' and t['error']['code'] == 'bad_font', t
    assert '/tmp' not in t['error']['message'] and 'upload' not in t['error']['message']
    # none of the requested chars exists -> no empty font is installed
    before = {f['id'] for f in client.get('/api/v1/fonts').json()}
    t = run(client, data, 'DejaVuSans.ttf', charset='custom', chars='永中')
    assert t['state'] == 'failed' and t['error']['code'] == 'no_glyphs', t
    assert t['error']['detail']['missing'] == '永中'
    assert {f['id'] for f in client.get('/api/v1/fonts').json()} == before
    assert not leftovers(client)


def test_progress_and_cancel(client):
    data = need(DROID)
    seen = []
    r = upload(client, data, 'DroidSansFallbackFull.ttf', charset='gb2312-1')
    tid = r.json()['task_id']

    def progressed():
        t = client.get('/api/v1/tasks/' + tid).json()
        seen.append(t['progress'])
        return t if t['progress'] > 0.03 else None
    t = wait_for(progressed, timeout=60, dt=0.02)
    assert t['state'] == 'running' and '/' in t['message']        # "123 / 3882 字"
    assert len({p for p in seen if p > 0.02}) >= 1
    assert client.delete('/api/v1/tasks/' + tid, headers=H).status_code == 200
    t = wait_for(lambda: (lambda t: t if t['state'] in ('cancelled', 'done', 'failed') else None)(
        client.get('/api/v1/tasks/' + tid).json()))
    assert t['state'] == 'cancelled', t
    wait_for(lambda: not leftovers(client))
    assert not any(f['source'] == 'ttf' for f in client.get('/api/v1/fonts').json())


def test_process_mode_child(tmp_path):
    """The real path: forkserver child, RLIMIT_AS, progress over the pipe."""
    data = need(DEJAVU)
    app = make_app(tmp_path, task_mode='process')
    with TestClient(app, base_url='http://testserver') as c:
        assert c.post('/api/v1/auth/setup', json={'password': 'correct horse battery'}, headers=H).status_code == 200
        t = run(c, data, 'DejaVuSans.ttf', charset='custom', chars='Hello')
        assert t['state'] == 'done', t
        assert t['result']['font']['display_name'] == 'DejaVu Sans 手写'
        assert not leftovers(c)


# ---------------------------------------------------------------- units
def test_helpers_match_reference():
    np = pytest.importorskip('numpy')
    from penplot.geometry import rdp
    from penplot.image import _NEIGHBORS
    from penplot.strokes import _adjacency
    from penplot.ttffont import TtfError, _components, _rdp, charset_chars, sniff_font

    rng = np.random.default_rng(3)
    for _ in range(100):
        m = rng.random((int(rng.integers(1, 25)), int(rng.integers(1, 25)))) < rng.random() * 0.6
        pts = set(zip(*[a.tolist() for a in np.nonzero(m)]))
        ref = []
        todo = set(pts)
        while todo:
            s = todo.pop()
            comp, st = [s], [s]
            while st:
                y, x = st.pop()
                for dx, dy in _NEIGHBORS:
                    q = (y + dy, x + dx)
                    if q in todo:
                        todo.discard(q)
                        comp.append(q)
                        st.append(q)
            ref.append((min(p[1] for p in comp), min(p[0] for p in comp),
                        max(p[1] for p in comp), max(p[0] for p in comp)))
        assert sorted(tuple(c[2]) for c in _components(m)) == sorted(ref)
        adj = _adjacency(m)
        assert set(adj) == pts
        for p, nb in adj.items():
            assert nb == [(p[0] + dy, p[1] + dx) for dx, dy in _NEIGHBORS if (p[0] + dy, p[1] + dx) in pts]
    random.seed(1)
    for _ in range(300):
        c, x, y = [], 0, 0
        for _i in range(random.randint(1, 60)):
            x += random.choice((-1, 0, 1))
            y += random.choice((0, 1))
            c += [x + .5, y + .5]
        assert _rdp(c, 1.2) == rdp(c, 1.2)

    assert len(charset_chars('latin')) == 95
    g1 = charset_chars('gb2312-1')
    assert len(set(g1)) == len(g1) and '啊' in g1 and '，' in g1 and 'A' in g1
    assert charset_chars('custom', 'aab\nb') == ['a', 'b']
    with pytest.raises(TtfError):
        charset_chars('custom', ' \n')
    assert sniff_font(b'ttcf\x00\x01\x00\x00\x00\x00\x00\x03') == 3
    for bad in (b'', b'GIF89a', b'wOF2xxxx'):
        with pytest.raises(TtfError):
            sniff_font(bad)
