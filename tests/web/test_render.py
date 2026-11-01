import io
import os
import struct
import subprocess
import sys

from fastapi.testclient import TestClient

from conftest import H, PW, REPO, job_wait, make_app, wait_for

TEXT = '你好世界 Hello parity 测试排版，第二句话。'


def _cli_write(tmp_path, *extra):
    out = str(tmp_path / 'cli.gcode')
    subprocess.run([sys.executable, '-m', 'penplot.cli', 'write', TEXT, '-f', 'penplot-sans', '-d',
                    os.path.join(REPO, 'fonts'), '--seed', '7', '--config',
                    os.path.join(REPO, 'configs', 'grbl-zpen.json'), '-o', out] + list(extra),
                   check=True, cwd=REPO, capture_output=True)
    with open(out, newline='') as f:
        return f.read()


def test_render_text_parity_with_cli(client, tmp_path):
    cli = _cli_write(tmp_path)
    r = client.post('/api/v1/render/text', json={'text': TEXT, 'font_id': 'penplot-sans', 'seed': 7,
                                                 'optimize': False}, headers=H)
    assert r.status_code == 200, r.text
    res = r.json()
    g = client.get('/api/v1/render/%s/pages/0/gcode' % res['rid']).text
    assert g == cli
    p = res['pages'][0]
    assert p['gcode_lines'] == len([x for x in cli.split('\n') if x.strip()]) and p['est_s'] > 0
    assert p['machine_bbox'][3] <= 0 and p['bbox'][1] >= 0
    assert p['out_of_work_area'] is False


def test_render_text_parity_optimized(client, tmp_path):
    cli = _cli_write(tmp_path, '--optimize')
    r = client.post('/api/v1/render/text', json={'text': TEXT, 'font_id': 'penplot-sans', 'seed': 7,
                                                 'optimize': True}, headers=H)
    g = client.get('/api/v1/render/%s/pages/0/gcode' % r.json()['rid']).text
    assert g == cli


def _project(c, elements, **doc):
    d = {'name': 't', 'pages': [{'id': 'p1', 'elements': elements}]}
    d.update(doc)
    r = c.post('/api/v1/projects', json={'name': 'demo', 'doc': d}, headers=H)
    assert r.status_code == 201, r.text
    return r.json()


