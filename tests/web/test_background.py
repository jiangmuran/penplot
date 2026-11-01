"""Reference backgrounds (Page.background): import (image EXIF / PDF raster), schema round trip,
never part of render paths / G-code / SVG, optional faint PNG layer, bundle export/import."""
import io

import pytest

from conftest import H

PIL = pytest.importorskip('PIL')
from PIL import Image  # noqa: E402


def _pdf(pages_mm):
    from penplot.export.pdf import pdf_bytes
    from penplot.geometry import Path
    pages = []
    for w, h in pages_mm:
        p = Path()
        p.rect(10.0, 10.0, w - 20.0, h - 20.0)
        pages.append(([p], w, h))
    return pdf_bytes(pages, 'tpl')


def _jpeg(w, h, orientation=None, dpi=None, color=(40, 40, 40)):
    im = Image.new('RGB', (w, h), color)
    b = io.BytesIO()
    kw = {}
    if orientation:
        ex = Image.Exif()
        ex[0x0112] = orientation
        kw['exif'] = ex
    if dpi:
        kw['dpi'] = (dpi, dpi)
    im.save(b, 'JPEG', **kw)
    return b.getvalue()


def _project(client, elements, background=None):
    doc = {'version': 1, 'name': 'bg', 'paper': {'paper_id': 'a4-normal'},
           'pages': [{'id': 'p1', 'elements': elements, 'background': background}]}
    r = client.post('/api/v1/projects', json={'name': 'bg', 'doc': doc}, headers=H)
    assert r.status_code == 201, r.text
    return r.json()


def _bg(file_id, **kw):
    d = {'file_id': file_id, 'px_w': 100, 'px_h': 140, 'transform': {'x': 104.5, 'y': 148, 'scale': 2.09,
                                                                   'rotation': 0.3},
         'opacity': 0.6, 'visible': True, 'locked': False}
    d.update(kw)
    return d


RECT = {'id': 'e1', 'type': 'shape', 'transform': {'x': 30, 'y': 40}, 'props': {'kind': 'rect', 'w': 50, 'h': 20}}


def test_import_image_bakes_exif_rotation_and_dpi(client):
    # 300 x 200 landscape pixels, EXIF says "rotate 90° CW" → displayed portrait 200 x 300
    r = client.post('/api/v1/import/background', files={'file': ('scan.jpg', _jpeg(300, 200, 6, 300), 'image/jpeg')},
                    headers=H)
    assert r.status_code == 201, r.text
    d = r.json()
    assert (d['px_w'], d['px_h']) == (200, 300) and d['source'] is None and d['page_count'] == 1
    assert d['file']['kind'] == 'image' and d['file']['meta']['role'] == 'background'
    # scanner dpi → physical size (in display orientation)
    assert d['natural_mm'] == pytest.approx([200 * 25.4 / 300, 300 * 25.4 / 300], abs=0.02)
    img = client.get('/api/v1/files/%s/content' % d['file']['id'])
    assert img.status_code == 200 and img.headers['content-type'] == 'image/jpeg'
    with Image.open(io.BytesIO(img.content)) as im:
        assert im.size == (200, 300) and not im.getexif().get(0x0112)
    # screen-default dpi carries no physical size
    d2 = client.post('/api/v1/import/background', files={'file': ('p.jpg', _jpeg(64, 48, dpi=72))}, headers=H).json()
    assert d2['natural_mm'] is None


def test_import_background_downscales_and_rejects_garbage(client):
    big = Image.new('RGB', (4200, 1000), (200, 200, 200))
    b = io.BytesIO()
    big.save(b, 'PNG')
    d = client.post('/api/v1/import/background', files={'file': ('big.png', b.getvalue())}, headers=H).json()
    assert d['px_w'] == 3000 and d['px_h'] == round(1000 * 3000 / 4200)
    r = client.post('/api/v1/import/background', files={'file': ('x.png', b'not an image')}, headers=H)
    assert r.status_code == 400 and r.json()['error']['code'] == 'bad_image'


