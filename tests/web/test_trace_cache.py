"""Image trace preview fills the element cache; project render / print reuse it."""
import io
import os

import pytest

from conftest import H

pytest.importorskip('numpy')
from PIL import Image, ImageDraw  # noqa: E402


def _upload(client, w=2400, h=1600):
    im = Image.new('L', (w, h), 245)
    d = ImageDraw.Draw(im)
    for k in range(5):
        d.ellipse([100 + k * 450, 200, 500 + k * 450, 1400], outline=10, width=14)
    b = io.BytesIO()
    im.save(b, 'JPEG', quality=90)
    r = client.post('/api/v1/import/image', files={'file': ('scan.jpg', b.getvalue(), 'image/jpeg')}, headers=H)
    assert r.status_code == 201, r.text
    return r.json()['file']['id']


def test_trace_preview_then_render_hits_cache(client, app, monkeypatch):
    fid = _upload(client)
    r = client.post('/api/v1/import/image/%s/trace?wait=30' % fid, json={'mode': 'edge', 'width_mm': 60}, headers=H)
    assert r.status_code == 200, r.text
    assert r.json()['paths'] >= 5 and 50 < r.json()['width_mm'] <= 60.5
    el_dir = app.state.ctx.cfg.el_cache_dir
    assert len(os.listdir(el_dir)) == 1
    from penplot import image as im
    monkeypatch.setattr(im, 'load_gray', lambda *a, **k: (_ for _ in ()).throw(AssertionError('re-traced')))
    doc = {'version': 1, 'name': 'img', 'paper': {'paper_id': 'a4-normal'}, 'variables': [], 'print': {},
           'pages': [{'id': 'p1', 'elements': [
               {'id': 'i', 'type': 'image', 'transform': {'x': 20, 'y': 20},
                'props': {'file_id': fid, 'mode': 'edge', 'width_mm': 60}}]}]}
    r = client.post('/api/v1/projects', json={'name': 'img', 'doc': doc}, headers=H)
    assert r.status_code in (200, 201), r.text
    pid = r.json()['id']
    r = client.post('/api/v1/projects/%s/render?wait=30' % pid, json={}, headers=H)
    assert r.status_code == 200, r.text
    st = r.json()['pages'][0]['stats']
    assert st['strokes'] >= 5 and st['draw_mm'] > 100
    # move the element: still no re-trace
    doc['pages'][0]['elements'][0]['transform']['x'] = 50
    r = client.post('/api/v1/projects/%s/render?wait=30' % pid, json={'doc': doc}, headers=H)
    assert r.status_code == 200, r.text


def test_import_reports_displayed_size_for_rotated_photo(client):
    im = Image.new('L', (300, 100), 255)
    ex = Image.Exif()
    ex[0x0112] = 6                       # phone held upright: rotate 90 on display
    b = io.BytesIO()
    im.save(b, 'JPEG', exif=ex)
    r = client.post('/api/v1/import/image', files={'file': ('p.jpg', b.getvalue(), 'image/jpeg')}, headers=H)
    assert r.status_code == 201, r.text
    assert (r.json()['px_w'], r.json()['px_h']) == (100, 300)
