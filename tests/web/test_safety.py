"""Regression tests for docs/design/06-review-risk.md (P1-P18) and §8 fault scenarios."""
import io
import time
import zipfile

import pytest
from fastapi.testclient import TestClient

from conftest import H, gcode_file, job_wait, square_gcode, wait_for

from penplot.machine.base import Sender, UnsafeGcode, sanitize_line
from penplot.settings import MachineConfig


def _job(c, text, start=True, **kw):
    f = gcode_file(c, text)
    return c.post('/api/v1/jobs', json=dict({'source': {'file_id': f['file']['id']}, 'start': start}, **kw),
                  headers=H)


# ---------------------------------------------------------------- P1
def test_sanitizer_unit():
    assert sanitize_line('G1 X1 (done!) ; 的 ~') == 'G1 X1'
    assert sanitize_line('(only a comment!)') == ''
    for bad in ('G1 X1 !', 'G1 X的', 'G1 X1\x18', '?'):
        with pytest.raises(UnsafeGcode):
            sanitize_line(bad)
    with pytest.raises(UnsafeGcode):
        sanitize_line('$130=1', allow_dollar=False)

    class C:
        machine = MachineConfig()
        RX_CAPACITY = 100
        ERROR_IS_RESPONSE = True

        def add_event_listener(self, fn):
            pass
    s = Sender(C())
    with pytest.raises(UnsafeGcode):
        s.load_commands(['G1 X1', 'G1 X2 !'])


def test_comments_with_realtime_bytes_never_reach_grbl(client, app):
    text = ('G21 (start: 的 done!)\nG90 ; ~resume?\nG1G90 Z0.0F5000\nG0 X1Y-1F2500\nG1G90 Z8.0F5000\n'
            'G1 X5Y-1F1500\nG1G90 Z0.0F5000\nG90G0 X0Y0\n')
    r = _job(client, text)
    assert r.status_code == 201, r.text
    assert job_wait(client, r.json()['id'])['status'] == 'done'
    fake = app.state.ctx.machine.fake
    assert not [b for b in fake.rt_log if b != 0x3F]       # no ! ~ 0x84 ... from the stream
    assert all('(' not in x and ';' not in x for x in fake.received_lines)
    stored = client.get('/api/v1/jobs/%s/gcode' % r.json()['id']).text
    assert '的' not in stored and 'done' not in stored


def test_unsafe_gcode_rejected_at_job_creation(client):
    for text, why in (('G1 X1 !\n', '实时'), ('G1 X的\n', 'ASCII'), ('$130=1\nG1 X1\n', '$')):
        r = _job(client, text, start=False)
        assert r.status_code == 400 and r.json()['error']['code'] == 'unsafe_gcode', r.text
        assert why in r.json()['error']['message']
    r = client.post('/api/v1/jobs', json={'source': {'file_id': 'x'}, 'overrides': {'start_gcode': 'G4 P1 !'}},
                    headers=H)
    assert r.status_code == 422


# ---------------------------------------------------------------- P3 / P4 / P16
LIB = '\n'.join(['G21', 'G90'] + sum([['G0 X%d Y0' % i, 'G1 Z8 F5000', 'G1 X%d.5 Y-1 F1500' % i,
                                       'G1 Z0 F5000'] for i in range(60)], []) + ['G0 X0 Y0']) + '\n'


def test_soft_pause_lifts_pen_for_library_gcode(client, app):
    fake = app.state.ctx.machine.fake
    j = _job(client, LIB).json()
    wait_for(lambda: client.get('/api/v1/jobs/' + j['id']).json()['acked_line'] > 30)
    client.post('/api/v1/jobs/%s/pause' % j['id'], json={'mode': 'soft'}, headers=H)
    wait_for(lambda: fake.state == 'Idle' and not fake.planner and fake.cur is None, 10)
    time.sleep(0.2)
    assert fake.wpos[2] == 0.0                                 # P3: pen up while paused
    # P4: a failing manual command while paused does not fail the job or home
    pos = list(fake.wpos)
    r = client.post('/api/v1/machine/command', json={'line': 'G5 X1'}, headers=H)
    assert r.status_code == 200 and r.json()['ok'] is False
    time.sleep(0.3)
    jj = client.get('/api/v1/jobs/' + j['id']).json()
    assert jj['status'] == 'paused' and fake.wpos == pos
    client.post('/api/v1/jobs/%s/resume' % j['id'], headers=H)
    assert job_wait(client, j['id'], timeout=30)['status'] == 'done'