def test_import_pdf_page_raster_pick_and_thumb(client):
    pytest.importorskip('pypdfium2')
    data = _pdf([(210.0, 297.0), (148.0, 210.0)])
    r = client.post('/api/v1/import/background', files={'file': ('tpl.pdf', data, 'application/pdf')},
                    data={'page': '1', 'dpi': '100'}, headers=H)
    assert r.status_code == 201, r.text
    d = r.json()
    assert d['page'] == 1 and d['page_count'] == 2 and d['source']['meta']['page_count'] == 2
    assert d['natural_mm'] == pytest.approx([148.0, 210.0], abs=0.6)
    assert d['px_w'] == pytest.approx(148 / 25.4 * 100, abs=2)
    assert d['file']['meta']['source_id'] == d['source']['id']
    with Image.open(io.BytesIO(client.get('/api/v1/files/%s/content' % d['file']['id']).content)) as im:
        assert im.size == (d['px_w'], d['px_h'])
        # the 10 mm inset rectangle is drawn: dark pixels exist, the corner is white paper
        assert im.convert('L').getextrema()[0] < 128 and im.convert('L').getpixel((2, 2)) > 240
    src = d['source']['id']
    r = client.post('/api/v1/import/background/%s/page' % src, json={'page': 0, 'dpi': 150}, headers=H)
    assert r.status_code == 200, r.text
    p0 = r.json()
    assert p0['page'] == 0 and p0['natural_mm'] == pytest.approx([210.0, 297.0], abs=0.6)
    assert p0['px_h'] == pytest.approx(297 / 25.4 * 150, abs=2)
    r = client.post('/api/v1/import/background/%s/page' % src, json={'page': 5}, headers=H)
    assert r.status_code == 400 and r.json()['error']['code'] == 'bad_page'
    t = client.get('/api/v1/import/background/%s/pages/0/thumb.png?size=120' % src)
    assert t.status_code == 200 and t.headers['content-type'] == 'image/png'
    with Image.open(io.BytesIO(t.content)) as im:
        assert max(im.size) <= 120
    # a non-PDF source is refused
    img = client.post('/api/v1/import/background', files={'file': ('a.jpg', _jpeg(10, 10))}, headers=H).json()
    r = client.post('/api/v1/import/background/%s/page' % img['file']['id'], json={'page': 0}, headers=H)
    assert r.status_code == 400
    r = client.post('/api/v1/import/background', files={'file': ('bad.pdf', b'%PDF-1.4 garbage')}, headers=H)
    assert r.status_code == 400 and r.json()['error']['code'] == 'bad_pdf'


def test_background_schema_round_trip(client):
    f = client.post('/api/v1/import/background', files={'file': ('a.jpg', _jpeg(100, 140))}, headers=H).json()
    bg = _bg(f['file']['id'], name='a.jpg', natural_mm=[210, 297], calib={'a': [1, 2], 'b': [90, 2], 'mm': 180})
    p = _project(client, [RECT], bg)
    got = p['doc']['pages'][0]['background']
    assert got['transform'] == bg['transform'] and got['calib'] == {'a': [1.0, 2.0], 'b': [90.0, 2.0], 'mm': 180.0}
    assert got['opacity'] == 0.6 and got['visible'] is True and got['locked'] is False
    assert got['source_id'] is None and got['page'] == 0 and got['natural_mm'] == [210.0, 297.0]
    # PUT keeps it; null clears it
    doc = p['doc']
    doc['pages'][0]['background']['visible'] = False
    r = client.put('/api/v1/projects/' + p['id'], json={'doc': doc, 'rev': p['rev']}, headers=H)
    assert r.status_code == 200 and r.json()['doc']['pages'][0]['background']['visible'] is False
    doc = r.json()['doc']
    doc['pages'][0]['background'] = None
    r = client.put('/api/v1/projects/' + p['id'], json={'doc': doc, 'rev': r.json()['rev']}, headers=H)
    assert r.json()['doc']['pages'][0]['background'] is None
    # validation
    bad = _bg('f1', opacity=2)
    r = client.post('/api/v1/projects', json={'name': 'x', 'doc': {'pages': [{'id': 'p', 'background': bad}]}},
                    headers=H)
    assert r.status_code == 422


def _render(client, pid, doc=None):
    r = client.post('/api/v1/projects/%s/render' % pid, json={'doc': doc} if doc else {}, headers=H)
    assert r.status_code == 200, r.text
    return r.json()


