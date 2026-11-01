# -*- coding: utf-8 -*-
"""SVG <text> -> single-stroke font paths (importers/svg_text + compose svg path source)."""
import os
import shutil

import pytest

from conftest import H, REPO

from penplot import compose
from penplot.builtin_font import load_builtin
from penplot.compose import Resolver, _element_paths
from penplot.geometry import bbox_of
from penplot.importers.svg import load_svg
from penplot.importers.svg_text import font_em_units

HEI = os.path.join(REPO, 'fonts', 'open-hei-stroke.psf')
SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50">%s</svg>'
# builtin penplot-sans: cap height 62 units -> em = 62 / 0.70; 'H' ink x 12..44
BUILTIN = load_builtin()
EM = font_em_units(BUILTIN)
H_W = 32.0 / EM          # ink width of H per em
SB = 0.06                # side bearing (em) for fonts without stored advances


def _write(tmp_path, body, name='t.svg'):
    p = tmp_path / name
    p.write_text(SVG % body, encoding='utf-8')
    return str(p)


def _render(path, font=BUILTIN, **kw):
    miss, msgs = set(), []
    ps, info = load_svg(path, text=dict(mode=kw.pop('mode', 'font'), font_for=lambda fams: font,
                                        missing=miss, messages=msgs, **kw))
    return ps, info, miss, msgs


def _close(bb, exp, tol=0.02):
    assert bb is not None and all(abs(a - b) <= tol for a, b in zip(bb, exp)), (bb, exp)


def test_simple_text_baseline_and_cap_height(tmp_path):
    ps, info, miss, msgs = _render(_write(tmp_path, '<text x="10" y="20" font-size="10">H</text>'))
    # baseline at the SVG y, cap height 0.70 em, x = x + side bearing
    _close(bbox_of(ps), [10 + SB * 10, 13.0, 10 + SB * 10 + H_W * 10, 20.0])
    assert not miss and not msgs
    assert info['text_runs'] == [{'text_index': 0, 'content': 'H', 'font_family': 'sans-serif',
                                  'families': ['sans-serif'], 'font_size': 10.0, 'size_mm': 10.0, 'chars': 1}]


def test_transformed_group_and_units(tmp_path):
    body = ('<g transform="translate(10 5) scale(2)"><text x="0" y="10" style="font-size:5px">H</text></g>'
            '<text x="50" y="40" font-size="2mm">H</text>')
    ps, info, _m, _w = _render(_write(tmp_path, body))
    a, b = sorted(ps, key=lambda p: p.bbox()[0])
    _close(a.bbox(), [10 + 2 * SB * 5, 25 - 7, 10 + 2 * (SB + H_W) * 5, 25.0])
    # 2mm = 7.559 user units (px) in a 1 unit = 1 mm document
    fs = 2 * 96 / 25.4
    _close(b.bbox(), [50 + SB * fs, 40 - 0.7 * fs, 50 + (SB + H_W) * fs, 40.0])
    assert [r['size_mm'] for r in info['text_runs']] == [10.0, round(fs, 3)]


def test_tspan_positions_and_anchor_middle(tmp_path):
    body = ('<text x="10 30" y="20" font-size="10">HH<tspan x="60" dy="5" font-size="5">H</tspan>'
            '<tspan dx="1">H</tspan></text>'
            '<text x="50" y="45" font-size="10" text-anchor="middle">HH</text>')
    ps, info, _m, _w = _render(_write(tmp_path, body))
    xs = sorted((round(p.bbox()[0], 2), round(p.bbox()[3], 2)) for p in ps)
    adv5 = (H_W + 2 * SB) * 5
    assert xs[0] == (round(10 + SB * 10, 2), 20.0)
    assert xs[1] == (round(30 + SB * 10, 2), 20.0)
    # tspan: absolute x, dy shifts the baseline; next tspan continues with dx
    assert (round(60 + SB * 5, 2), 25.0) in xs
    assert (round(60 + adv5 + 1 + SB * 10, 2), 25.0) in xs   # 2nd tspan inherits 10
    # middle: the two-glyph advance box is centred on x=50
    mid = [p for p in ps if abs(p.bbox()[3] - 45) < 1e-3]
    bb = bbox_of(mid)
    assert abs((bb[0] + bb[2]) / 2 - 50) < 0.02
    assert [r['content'] for r in info['text_runs']] == ['HH', 'H', 'H', 'HH']   # runs split on size


