"""Compatibility: original-software config import, Marlin profile through the service, units, placement."""
import io
import json
import os
import zipfile

from fastapi.testclient import TestClient

from conftest import H, PW, REPO, gcode_file, job_wait, make_app


def test_import_original_settings_files(client):
    files = [('files', ('settings.json', json.dumps({'feedRate': 1800, 'jogSpeed': 3000, 'extraKey': 1}))),
             ('files', ('Marlin.json', json.dumps({'type': 'Stepper', 'penDownMM': 3.0, 'penUpMM': 0.0}))),
             ('files', ('AxesData.json', json.dumps({'revxy': False, 'pos': 1})))]
    r = client.post('/api/v1/profiles/import', files=files, data={'name': '原软件'}, headers=H)
    assert r.status_code == 201, r.text
    d = r.json()['doc']
    assert d['type'] == 'Marlin' and d['settings']['feedRate'] == 1800 and d['settings']['extraKey'] == 1
    assert d['marlin']['penDownMM'] == 3.0 and d['axes']['pos'] == 1
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr('cfg/EBB.json', json.dumps({'mmToSteps': 80}))
    r = client.post('/api/v1/profiles/import', files=[('files', ('x.zip', buf.getvalue()))], headers=H)
    assert r.json()['doc']['type'] == 'Ebb' and r.json()['doc']['ebb']['mmToSteps'] == 80
    r = client.post('/api/v1/profiles/import', files=[('files', ('weird.json', '{"a":1}'))], headers=H)
    assert r.status_code == 400
    # penplot export roundtrip
    exp = client.get('/api/v1/profiles/default/export').content
    r = client.post('/api/v1/profiles/import', files=[('files', ('grbl-zpen.json', exp))], headers=H)
    assert r.status_code == 201 and r.json()['doc']['grbl']['zOn'] == 8.0


def test_marlin_profile_runs_jobs(tmp_path):
    app = make_app(tmp_path)
    with TestClient(app) as c:
        c.post('/api/v1/auth/setup', json={'password': PW}, headers=H)
        doc = json.load(open(os.path.join(REPO, 'configs', 'grbl-zpen.json')))
        doc['settings'].pop('zeroZAtStart', None)      # this test checks the XY-only start zero
        doc['type'] = 'Marlin'
        doc['marlin'] = {'type': 'Stepper', 'penDownMM': 2.0, 'penUpMM': 0.0, 'zSpeed': 3000}
        p = c.post('/api/v1/profiles', json={'name': 'Marlin', 'doc': doc}, headers=H).json()
        assert c.post('/api/v1/profiles/%s/activate' % p['id'], headers=H).status_code == 200
        st = c.post('/api/v1/machine/connect', json={'port': 'fake'}, headers=H).json()
        assert st['connected'] and st['machine_type'] == 'Marlin' and st['firmware'] == '2.1.2'
        assert c.post('/api/v1/machine/zero', json={'axes': 'xyz'}, headers=H).status_code == 200
        g = 'G21\nG90\nG1G90 Z0.0F3000\nG0 X1Y-1F2500\nG1G90 Z2.0F3000\nG1 X5Y-1F1500\nG1G90 Z0.0F3000\n'
        f = gcode_file(c, g)
        j = c.post('/api/v1/jobs', json={'source': {'file_id': f['file']['id']}, 'start': True}, headers=H).json()
        assert job_wait(c, j['id'])['status'] == 'done'
        fake = app.state.ctx.machine.fake
        assert 'G92X0.0Y0.0' in fake.received_lines and 'M400' in fake.received_lines
        assert c.post('/api/v1/machine/estop', headers=H).status_code == 200
        r = c.post('/api/v1/render/text', json={'text': 'Hi', 'font_id': 'penplot-sans'}, headers=H)
        assert 'M400' not in c.get('/api/v1/render/%s/pages/0/gcode' % r.json()['rid']).text