def test_profile_patch_mid_job_is_deferred(client, app):
    m = app.state.ctx.machine
    j = _job(client, square_gcode(60)).json()
    wait_for(lambda: client.get('/api/v1/jobs/' + j['id']).json()['acked_line'] > 5)
    r = client.patch('/api/v1/profiles/default', json={'doc': {'grbl': {'zOn': 6.0}}}, headers=H)
    assert r.status_code == 200
    assert m.mc.grbl.zOn == 8.0                                # P16: unchanged during the job
    job_wait(client, j['id'], timeout=30)
    assert m.mc.grbl.zOn == 6.0


# ---------------------------------------------------------------- P5
def test_retry_does_not_rezero_and_checks_epoch(client, app):
    fake = app.state.ctx.machine.fake
    j = _job(client, square_gcode(60)).json()
    wait_for(lambda: client.get('/api/v1/jobs/' + j['id']).json()['acked_line'] > 40)
    client.post('/api/v1/jobs/%s/stop' % j['id'], headers=H)
    done = job_wait(client, j['id'])
    nj = client.post('/api/v1/jobs/%s/retry' % j['id'], json={'from_line': done['can_retry_from']},
                     headers=H).json()
    client.post('/api/v1/machine/jog', json={'dx': 30, 'dy': -30}, headers=H)
    wait_for(lambda: fake.state == 'Idle' and not fake.planner)
    n0 = len(fake.received_lines)
    r = client.post('/api/v1/jobs/%s/start' % nj['id'], headers=H)
    assert r.status_code == 200, r.text
    job_wait(client, nj['id'], timeout=30)
    assert not any(x.startswith('G10') for x in fake.received_lines[n0:])     # no re-zero
    # origin changed since the source job -> refuse
    nj2 = client.post('/api/v1/jobs/%s/retry' % j['id'], json={'from_line': 10}, headers=H).json()
    client.post('/api/v1/machine/zero', json={'axes': 'xy'}, headers=H)
    r = client.post('/api/v1/jobs/%s/start' % nj2['id'], headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'origin_invalid'


# ---------------------------------------------------------------- P7 / P8
def test_ws_jog_validation_and_deadman(client, app):
    fake = app.state.ctx.machine.fake
    with client.websocket_connect('/api/v1/ws') as ws:
        ws.receive_json()
        for i, args in enumerate(({'dz': 45}, {'dx': 1, 'feed': 'x'}, {'dx': 80})):
            ws.send_json({'type': 'cmd', 'id': 'j%d' % i, 'op': 'jog', 'args': args})
            for _ in range(200):
                m = ws.receive_json()
                if m['type'] == 'ack' and m['id'] == 'j%d' % i:
                    assert m['ok'] is False and m['error']['code'] in ('validation_error', 'jog_too_far'), m
                    break
        ws.send_text('{"type":"cmd","id":"nan","op":"jog","args":{"dx":NaN}}')     # dropped
        ws.send_json({'type': 'cmd', 'id': 'ok', 'op': 'jog', 'args': {'dx': 40, 'feed': 600}})
        for _ in range(200):
            m = ws.receive_json()
            assert m.get('id') != 'nan'
            if m['type'] == 'ack' and m['id'] == 'ok':
                assert m['ok'], m
                break
    # deadman step cap: 600 mm/min * 0.3 s = 3 mm, and the WS close cancels the jog
    wait_for(lambda: 0x85 in fake.rt_log, 5)
    jl = [x for x in fake.received_lines if x.startswith('$J=')]
    assert jl and 'X3.0' in jl[-1].replace('X3Y', 'X3.0Y')


def test_jog_cancel_drops_queued_steps(client, app):
    m = app.state.ctx.machine
    fake = m.fake
    m.submit(time.sleep, 0.4)                    # cmd-thread busy
    futs = [client.portal.start_task_soon(m.jog, 5.0, 0.0) for _ in range(3)]
    time.sleep(0.05)
    m.jog_cancel()
    for f in futs:
        f.result(5)
    assert not [x for x in fake.received_lines if x.startswith('$J=')]


# ---------------------------------------------------------------- P13
def test_bounds_gate_includes_travel_z_and_machine_moves(client, app):
    for text in ('G21\nG90\nG0 X400 Y0\nG0 X0 Y0\n', 'G21\nG90\nG1 Z-30 F500\nG1 Z0 F500\n',
                 'G21\nG90\nG28\nG0 X1 Y-1\n'):
        r = _job(client, text)
        assert r.status_code == 409 and r.json()['error']['code'] == 'out_of_work_area', r.text
        assert r.json()['error']['detail']['issues']
    jid = client.get('/api/v1/jobs?status=queued').json()[0]['id']
    r = client.post('/api/v1/jobs/%s/start' % jid, json={'allow_out_of_bounds': True}, headers=H)
    assert r.status_code == 200                                   # admin override (audited)
    assert 'job_start_out_of_bounds' in [a['action'] for a in client.get('/api/v1/system/audit').json()]
    job_wait(client, jid)
    r = client.post('/api/v1/machine/frame', json={'bbox_mm': [0, -10, 500, 0]}, headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'out_of_work_area'


# ---------------------------------------------------------------- P18
def test_raw_command_and_settings_injection(client):
    for line in ('G1 X1 !', 'G0 X1\nG0 Y1', '$N0=G1Z8', '$RST=*', '$130=1'):
        r = client.post('/api/v1/machine/command', json={'line': line}, headers=H)
        assert r.status_code in (400, 422) and r.json()['error']['code'] in ('bad_command', 'validation_error'), line
    r = client.put('/api/v1/machine/grbl-settings', json={'110': '3000\n$N0=G1Z8F100'}, headers=H)
    assert r.status_code == 400 and r.json()['error']['code'] == 'bad_setting'
    r = client.put('/api/v1/machine/grbl-settings', json={'999': 1}, headers=H)
    assert r.status_code == 400
    r = client.patch('/api/v1/profiles/default', json={'doc': {'advanced': {'macro1': 'G1 X1 ; ok\n$H !'}}},
                     headers=H)
    assert r.status_code == 400 and r.json()['error']['code'] == 'unsafe_gcode'


# ---------------------------------------------------------------- P2 / P15 roles
def test_viewer_cannot_control_and_disabled_user_loses_ws(client, app):
    r = client.post('/api/v1/users', json={'username': 'vic', 'password': 'viewer-pass-1', 'role': 'viewer'},
                    headers=H)
    vid = r.json()['id']
    client.post('/api/v1/users', json={'username': 'ops', 'password': 'operator-pass', 'role': 'operator'},
                headers=H)
    if True:
        v = TestClient(app)
        assert v.post('/api/v1/auth/login', json={'username': 'vic', 'password': 'viewer-pass-1'},
                      headers=H).status_code == 200
        assert v.post('/api/v1/machine/jog', json={'dx': 1}, headers=H).status_code == 403
        assert v.post('/api/v1/machine/lease', headers=H).status_code == 403
        assert (v.get('/api/v1/machine/lease').json()['holder'] or {}).get('username') != 'vic'
        assert v.post('/api/v1/machine/estop', headers=H).status_code == 200       # everyone can e-stop
    if True:
        o = TestClient(app)
        o.post('/api/v1/auth/login', json={'username': 'ops', 'password': 'operator-pass'}, headers=H)
        with o.websocket_connect('/api/v1/ws') as ws:
            ws.receive_json()
            # admin disables the operator while the socket is open
            client.patch('/api/v1/users/' + next(u['id'] for u in client.get('/api/v1/users').json()
                                                  if u['username'] == 'ops'), json={'disabled': True}, headers=H)
            ws.send_json({'type': 'cmd', 'id': 'p', 'op': 'pen', 'args': {'state': 'up'}})
            for _ in range(100):
                m = ws.receive_json()
                if m['type'] == 'ack' and m['id'] == 'p':
                    assert m['ok'] is False and m['error']['code'] == 'unauthenticated'
                    break
    assert vid


# ---------------------------------------------------------------- P9 / P10 / P11
def test_upload_guards(tmp_path, client, app):
    if True:
        anon = TestClient(app)
        r = anon.post('/api/v1/import/gcode', files={'file': ('a.gcode', b'G0 X1\n' * 1000)}, headers=H)
        assert r.status_code == 401
    r = client.post('/api/v1/papers', content=b'{"name":"' + b'x' * (2 * 1024 * 1024) + b'"}',
                    headers={**H, 'Content-Type': 'application/json'})
    assert r.status_code == 413 and r.json()['error']['code'] == 'too_large'
    # zip bomb
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('project.json', '{"doc": {}}')
        z.writestr('files/f1.bin', b'\0' * (50 * 1024 * 1024))
    r = client.post('/api/v1/projects/import', files={'file': ('p.zip', buf.getvalue())}, headers=H)
    assert r.status_code == 413 and r.json()['error']['code'] == 'zip_bomb', r.text
    # 81 MP PNG refused before decoding
    from PIL import Image
    b = io.BytesIO()
    Image.new('1', (9000, 9000), 1).save(b, 'PNG')
    r = client.post('/api/v1/import/image', files={'file': ('big.png', b.getvalue())}, headers=H)
    assert r.status_code == 413, r.text
    # SVG with script: never served as active content
    svg = (b'<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10">'
           b'<script>alert(1)</script><path d="M0 0L10 10" stroke="black"/></svg>')
    f = client.post('/api/v1/import/svg', files={'file': ('x.svg', svg)}, headers=H).json()['file']
    r = client.get('/api/v1/files/%s/content' % f['id'])
    assert 'sandbox' in r.headers['content-security-policy'] and r.headers['x-content-type-options'] == 'nosniff'
    assert r.headers['content-disposition'].startswith('attachment')
    pv = client.get('/api/v1/files/%s/preview.svg' % f['id'])
    assert '<script' not in pv.text and 'sandbox' in pv.headers['content-security-policy']
    bad = b'<!Doctype svg><svg xmlns="http://www.w3.org/2000/svg"/>'
    assert client.post('/api/v1/import/svg', files={'file': ('b.svg', bad)}, headers=H).status_code == 400


# ---------------------------------------------------------------- §8 faults
def test_fake_faults_garbage_and_slow_acks_complete(client, app):
    fake = app.state.ctx.machine.fake
    fake.inject('garbage', 0.05)
    fake.inject('slow_acks', 0.002)
    j = _job(client, square_gcode(30)).json()
    assert job_wait(client, j['id'], timeout=60)['status'] == 'done'


def test_spontaneous_reset_invalidates_origin_and_recovery_steps(client, app):
    fake = app.state.ctx.machine.fake
    j = _job(client, square_gcode(80)).json()
    wait_for(lambda: client.get('/api/v1/jobs/' + j['id']).json()['acked_line'] > 10)
    r = client.post('/api/v1/machine/fake/fault', json={'kind': 'reset_in_motion'}, headers=H)
    assert r.status_code == 200
    done = job_wait(client, j['id'])
    assert done['status'] == 'failed' and done['reason'].startswith('alarm')
    rec = client.get('/api/v1/machine/recovery').json()
    assert not rec['ok'] and 'origin_invalid' in rec['reasons']
    ids = [s['id'] for s in rec['steps']]
    assert 'unlock' in ids and 'zero' in ids
    assert fake.state == 'Alarm'


def test_estop_during_teletype_and_double_estop(client, app):
    client.post('/api/v1/teletype/session', json={}, headers=H)
    client.post('/api/v1/teletype/type', json={'text': 'HELLO WORLD ' * 3}, headers=H)
    t0 = time.time()
    with client.websocket_connect('/api/v1/ws') as ws:
        ws.receive_json()
        ws.send_json({'type': 'cmd', 'id': 'a', 'op': 'estop'})
        r = client.post('/api/v1/machine/estop', headers=H)
        assert r.status_code == 200
    assert time.time() - t0 < 6
    st = client.get('/api/v1/teletype/state').json()
    assert st['active'] and st['pending'] == 0
    assert 0x21 in app.state.ctx.machine.fake.rt_log
    client.delete('/api/v1/teletype/session', headers=H)


def test_diagnostics(client):
    r = client.post('/api/v1/system/diagnostics', json={'pen_test': True, 'confirm': True}, headers=H)
    assert r.status_code == 200, r.text
    d = r.json()
    ids = {c['id']: c for c in d['checks']}
    assert ids['serial_present']['status'] == 'ok' and ids['status_latency']['status'] in ('ok', 'warn')
    assert ids['pen']['status'] == 'ok', ids['pen']
    assert ids['grbl_13']['status'] == 'ok'


def test_list_limits_are_bounded(client):
    # a negative LIMIT is "no limit" in SQLite; the API must reject it
    for url in ('/api/v1/jobs?limit=-1', '/api/v1/files?limit=0', '/api/v1/projects?limit=-5',
                '/api/v1/system/audit?limit=-1', '/api/v1/jobs?limit=100000'):
        assert client.get(url).status_code == 422, url
    assert client.get('/api/v1/jobs?limit=5').status_code == 200