def test_background_never_rendered_or_in_gcode_svg(client):
    f = client.post('/api/v1/import/background', files={'file': ('dark.jpg', _jpeg(100, 140))}, headers=H).json()
    plain = _project(client, [RECT])
    with_bg = _project(client, [RECT], _bg(f['file']['id']))
    a = _render(client, plain['id'])
    b = _render(client, with_bg['id'])
    pa, pb = a['pages'][0], b['pages'][0]
    assert pa['stats'] == pb['stats'] and pa['bbox'] == pb['bbox'] and pa['gcode_lines'] == pb['gcode_lines']
    ga = client.get('/api/v1/render/%s/pages/0/gcode' % a['rid']).text
    gb = client.get('/api/v1/render/%s/pages/0/gcode' % b['rid']).text
    assert ga == gb
    assert client.get('/api/v1/render/%s/pages/0/paths' % a['rid']).content == \
        client.get('/api/v1/render/%s/pages/0/paths' % b['rid']).content
    svg = client.post('/api/v1/render/%s/export' % b['rid'], json={'format': 'svg', 'background': True},
                      headers=H).text
    assert '<image' not in svg and f['file']['id'] not in svg
    # a dangling background file id never breaks rendering (backgrounds are not resolved for renders)
    doc = with_bg['doc']
    doc['pages'][0]['background']['file_id'] = 'fmissing'
    c = _render(client, with_bg['id'], doc)
    assert c['pages'][0]['stats'] == pa['stats']
    # project-level job from a project with a background: same G-code as without
    j = client.post('/api/v1/jobs', json={'source': {'render_id': b['rid'], 'page': 0}}, headers=H)
    assert j.status_code in (200, 201), j.text


def test_png_export_optional_faint_background(client):
    f = client.post('/api/v1/import/background', files={'file': ('dark.jpg', _jpeg(100, 140, color=(0, 0, 0)))},
                    headers=H).json()
    # background covers the whole A4 sheet (100 px * 2.09 mm = 209 mm), no rotation
    p = _project(client, [RECT], _bg(f['file']['id'], transform={'x': 104.5, 'y': 148, 'scale': 2.09,
                                                                 'rotation': 0}, opacity=1.0))
    res = _render(client, p['id'])

    def png(bg):
        r = client.post('/api/v1/render/%s/export' % res['rid'], json={'format': 'png', 'dpi': 36, 'background': bg},
                        headers=H)
        assert r.status_code == 200 and r.headers['content-type'] == 'image/png', r.text[:200]
        return Image.open(io.BytesIO(r.content)).convert('L')

    plain, faint = png(False), png(True)
    corner = (5, 5)                          # paper corner, no ink
    assert plain.getpixel(corner) == 255
    assert 60 < faint.getpixel(corner) < 200          # faint: black at opacity 1 * 0.6
    ink = (round(30 / 25.4 * 36), round(50 / 25.4 * 36))   # on the rect's left edge
    assert min(faint.getpixel((ink[0] + dx, ink[1])) for dx in (-1, 0, 1)) < 30
    # hidden background → no layer
    doc = p['doc']
    doc['pages'][0]['background']['visible'] = False
    res2 = _render(client, p['id'], doc)
    r = client.post('/api/v1/render/%s/export' % res2['rid'], json={'format': 'png', 'dpi': 36, 'background': True},
                    headers=H)
    assert Image.open(io.BytesIO(r.content)).convert('L').getpixel(corner) == 255


def test_bundle_export_import_carries_background(client):
    pytest.importorskip('pypdfium2')
    d = client.post('/api/v1/import/background', files={'file': ('tpl.pdf', _pdf([(210.0, 297.0)]))}, headers=H).json()
    bg = _bg(d['file']['id'], source_id=d['source']['id'], px_w=d['px_w'], px_h=d['px_h'])
    p = _project(client, [RECT], bg)
    data = client.get('/api/v1/projects/%s/export?zip=1' % p['id']).content
    client.delete('/api/v1/projects/' + p['id'], headers=H)
    r = client.post('/api/v1/projects/import', files={'file': ('p.zip', data, 'application/zip')}, headers=H)
    assert r.status_code == 201, r.text
    nb = r.json()['project']['doc']['pages'][0]['background']
    assert r.json()['imported_files'] == 2
    assert client.get('/api/v1/files/%s' % nb['file_id']).json()['kind'] == 'image'
    assert client.get('/api/v1/import/background/%s/pages/0/thumb.png' % nb['source_id']).status_code == 200