def test_whitespace_end_anchor_and_baseline_props(tmp_path):
    body = ('<text x="90" y="10" font-size="10" text-anchor="end">  H\n   H  </text>'
            '<text x="10" y="30" font-size="10" dominant-baseline="middle">H</text>'
            '<text x="10" y="45" font-size="10" xml:space="preserve" letter-spacing="2">H  H</text>')
    ps, info, _m, _w = _render(_write(tmp_path, body))
    end = bbox_of([p for p in ps if p.bbox()[3] <= 10.01])
    adv = (H_W + 2 * SB) * 10
    space = 0.3 * 10
    assert abs(end[2] - (90 - SB * 10)) < 0.02 and abs(end[0] - (90 - 2 * adv - space + SB * 10)) < 0.02
    mid = [p for p in ps if 20 < p.bbox()[3] < 40][0]
    assert abs(mid.bbox()[3] - 32.5) < 0.02             # middle: baseline 0.25 em below y
    pres = sorted(p.bbox()[0] for p in ps if p.bbox()[3] > 40)
    assert abs(pres[1] - pres[0] - (adv + 2 + 2 * (space + 2))) < 0.02
    assert info['text_runs'][0]['content'] == 'H H'


def test_css_classes_textpath_vertical_warn(tmp_path):
    body = ('<style>.big{font-size:20px;font-family:"Kai", serif}</style>'
            '<defs><path id="p" d="M0 0 L100 0"/><text id="hidden">X</text></defs>'
            '<text class="big" x="10" y="30">H<tspan font-size="0.5em">H</tspan></text>'
            '<text x="10" y="45" font-size="5"><textPath href="#p">H</textPath></text>'
            '<text x="80" y="5" font-size="5" writing-mode="tb">HH</text>')
    ps, info, _m, msgs = _render(_write(tmp_path, body))
    big = [p for p in ps if abs(p.bbox()[3] - 30) < 1e-3]
    assert abs(big[0].bbox()[1] - (30 - 14)) < 0.02 and abs(big[1].bbox()[1] - (30 - 7)) < 0.02
    assert info['text_families'] == ['"Kai", serif', 'sans-serif']
    assert info['text_runs'][0]['families'] == ['Kai', 'serif']
    assert any('textPath' in m for m in msgs) and any('竖排' in m for m in msgs)
    assert not any('X' == r['content'] for r in info['text_runs'])


def test_modes_skip_outline_and_metadata_estimate(tmp_path):
    path = _write(tmp_path, '<path d="M0 0 L5 5" stroke="black"/><text x="10" y="20" font-size="10">中文</text>')
    ps, info, _m, msgs = _render(path, mode='skip')
    assert len(ps) == 1 and not msgs
    ps, info, _m, msgs = _render(path, mode='outline')
    assert len(ps) == 1 and msgs and '轮廓' in msgs[0]
    _ps, meta = load_svg(path)            # import metadata: text estimated, not drawn
    assert meta['paths'] == 1 and meta['bbox_mm'][2] == pytest.approx(30.0, abs=1e-3)
    assert meta['bbox_mm'][3] == pytest.approx(21.0, abs=1e-3)      # ink estimate -0.8 .. +0.1 em
    assert meta['text_runs'][0]['content'] == '中文' and meta['text_runs'][0]['chars'] == 2


def test_missing_glyph_box_and_skip(tmp_path):
    path = _write(tmp_path, '<text x="10" y="20" font-size="10">H中</text>')
    ps, _i, miss, _w = _render(path)
    assert miss == {'中'} and len(ps) == 2
    ps, _i, miss, _w = _render(path, missing_glyph='skip')
    assert miss == {'中'} and len(ps) == 1


@pytest.mark.skipif(not os.path.exists(HEI), reason='needs fonts/open-hei-stroke.psf')
def test_chinese_text_with_cjk_font(tmp_path):
    from penplot.psf import load_font
    hei = load_font(HEI)
    em = font_em_units(hei)
    assert em == pytest.approx(hei.glyph('国').advance)   # stored advance = 1 em
    body = '<text x="10" y="20" font-family="SimHei" font-size="10" text-anchor="middle">中文测试</text>'
    ps, info, miss, _w = _render(_write(tmp_path, body), font=hei)
    assert not miss and len(ps) == 4
    bb = bbox_of(ps)
    # 4 ideographs, 1 em advance each, centred on x=10; ink sits on the baseline
    assert abs(bb[0] - (10 - 20)) < 2 and abs(bb[2] - (10 + 20)) < 2
    assert 19 < bb[3] < 21.5 and 10 < bb[1] < 13
    assert info['text_runs'][0]['families'] == ['SimHei']


def _resolver(tmp_path, cache=True):
    fd = tmp_path / 'f'
    fd.mkdir(exist_ok=True)
    src = HEI if os.path.exists(HEI) else os.path.join(REPO, 'fonts', 'penplot-sans.psf')
    a = fd / 'a.psf'
    shutil.copy(src, a)
    shutil.copy(os.path.join(REPO, 'fonts', 'penplot-sans.psf'), fd / 'b.psf')
    return Resolver(fonts={'a': str(a), 'b': str(fd / 'b.psf')}, files={},
                    default_font='b', cache_dir=str(tmp_path / 'cache') if cache else None)