def test_units_svg_dxf_gcode(client, tmp_path):
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><path d="M0 0L40 20" stroke="#000"/></svg>'
    f = client.post('/api/v1/import/svg', files={'file': ('u.svg', svg)}, headers=H).json()
    assert abs(f['width_mm'] - 40 * 25.4 / 96) < 0.01                       # unit-less = 96 dpi px
    p = client.post('/api/v1/projects', json={'name': 'u', 'doc': {'pages': [{'id': 'p', 'elements': [
        {'id': 's', 'type': 'svg', 'props': {'file_id': f['file']['id'], 'units': 'mm'}}]}]}}, headers=H).json()
    res = client.post('/api/v1/projects/%s/render' % p['id'], json={'overrides': {'optimize': False}},
                      headers=H).json()
    bb = res['pages'][0]['bbox']
    assert abs((bb[2] - bb[0]) - 40) < 0.01                                  # units=mm: 1 unit = 1 mm
    import ezdxf
    d = ezdxf.new()
    d.units = 1      # inches
    d.modelspace().add_line((0, 0), (2, 0))
    path = str(tmp_path / 'i.dxf')
    d.saveas(path)
    r = client.post('/api/v1/import/dxf', files={'file': ('i.dxf', open(path, 'rb').read())}, headers=H).json()
    assert abs(r['width_mm'] - 50.8) < 0.01
    g = gcode_file(client, 'G20\nG90\nM3\nG1 X1 Y0 F10\nM5\n')
    assert abs(g['analysis']['draw_mm'] - 25.4) < 1e-6


def test_placement_preview_and_job_offset(client, app):
    p = client.post('/api/v1/projects', json={'name': 'pl', 'doc': {'pages': [{'id': 'p', 'elements': [
        {'id': 's', 'type': 'shape', 'transform': {'x': 10, 'y': 10}, 'props': {'kind': 'rect', 'w': 20, 'h': 20}}
    ]}]}}, headers=H).json()
    res = client.post('/api/v1/projects/%s/render' % p['id'], json={}, headers=H).json()
    rid = res['rid']
    pl = client.get('/api/v1/render/%s/pages/0/placement' % rid).json()
    assert pl['bbox'] == [10.0, -30.0, 30.0, -10.0] and pl['work_area'] == [0.0, -300.0, 300.0, 0.0]  # tests/web/fixtures/test-profile.json
    assert pl['paper'][2] == [209.0, -296.0] and pl['fits_paper'] and not pl['out_of_work_area']
    pl2 = client.get('/api/v1/render/%s/pages/0/placement?dx_mm=5&dy_mm=7' % rid).json()
    assert pl2['bbox'] == [15.0, -37.0, 35.0, -17.0]
    pl3 = client.get('/api/v1/render/%s/pages/0/placement?dx_mm=-50' % rid).json()
    assert pl3['out_of_work_area']
    assert client.get('/api/v1/render/%s/pages/0/placement.svg' % rid).text.startswith('<svg')
    # apply as a job override: rendered job is shifted
    j = client.post('/api/v1/jobs', json={'source': {'render_id': rid, 'page': 0},
                                          'overrides': {'placement': {'dx_mm': 5, 'dy_mm': 7}}}, headers=H).json()
    assert j['bbox'][2] >= 35.0 - 1e-6
    # library G-code is shifted line by line
    f = gcode_file(client, 'G21\nG90\nG1G90 Z0.0F5000\nG0 X1Y-1F2500\nG1G90 Z8.0F5000\nG1 X5Y-1\nG1G90 Z0.0F5000\n')
    j2 = client.post('/api/v1/jobs', json={'source': {'file_id': f['file']['id']},
                                           'overrides': {'placement': {'dx_mm': 10, 'dy_mm': 10}}}, headers=H).json()
    body = client.get('/api/v1/jobs/%s/gcode' % j2['id']).text
    assert 'G0 X11.000Y-11.000' in body.replace(' ', ' ')