def test_project_crud_rev_and_render(client):
    p = _project(client, [
        {'id': 'e1', 'type': 'text', 'transform': {'x': 20, 'y': 30},
         'props': {'text': 'Hi {{name}}', 'font_id': 'penplot-sans', 'size_mm': 10, 'box': {'w': 100, 'h': 13}}},
        {'id': 'e2', 'type': 'shape', 'transform': {'x': 10, 'y': 100, 'rotation': 90},
         'props': {'kind': 'grid', 'w': 40, 'h': 10, 'cols': 4, 'grid_style': 'tian'}},
        {'id': 'e3', 'type': 'shape', 'hidden': True, 'props': {'kind': 'rect', 'w': 500, 'h': 500}},
        {'id': 'e4', 'type': 'shape', 'transform': {'x': 150, 'y': 200},
         'props': {'kind': 'ellipse', 'w': 30, 'h': 20, 'hatch': {'angle': 30, 'spacing': 2}}},
    ], variables=[{'name': 'name', 'default': 'World'}])
    assert p['rev'] == 1 and p['doc']['pages'][0]['elements'][0]['props']['line_height'] == 1.3
    lst = client.get('/api/v1/projects').json()
    assert lst[0]['id'] == p['id'] and lst[0]['pages'] == 1
    # stale rev
    r = client.put('/api/v1/projects/' + p['id'], json={'doc': p['doc'], 'rev': 0}, headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'rev_conflict'
    r = client.put('/api/v1/projects/' + p['id'], json={'doc': p['doc'], 'rev': 1}, headers=H)
    assert r.json()['rev'] == 2
    r = client.patch('/api/v1/projects/%s/elements/e1' % p['id'],
                     json={'transform': {'x': 25, 'y': 30}, 'props': {'size_mm': 9}}, headers=H)
    assert r.json()['rev'] == 3
    el = r.json()['doc']['pages'][0]['elements'][0]
    assert el['transform']['x'] == 25 and el['props']['size_mm'] == 9 and el['props']['text'] == 'Hi {{name}}'
    r = client.post('/api/v1/projects/%s/render' % p['id'], json={'variables': {'name': 'Bob'}}, headers=H)
    assert r.status_code == 200, r.text
    res = r.json()
    pg = res['pages'][0]
    assert pg['stats']['strokes'] > 10 and not pg['warnings']['clipped'] and not pg['warnings']['overflow']
    # hidden 500 mm rect excluded
    assert pg['bbox'][2] < 209
    svg = client.get('/api/v1/render/%s/pages/0/preview.svg?travel=1' % res['rid']).text
    assert svg.startswith('<svg') and '#e55' in svg
    msvg = client.get('/api/v1/render/%s/pages/0/preview.svg?space=machine' % res['rid']).text
    assert msvg.startswith('<svg')
    blob = client.get('/api/v1/render/%s/pages/0/paths' % res['rid']).content
    magic, n = struct.unpack_from('<II', blob)
    assert magic == 0x314C5050 and n == pg['stats']['strokes']
    # exports
    for fmt, ct in (('pdf', 'application/pdf'), ('svg', 'image/svg+xml'), ('gcode', 'text/plain'),
                    ('zip', 'application/zip'), ('png', 'image/png')):
        r = client.post('/api/v1/render/%s/export' % res['rid'], json={'format': fmt}, headers=H)
        assert r.status_code == 200 and r.headers['content-type'].startswith(ct), (fmt, r.text[:200])
    assert client.post('/api/v1/render/%s/export' % res['rid'], json={'format': 'pdf'},
                       headers=H).content.startswith(b'%PDF-1.4')
    # save to library + job from the project directly
    files = client.post('/api/v1/render/%s/save' % res['rid'], json={'name': 'demo'}, headers=H).json()
    assert files[0]['kind'] == 'gcode' and files[0]['name'] == 'demo.gcode'
    j = client.post('/api/v1/jobs', json={'source': {'project_id': p['id'], 'page': 0}, 'start': True},
                    headers=H).json()
    assert job_wait(client, j['id'], timeout=60)['status'] == 'done'
    # duplicate / template / export-import
    d = client.post('/api/v1/projects/%s/save-as-template' % p['id'], headers=H).json()
    assert d['is_template'] is True
    assert [x['id'] for x in client.get('/api/v1/projects?template=1').json() if not x['builtin']] == [d['id']]
    n = client.post('/api/v1/projects', json={'name': 'from t', 'from_template_id': d['id']}, headers=H).json()
    assert n['is_template'] is False and len(n['doc']['pages'][0]['elements']) == 4
    data = client.get('/api/v1/projects/%s/export?zip=1' % p['id']).content
    r = client.post('/api/v1/projects/import', files={'file': ('p.zip', data, 'application/zip')}, headers=H)
    assert r.status_code == 201 and r.json()['missing_fonts'] == []
    assert client.delete('/api/v1/projects/' + p['id'], headers=H).status_code == 204
    assert client.get('/api/v1/projects/' + p['id']).status_code == 404


def test_flow_text_adds_pages_and_missing_glyphs(client):
    text = '\n'.join('LINE %02d' % i for i in range(45)) + ' 龘'
    p = _project(client, [{'id': 'f', 'type': 'flow_text', 'props': {'text': text, 'font_id': 'penplot-sans',
                                                                       'seed': 1, 'missing_glyph': 'skip'}}])
    res = client.post('/api/v1/projects/%s/render' % p['id'], json={}, headers=H).json()
    assert len(res['pages']) == 3 and [x['source_page'] for x in res['pages']] == [0, 0, 0]
    assert res['pages'][2]['warnings']['missing_glyphs'] == ['龘']
    # one batch of jobs for all pages
    j = client.post('/api/v1/jobs', json={'source': {'render_id': res['rid']}}, headers=H).json()
    assert j['batch_id'] and len(client.get('/api/v1/batches/' + j['batch_id']).json()['jobs']) == 3


def test_missing_font_falls_back_and_paper_errors(client):
    p = _project(client, [{'id': 'x', 'type': 'text', 'props': {'text': 'a', 'font_id': 'nope'}}])
    r = client.post('/api/v1/projects/%s/render' % p['id'], json={}, headers=H)
    assert r.status_code == 200 and 'nope' in ' '.join(r.json()['pages'][0]['warnings']['messages'])
    r = client.post('/api/v1/render/text', json={'text': 'a', 'paper': {'paper_id': 'zzz'}}, headers=H)
    assert r.status_code == 404


def test_origin_and_bounds(client):
    p = _project(client, [{'id': 's', 'type': 'shape', 'transform': {'x': 0, 'y': 0},
                           'props': {'kind': 'rect', 'w': 10, 'h': 10}}])
    res = client.post('/api/v1/projects/%s/render' % p['id'],
                      json={'overrides': {'origin': {'corner': 3}}}, headers=H).json()
    # RightDown origin: the top-left rect sits at x<0, y>0
    bb = res['pages'][0]['machine_bbox']
    assert bb == [-209.0, 286.0, -199.0, 296.0]
    res = client.post('/api/v1/projects/%s/render' % p['id'], json={'overrides': {'origin': {'corner': 0}}},
                      headers=H).json()
    assert res['pages'][0]['machine_bbox'] == [0.0, -10.0, 10.0, 0.0]
    big = _project(client, [{'id': 's', 'type': 'shape', 'props': {'kind': 'rect', 'w': 400, 'h': 10}}])
    res = client.post('/api/v1/projects/%s/render' % big['id'], json={}, headers=H).json()
    assert res['pages'][0]['out_of_work_area'] and res['pages'][0]['warnings']['clipped']


def test_imports_svg_dxf_image_table_text_and_batch(client, tmp_path):
    svg = (b'<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">'
           b'<path d="M0 0 L40 20 M0 20 C 10 0 30 0 40 20" stroke="black" fill="none"/>'
           b'<circle cx="20" cy="10" r="5"/></svg>')
    r = client.post('/api/v1/import/svg', files={'file': ('a.svg', svg, 'image/svg+xml')}, headers=H)
    assert r.status_code == 201, r.text
    v = r.json()
    assert v['paths'] == 3 and abs(v['width_mm'] - 40) < 0.01 and abs(v['height_mm'] - 20) < 0.01
    bad = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg"/>'
    assert client.post('/api/v1/import/svg', files={'file': ('b.svg', bad)}, headers=H).status_code == 400
    import ezdxf
    doc = ezdxf.new()
    doc.units = 4   # mm
    doc.modelspace().add_line((0, 0), (10, 5))
    doc.modelspace().add_circle((5, 5), 2)
    dpath = str(tmp_path / 'a.dxf')
    doc.saveas(dpath)
    r = client.post('/api/v1/import/dxf', files={'file': ('a.dxf', open(dpath, 'rb').read())}, headers=H)
    assert r.status_code == 201, r.text
    dx = r.json()
    from PIL import Image, ImageDraw
    im = Image.new('L', (200, 100), 255)
    ImageDraw.Draw(im).rectangle([40, 20, 160, 80], outline=0, width=6)
    b = io.BytesIO()
    im.save(b, 'PNG')
    r = client.post('/api/v1/import/image', files={'file': ('a.png', b.getvalue(), 'image/png')}, headers=H)
    assert r.status_code == 201 and r.json()['px_w'] == 200
    img = r.json()
    r = client.post('/api/v1/import/image/%s/trace' % img['file']['id'], json={'mode': 'edge', 'width_mm': 50},
                    headers=H)
    assert r.status_code == 200 and r.json()['paths'] >= 1 and r.json()['svg'].startswith('<svg')
    r = client.post('/api/v1/import/text', files={'file': ('a.txt', '中文文本'.encode('gb18030'))}, headers=H)
    assert r.json() == {'text': '中文文本', 'encoding': 'gb18030', 'chars': 4}
    csv = '姓名,地址\n张三,北京\n李四,上海\n'.encode('utf-8')
    r = client.post('/api/v1/import/table', files={'file': ('d.csv', csv)}, headers=H)
    t = r.json()
    assert t['sheets'][0]['columns'] == ['姓名', '地址'] and t['sheets'][0]['row_count'] == 2
    p = _project(client, [
        {'id': 't', 'type': 'text', 'props': {'text': '{{name}}', 'font_id': 'penplot-sans'}},
        {'id': 's', 'type': 'svg', 'transform': {'x': 100, 'y': 100}, 'props': {'file_id': v['file']['id'], 'width_mm': 20}},
        {'id': 'd', 'type': 'dxf', 'transform': {'x': 10, 'y': 200}, 'props': {'file_id': dx['file']['id']}},
        {'id': 'i', 'type': 'image', 'transform': {'x': 120, 'y': 20}, 'props': {'file_id': img['file']['id'], 'width_mm': 40}},
        {'id': 'g', 'type': 'gcode', 'transform': {'x': 30, 'y': 250}, 'props': {'file_id': _gid(client)}},
    ], variables=[{'name': 'name'}])
    r = client.post('/api/v1/projects/%s/render' % p['id'], json={'variables': {'name': 'X'}}, headers=H)
    assert r.status_code == 200, r.text
    bb = r.json()['pages'][0]['bbox']
    assert bb[0] >= 0 and bb[3] <= 296
    # batch: preview one row, then create one job per row
    body = {'data_file_id': t['file']['id'], 'mapping': {'name': '姓名'}, 'name_pattern': '{{name}}'}
    r = client.post('/api/v1/projects/%s/batch' % p['id'], json=dict(body, preview_row=1), headers=H)
    assert r.status_code == 200, r.text
    assert r.json()['render']['pages'] and r.json()['jobs'] == []
    r = client.post('/api/v1/projects/%s/batch' % p['id'], json=body, headers=H)
    br = r.json()
    assert br['rows'] == 2 and len(br['jobs']) == 2
    jobs = client.get('/api/v1/jobs?batch_id=' + br['batch_id']).json()
    assert sorted(j['name'] for j in jobs) == ['demo 张三', 'demo 李四']
    # library
    lst = client.get('/api/v1/files?kind=svg').json()
    assert [f['id'] for f in lst if '模板素材' not in (f.get('tags') or [])] == [v['file']['id']]
    assert client.get('/api/v1/files/%s/content' % v['file']['id']).content == svg
    assert client.get('/api/v1/files/%s/preview.svg' % _gid(client)).text.startswith('<svg')
    r = client.patch('/api/v1/files/' + v['file']['id'], json={'name': 'x.svg', 'tags': ['a']}, headers=H)
    assert r.json()['tags'] == ['a']


def _gid(c):
    from conftest import gcode_file, square_gcode
    return gcode_file(c, square_gcode(4), 'sq.gcode')['file']['id']


def test_fonts_endpoints(client):
    fonts = client.get('/api/v1/fonts').json()
    assert any(f['id'] == 'penplot-sans' for f in fonts)
    r = client.get('/api/v1/fonts?covers=AB龘').json()
    assert r[0]['missing'] == ['龘']
    d = client.get('/api/v1/fonts/penplot-sans').json()
    assert d['coverage_summary']['latin'] > 50
    assert client.get('/api/v1/fonts/penplot-sans/coverage?text=A龘').json()['missing'] == ['龘']
    rg = client.get('/api/v1/fonts/penplot-sans/coverage').json()['ranges']
    assert [0x41, 0x5A] in rg or any(lo <= 0x41 and hi >= 0x5A for lo, hi in rg)
    r = client.get('/api/v1/fonts/penplot-sans/glyphs/u+0041.svg')
    assert r.status_code == 200 and r.headers['etag']
    assert client.get('/api/v1/fonts/penplot-sans/glyphs/65.svg',
                      headers={'If-None-Match': r.headers['etag']}).status_code == 304
    g = client.get('/api/v1/fonts/penplot-sans/glyphs?from=0&count=10').json()
    assert len(g['glyphs']) == 10 and g['next_from'] == 10
    s = client.get('/api/v1/fonts/penplot-sans/sample.svg?text=Hello').text
    assert s.startswith('<svg')
    psf = client.post('/api/v1/fonts/penplot-sans/convert', json={'to': 'psf'}, headers=H).content
    assert psf.startswith(b'#psf')
    gf = client.post('/api/v1/fonts/penplot-sans/convert', json={'to': 'gfont'}, headers=H).content
    r = client.post('/api/v1/fonts', files={'file': ('my font.gfont', gf)}, headers=H)
    assert r.status_code == 201, r.text
    up = r.json()
    assert up['source'] == 'upload' and up['format'] == 'gfont' and up['glyph_count'] > 50
    assert client.patch('/api/v1/fonts/' + up['id'], json={'display_name': '我的'}, headers=H).json()['display_name'] == '我的'
    assert client.delete('/api/v1/fonts/penplot-sans', headers=H).status_code == 409
    assert client.patch('/api/v1/fonts/penplot-sans', json={'hidden': True}, headers=H).json()['hidden']
    assert all(f['id'] != 'penplot-sans' for f in client.get('/api/v1/fonts').json())
    assert client.delete('/api/v1/fonts/' + up['id'], headers=H).status_code == 204
    assert client.post('/api/v1/fonts', files={'file': ('bad.gfont', b'xx')}, headers=H).status_code == 400


def test_process_task_mode_render_and_cancel(tmp_path):
    app = make_app(tmp_path, task_mode='process')
    with TestClient(app) as c:
        c.post('/api/v1/auth/setup', json={'password': PW}, headers=H)
        r = c.post('/api/v1/render/text?wait=30', json={'text': 'abc', 'font_id': 'penplot-sans'}, headers=H)
        assert r.status_code == 200, r.text
        tasks = app.state.ctx.tasks
        t = tasks.submit('sleep', {'steps': 50, 'dt': 0.1})
        wait_for(lambda: t.state == 'running')
        r = c.delete('/api/v1/tasks/' + t.id, headers=H)
        assert r.status_code == 200
        wait_for(lambda: t.state == 'cancelled', 5)
        # superseded slot: a RUNNING render is never killed (slow boards would
        # starve the slot); older QUEUED ones are dropped; identical requests
        # ride on the existing task
        t1 = tasks.submit('sleep', {'steps': 10, 'dt': 0.1}, slot='c1/p1')
        wait_for(lambda: t1.state == 'running')
        assert tasks.submit('sleep', {'steps': 10, 'dt': 0.1}, slot='c1/p1') is t1
        t2 = tasks.submit('sleep', {'steps': 1, 'dt': 0.01}, slot='c1/p1')
        wait_for(lambda: t1.state == 'done' and t2.state == 'done', 15)
        assert c.get('/api/v1/tasks/' + t2.id).json()['result'] == {'slept': 1}
        # an older queued task in the slot is cancelled by a newer one
        busy = [tasks.submit('sleep', {'steps': 20, 'dt': 0.1}) for _ in range(4)]
        q1 = tasks.submit('sleep', {'steps': 1, 'dt': 0.01, 'n': 1}, slot='c1/p2')
        q2 = tasks.submit('sleep', {'steps': 1, 'dt': 0.01, 'n': 2}, slot='c1/p2')
        assert q1.state == 'cancelled' and q2.state in ('queued', 'running')
        for b_ in busy:
            tasks.cancel(b_.id)
        wait_for(lambda: q2.state == 'done', 15)
        # 202 path
        r = c.post('/api/v1/render/text?wait=0', json={'text': 'abc'}, headers=H)
        assert r.status_code == 202 and r.json()['task_id']


def test_trace_image_in_rlimited_child(tmp_path, monkeypatch):
    """numpy in a forkserver child under RLIMIT_AS (OpenBLAS thread buffers must be capped)."""
    import io as _io
    from PIL import Image, ImageDraw
    for k in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'):
        monkeypatch.delenv(k, raising=False)
    app = make_app(tmp_path, task_mode='process')
    with TestClient(app) as c:
        c.post('/api/v1/auth/setup', json={'password': PW}, headers=H)
        im = Image.new('L', (300, 200), 255)
        ImageDraw.Draw(im).ellipse([50, 30, 250, 170], outline=0, width=8)
        b = _io.BytesIO()
        im.save(b, 'PNG')
        f = c.post('/api/v1/import/image', files={'file': ('c.png', b.getvalue())}, headers=H).json()
        for mode in ('edge', 'skeleton'):
            r = c.post('/api/v1/import/image/%s/trace?wait=60' % f['file']['id'], json={'mode': mode}, headers=H)
            assert r.status_code == 200, r.text
            assert r.json()['paths'] >= 1


def test_identical_slot_renders_are_shared_and_reused(client):
    """Two clients (slots) asking for the same page share one task; a reload reuses the
    finished result instead of re-rendering (09-perf: a 4 400-stroke SVG took ~75 s/render)."""
    p = _project(client, [
        {'id': 'e1', 'type': 'shape', 'transform': {'x': 10, 'y': 10},
         'props': {'kind': 'rect', 'w': 40, 'h': 20}},
    ])
    url = '/api/v1/projects/%s/render' % p['id']
    a = client.post(url, json={}, headers={**H, 'X-Render-Slot': 'ca/page'}).json()
    b = client.post(url, json={}, headers={**H, 'X-Render-Slot': 'cb/page'}).json()
    assert a['rid'] == b['rid']
    # a different doc is a different render; no slot (print / job prep) never shares
    c = client.post(url, json={}, headers=H).json()
    assert c['rid'] != a['rid']
    p2 = client.patch('/api/v1/projects/%s/elements/e1' % p['id'], json={'transform': {'x': 12, 'y': 10}},
                      headers=H).json()
    assert p2['rev'] == 2
    d = client.post(url, json={}, headers={**H, 'X-Render-Slot': 'ca/page'}).json()
    assert d['rid'] != a['rid']
    assert client.get('/api/v1/render/%s/pages/0/paths' % a['rid']).status_code == 200


def test_optimize_paths_matches_reference():
    import copy
    import random
    from penplot import gcode
    from penplot.geometry import Path
    r = random.Random(3)
    paths = []
    for _ in range(400):
        q = Path()
        q.move_to(float(r.randint(0, 30)), float(r.randint(0, 30)))   # integer grid: many ties
        for _ in range(r.randint(1, 4)):
            q.line_to(float(r.randint(0, 30)), float(r.randint(0, 30)))
        paths.append(q)
    for nd in (0.0, 1.0, 5.0):
        a, b = copy.deepcopy(paths), copy.deepcopy(paths)
        assert [x.coords for x in gcode.optimize_paths(a, nd)] == \
            [x.coords for x in gcode._optimize_paths_py(b, nd)]


def test_quiet_tasks_have_their_own_lane(tmp_path):
    """Font samples (quiet) must not wait behind long renders that fill limit()."""
    app = make_app(tmp_path, task_mode='thread')
    with TestClient(app):
        tasks = app.state.ctx.tasks
        heavy = [tasks.submit('sleep', {'steps': 40, 'dt': 0.05, 'n': i}) for i in range(tasks.limit() + 1)]
        wait_for(lambda: sum(h.state == 'running' for h in heavy) == tasks.limit())
        q = tasks.submit('sleep', {'steps': 1, 'dt': 0.01}, quiet=True)
        wait_for(lambda: q.state == 'done', 1.5)
        assert heavy[-1].state == 'queued'      # heavy work still obeys the limit
        for h in heavy:
            tasks.cancel(h.id)