def test_compose_font_map_scale_and_cache_invalidation(tmp_path, monkeypatch):
    res = _resolver(tmp_path)
    svg = _write(tmp_path, '<text x="10" y="20" font-size="10" font-family="Kai">HI</text>'
                           '<text x="10" y="40" font-size="10" font-family="Other">HI</text>')
    res.files['f'] = svg
    builds = []
    orig = compose.vector_paths
    monkeypatch.setattr(compose, 'vector_paths', lambda *a, **k: builds.append(1) or orig(*a, **k))

    def run(**props):
        el = {'id': 'e1', 'type': 'svg', 'props': dict({'file_id': 'f'}, **props)}
        warn = {'missing': set(), 'overflow': False, 'messages': []}
        ps = _element_paths(el, None, res, {}, None, warn)
        bb = bbox_of(ps)
        return ([round(v, 3) for v in bb] if bb else None), len(ps), warn

    base = run()                              # default font b (builtin-like penplot-sans)
    assert len(builds) == 1 and run() == base and len(builds) == 1          # cache hit
    mapped = run(text_font_map={'kai': 'a'})
    assert len(builds) == 2 and mapped != base
    big = run(text_size_scale=2.0)
    # element-local = top-left of the bbox; baselines stay 20 mm apart, caps grow 7 -> 14 mm
    assert base[0][3] == pytest.approx(27.0, abs=0.01) and big[0][3] == pytest.approx(34.0, abs=0.01)
    assert big[0][2] - big[0][0] > base[0][2] - base[0][0]
    # font file changes on disk -> props hash includes font mtimes -> rebuild
    n = len(builds)
    run(text_font_id='a')
    assert len(builds) == n + 1
    run(text_font_id='a')
    assert len(builds) == n + 1
    p = res.fonts['a']
    st = os.stat(p)
    with open(p, 'a') as f:
        f.write('\n')
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 10 ** 9))
    run(text_font_id='a')
    assert len(builds) == n + 2
    # skip mode: no fonts in the key, and no text
    sk = run(text_mode='skip')
    assert sk[1] == 0 and sk[0] is None


def test_compose_warnings_survive_cache(tmp_path):
    res = _resolver(tmp_path)
    res.files['f'] = _write(tmp_path, '<text x="10" y="20" font-size="10">Hé<textPath>H</textPath></text>')
    el = {'id': 'e1', 'type': 'svg', 'props': {'file_id': 'f', 'text_font_id': 'b'}}
    for _ in range(2):
        warn = {'missing': set(), 'overflow': False, 'messages': []}
        _element_paths(el, None, res, {}, None, warn)
        assert warn['missing'] == {'é'} and any('textPath' in m for m in warn['messages'])


def test_import_endpoint_lists_text_runs_and_render(client):
    svg = (SVG % ('<path d="M0 0 L40 20" stroke="black"/>'
                  '<text x="10" y="30" font-family="Microsoft YaHei" font-size="8">你好 <tspan font-size="4">Hi</tspan></text>'
                  '<text x="10" y="45" font-family="Arial" font-size="6">ABC</text>')).encode('utf-8')
    r = client.post('/api/v1/import/svg', files={'file': ('t.svg', svg, 'image/svg+xml')}, headers=H)
    assert r.status_code == 201, r.text
    v = r.json()
    assert [t['content'] for t in v['text_runs']] == ['你好', 'Hi', 'ABC']
    assert v['text_families'] == ['Microsoft YaHei', 'Arial']
    assert v['file']['meta']['text_runs'][2]['size_mm'] == 6.0
    assert v['paths'] == 1 and v['height_mm'] > 40          # estimate includes the text
    doc = {'name': 't', 'pages': [{'id': 'p1', 'elements': [
        {'id': 's', 'type': 'svg', 'transform': {'x': 10, 'y': 10},
         'props': {'file_id': v['file']['id'], 'text_font_id': 'penplot-sans',
                   'text_font_map': {'arial': 'no-such-font'}}}]}]}
    p = client.post('/api/v1/projects', json={'name': 'svgtext', 'doc': doc}, headers=H).json()
    r = client.post('/api/v1/projects/%s/render' % p['id'], json={}, headers=H)
    assert r.status_code == 200, r.text
    pg = r.json()['pages'][0]
    assert pg['stats']['strokes'] > 5
    assert set('你好') <= set(pg['warnings']['missing_glyphs'])       # builtin font lacks CJK
    r = client.post('/api/v1/projects/%s/render' % p['id'], json={}, headers=H)
    assert r.json()['pages'][0]['stats'] == pg['stats']
