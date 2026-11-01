import time

from fastapi.testclient import TestClient

from conftest import H, PW, gcode_file, job_wait, make_app, square_gcode, wait_for


def _job(c, text=None, start=True, **kw):
    f = gcode_file(c, text or square_gcode())
    r = c.post('/api/v1/jobs', json=dict({'source': {'file_id': f['file']['id']}, 'start': start}, **kw), headers=H)
    assert r.status_code == 201, r.text
    return r.json()


def test_import_analysis(client):
    f = gcode_file(client, square_gcode(10))
    a = f['analysis']
    assert a['lines'] == 4 + 10 * 5 + 2
    assert a['pen_lifts'] == 10
    assert a['bbox'] == [0.0, -1.5, 19.5, 0.0]
    assert a['est_s'] > 0 and a['draw_mm'] > 0
    f2 = gcode_file(client, 'G20\nG91\nG1 X1\nM7\n', 'odd.gcode')
    w = ' '.join(f2['analysis']['warnings'])
    assert 'G20' in w and 'G91' in w


def test_job_runs_to_done_and_events(client, app):
    events = []
    app.state.ctx.bus.listeners.append(lambda m: events.append(m) if m['type'] == 'job' else None)
    j = _job(client)
    assert j['status'] in ('running', 'preparing')
    # manual commands are rejected while streaming
    r = client.post('/api/v1/machine/jog', json={'dx': 1}, headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'machine_busy'
    r = client.post('/api/v1/jobs', json={'source': {'file_id': j['source']['file_id']}, 'start': True}, headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'job_active'
    done = job_wait(client, j['id'])
    assert done['status'] == 'done', done
    assert done['acked_line'] == done['total_lines'] and done['percent'] == 100.0
    st = client.get('/api/v1/machine/status').json()
    assert st['origin_valid'] and st['grbl_state'] == 'Idle' and st['pen'] == 'up'
    assert st['wpos'] == [0.0, 0.0, 0.0]
    seen = [(e['data']['from'], e['data']['to']) for e in events if e['data']['job_id'] == j['id']]
    assert ('preparing', 'running') in seen and ('running', 'done') in seen
    fake = app.state.ctx.machine.fake
    assert fake.overflows == 0
    # job start zeroes XY only (P6); Z was calibrated explicitly by the fixture
    assert 'G10 P0 L20 X0.0Y0.0' in fake.received_lines
    assert fake.received_lines.count('G10 P0 L20 X0.0Y0.0Z0') == 1
    assert client.get('/api/v1/jobs/current').status_code == 204
    # retry from line 20 -> new queued job with a preamble
    r = client.post('/api/v1/jobs/%s/retry' % j['id'], json={'from_line': 20}, headers=H)
    assert r.status_code == 201
    nj = r.json()
    assert nj['status'] == 'queued' and nj['source']['retry_of'] == j['id']
    lines = client.get('/api/v1/jobs/%s/gcode' % nj['id']).text.split('\r\n')
    assert lines[0] == 'G1G90 Z0.0F5000' and lines[2] == 'G90'


def test_pause_soft_resume(client, app):
    j = _job(client, square_gcode(80))
    wait_for(lambda: client.get('/api/v1/jobs/' + j['id']).json()['acked_line'] > 30)
    r = client.post('/api/v1/jobs/%s/pause' % j['id'], json={'mode': 'soft'}, headers=H)
    assert r.json()['status'] == 'paused' and r.json()['pause_mode'] == 'soft'
    # idempotent
    assert client.post('/api/v1/jobs/%s/pause' % j['id'], headers=H).json()['status'] == 'paused'
    # after the buffer drains the machine is idle with the pen up: jogging is allowed
    wait_for(lambda: client.get('/api/v1/machine/status').json()['busy'] is False, 10)
    assert client.get('/api/v1/machine/status').json()['pen'] == 'up'
    before = list(app.state.ctx.machine.fake.wpos)
    r = client.post('/api/v1/machine/jog', json={'dx': 5, 'dy': 0, 'seq': 1}, headers=H)
    assert r.status_code == 200, r.text
    wait_for(lambda: app.state.ctx.machine.fake.state == 'Idle' and
             abs(app.state.ctx.machine.fake.wpos[0] - before[0] - 5) < 1e-6)
    r = client.post('/api/v1/jobs/%s/resume' % j['id'], headers=H)
    assert r.json()['status'] == 'running'
    done = job_wait(client, j['id'], timeout=30)
    assert done['status'] == 'done'
    rl = app.state.ctx.machine.fake.received_lines
    # returned to the pause point before continuing
    import re
    back = [x for x in rl if re.match(r'^G0 X[-0-9.]+Y[-0-9.]+$', x)]
    assert back, rl[-50:]
    bx, by = [float(v) for v in re.findall(r'[XY]([-0-9.]+)', back[0])]
    assert abs(bx - before[0]) < 1e-3 and abs(by - before[1]) < 1e-3


def test_pause_hold_resume_and_stop_from_hold(client, app):
    j = _job(client, square_gcode(80))
    wait_for(lambda: client.get('/api/v1/jobs/' + j['id']).json()['acked_line'] > 20)
    r = client.post('/api/v1/jobs/%s/pause' % j['id'], json={'mode': 'hold'}, headers=H)
    assert r.json()['pause_mode'] == 'hold'
    wait_for(lambda: app.state.ctx.machine.fake.state == 'Hold:0')
    wait_for(lambda: client.get('/api/v1/machine/status').json()['busy'] is True)
    client.post('/api/v1/jobs/%s/resume' % j['id'], headers=H)
    wait_for(lambda: app.state.ctx.machine.fake.state in ('Run', 'Idle'))
    client.post('/api/v1/jobs/%s/pause' % j['id'], json={'mode': 'hold'}, headers=H)
    wait_for(lambda: app.state.ctx.machine.fake.state == 'Hold:0')
    r = client.post('/api/v1/jobs/%s/stop' % j['id'], headers=H)
    done = job_wait(client, j['id'])
    assert done['status'] == 'aborted' and done['reason'] == 'user_stop'
    st = client.get('/api/v1/machine/status').json()
    assert st['origin_valid'] and st['wpos'][:2] == [0.0, 0.0] and st['pen'] == 'up'


def test_soft_stop(client, app):
    j = _job(client, square_gcode(80))
    wait_for(lambda: client.get('/api/v1/jobs/' + j['id']).json()['acked_line'] > 20)
    assert client.post('/api/v1/jobs/%s/stop' % j['id'], headers=H).json()['status'] == 'stopping'
    done = job_wait(client, j['id'])
    assert done['status'] == 'aborted' and done['reason'] == 'user_stop'
    assert done['can_retry_from'] >= 1
    assert app.state.ctx.machine.fake.received_lines[-2:] == ['G1G90 Z0.0F5000', 'G90G0 X0Y0']


def test_estop_keeps_origin_when_hold_completes(client, app):
    j = _job(client, square_gcode(80))
    wait_for(lambda: client.get('/api/v1/jobs/' + j['id']).json()['acked_line'] > 20)
    t0 = time.time()
    r = client.post('/api/v1/machine/estop', headers=H)
    assert r.status_code == 200
    assert time.time() - t0 < 4.5
    j2 = client.get('/api/v1/jobs/' + j['id']).json()
    assert j2['status'] == 'aborted' and j2['reason'] == 'estop'
    st = r.json()
    assert st['origin_valid'] is True and st['grbl_state'].startswith('Idle')
    assert app.state.ctx.machine.fake.received_lines[-1] == 'G1G90 Z0.0F5000'   # pen lifted


def test_reset_in_motion_alarm3_invalidates_origin(client, app):
    fake = app.state.ctx.machine.fake
    j = _job(client, square_gcode(80))
    wait_for(lambda: client.get('/api/v1/jobs/' + j['id']).json()['acked_line'] > 10)
    # the decel never completes in time -> reset in motion -> ALARM:3
    fake.time_scale = 50.0
    r = client.post('/api/v1/jobs/%s/estop' % j['id'], headers=H)
    assert r.json()['status'] == 'aborted'
    st = client.get('/api/v1/machine/status').json()
    assert st['origin_valid'] is False and st['pen'] == 'unknown'
    assert st['last_alarm']['code'] == 3
    fake.time_scale = 0.02
    # not allowed to start without zero unless the job zeroes itself
    j2 = _job(client, square_gcode(5), start=False)
    r = client.post('/api/v1/jobs/%s/start' % j2['id'], json={'set_zero': False}, headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'origin_invalid'
    r = client.post('/api/v1/jobs/%s/start' % j2['id'], json={'set_zero': True}, headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'pen_unknown'     # P6
    assert not any(x.endswith('Z0') for x in fake.received_lines[-3:])
    client.post('/api/v1/machine/zero', json={'axes': 'xyz'}, headers=H)
    r = client.post('/api/v1/jobs/%s/start' % j2['id'], json={'set_zero': True}, headers=H)
    assert r.status_code == 200
    assert job_wait(client, j2['id'])['status'] == 'done'


def test_gcode_error_fails_job(client, app):
    app.state.ctx.machine.fake.fail_lines['X7.500Y-2.000'] = 'error:20'
    j = _job(client, square_gcode(40))
    done = job_wait(client, j['id'])
    assert done['status'] == 'failed' and done['reason'] == 'gcode_error'
    assert done['errors'][0]['reply'] == 'error:20' and done['errors'][0]['line'] > 0


def test_alarm_fails_job_and_unlock(client, app):
    j = _job(client, square_gcode(80))
    wait_for(lambda: client.get('/api/v1/jobs/' + j['id']).json()['acked_line'] > 10)
    app.state.ctx.machine.fake.trigger_alarm(1)
    done = job_wait(client, j['id'])
    assert done['status'] == 'failed' and done['reason'] == 'alarm:1'
    st = client.get('/api/v1/machine/status').json()
    assert st['last_alarm']['code'] == 1 and st['grbl_state'] == 'Alarm'
    r = client.post('/api/v1/machine/unlock', headers=H)
    assert r.status_code == 200 and r.json()['last_alarm'] is None


def test_unplug_fails_job_and_reconnects(client, app):
    j = _job(client, square_gcode(80))
    wait_for(lambda: client.get('/api/v1/jobs/' + j['id']).json()['acked_line'] > 10)
    app.state.ctx.machine.fake.unplug()
    done = job_wait(client, j['id'])
    assert done['status'] == 'failed' and done['reason'] == 'serial_lost'
    # the supervisor reconnects the (fake) port
    st = wait_for(lambda: (lambda s: s if s['connected'] else None)(client.get('/api/v1/machine/status').json()), 15)
    assert st['origin_valid'] is False


def test_manual_controls(client, app):
    r = client.post('/api/v1/machine/zero', json={'axes': 'xyz'}, headers=H)
    assert r.json()['origin_valid'] and r.json()['pen'] == 'up'
    assert client.post('/api/v1/machine/pen', json={'state': 'down'}, headers=H).status_code == 200
    wait_for(lambda: client.get('/api/v1/machine/status').json()['pen'] == 'down')
    r = client.post('/api/v1/machine/jog', json={'dx': 3, 'dy': -2, 'seq': 5}, headers={**H, 'Idempotency-Key': 'k1'})
    assert r.status_code == 200
    # same key: deduped; older seq: ignored
    client.post('/api/v1/machine/jog', json={'dx': 3, 'dy': -2, 'seq': 5}, headers={**H, 'Idempotency-Key': 'k1'})
    client.post('/api/v1/machine/jog', json={'dx': 3, 'dy': -2, 'seq': 4}, headers=H)
    wait_for(lambda: app.state.ctx.machine.fake.state == 'Idle')
    wait_for(lambda: client.get('/api/v1/machine/status').json()['wpos'][:2] == [3.0, -2.0])
    assert client.post('/api/v1/machine/jog', json={'dx': 80}, headers=H).status_code == 422
    r = client.post('/api/v1/machine/goto-origin', headers=H)
    assert r.status_code == 200
    rl = app.state.ctx.machine.fake.received_lines
    assert rl[-2:] == ['G1G90 Z0.0F5000', 'G90G0 X0Y0']      # pen up before going home (B12)
    r = client.post('/api/v1/machine/command', json={'line': '$I'}, headers=H)
    assert r.json()['ok'] and any('VER' in x for x in r.json()['reply_lines'])
    s = client.get('/api/v1/machine/grbl-settings').json()
    assert any(x['n'] == 110 and x['desc'] for x in s)
    r = client.put('/api/v1/machine/grbl-settings', json={'110': 4000}, headers=H)
    assert any(x['n'] == 110 and float(x['value']) == 4000 for x in r.json())
    assert client.post('/api/v1/machine/homing', headers=H).status_code == 409   # $22=0
    assert client.post('/api/v1/machine/realtime', json={'byte': '0x91'}, headers=H).status_code == 200
    assert client.post('/api/v1/machine/realtime', json={'byte': '0x42'}, headers=H).status_code == 400
    r = client.post('/api/v1/machine/frame', json={'bbox_mm': [0, -10, 10, 0]}, headers=H)
    assert r.status_code == 200, r.text
    log = client.get('/api/v1/machine/status')
    assert log.status_code == 200


def test_queue_frame_patch_delete_batch(client, app):
    f = gcode_file(client, square_gcode(5))
    r = client.post('/api/v1/jobs', json={'source': {'file_id': f['file']['id']}, 'name': 'a',
                                          'overrides': {'copies': 2}}, headers=H)
    j = r.json()
    assert j['batch_id'] and j['status'] == 'queued' and j['eta_s'] > 0
    b = client.get('/api/v1/batches/' + j['batch_id']).json()
    assert len(b['jobs']) == 2 and b['next_job_id'] == j['id']
    r = client.post('/api/v1/jobs/%s/frame' % j['id'], json={'z': 'up'}, headers=H)
    assert r.status_code == 200, r.text
    assert client.patch('/api/v1/jobs/' + j['id'], json={'name': 'renamed'}, headers=H).json()['name'] == 'renamed'
    r = client.post('/api/v1/batches/%s/start-next' % j['batch_id'], headers=H)
    assert r.json()['id'] == j['id']
    assert job_wait(client, j['id'])['status'] == 'done'
    assert client.get('/api/v1/batches/' + j['batch_id']).json()['next_job_id'] != j['id']
    assert client.delete('/api/v1/files/' + f['file']['id'], headers=H).status_code == 409   # queued job uses it
    client.delete('/api/v1/batches/' + j['batch_id'], headers=H)
    assert client.get('/api/v1/jobs?batch_id=' + j['batch_id']).json() == []
    assert client.delete('/api/v1/files/' + f['file']['id'], headers=H).status_code == 204


def test_crash_recovery_marks_failed(tmp_path):
    app = make_app(tmp_path)
    with TestClient(app) as c:
        c.post('/api/v1/auth/setup', json={'password': PW}, headers=H)
        f = gcode_file(c, square_gcode(3))
        j = c.post('/api/v1/jobs', json={'source': {'file_id': f['file']['id']}}, headers=H).json()
        app.state.ctx.db.execute("UPDATE jobs SET status='running', acked_line=7 WHERE id=?", (j['id'],))
    app2 = make_app(tmp_path)
    with TestClient(app2) as c:
        c.post('/api/v1/auth/login', json={'password': PW}, headers=H)
        j2 = c.get('/api/v1/jobs/' + j['id']).json()
        assert j2['status'] == 'failed' and j2['reason'] == 'process_crash' and j2['can_retry_from'] == 1


def test_start_zeroes_z_when_pen_confirmed_up(client, app):
    """Fresh connection: Z reference unknown. Without confirmation the start is
    refused (P6); with pen_up_confirmed the start-time zero includes Z."""
    m = app.state.ctx.machine
    m.z_valid = False                       # as after a reconnect / MCU reset
    f = gcode_file(client, square_gcode())
    j = client.post('/api/v1/jobs', json={'source': {'file_id': f['file']['id']}}, headers=H).json()
    r = client.post('/api/v1/jobs/%s/start' % j['id'], json={}, headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'pen_unknown'
    r = client.post('/api/v1/jobs/%s/start' % j['id'], json={'pen_up_confirmed': True}, headers=H)
    assert r.status_code == 200, r.text
    assert job_wait(client, j['id'], timeout=60)['status'] == 'done'
    assert m.z_valid


def test_clear_hold_without_job(client, app):
    """A feed hold nobody owns (machine pause button / kept over a reconnect)
    can be cleared; the recovery report offers it."""
    m = app.state.ctx.machine
    client.post('/api/v1/machine/zero', json={'axes': 'xyz'}, headers=H)
    m.ctrl.state = 'Hold:0'
    m.fake.state = 'Hold:0'
    rec = client.get('/api/v1/machine/recovery', headers=H).json()
    assert 'hold' in rec['reasons'] and any(s['id'] == 'hold' for s in rec['steps'])
    r = client.post('/api/v1/machine/clear-hold', headers=H)
    assert r.status_code == 200, r.text
    wait_for(lambda: not (m.ctrl.state or '').startswith('Hold'))
    assert r.json()['origin_valid']


def test_print_reuses_preview_render_and_cached_analysis(client, app):
    import os
    doc = {'pages': [{'id': 'p', 'elements': [
        {'id': 's', 'type': 'shape', 'transform': {'x': 10, 'y': 10}, 'props': {'kind': 'rect', 'w': 20, 'h': 20}}]}]}
    p = client.post('/api/v1/projects', json={'name': 'reuse', 'doc': doc}, headers=H).json()
    rid = client.post('/api/v1/projects/%s/render?wait=30' % p['id'], json={}, headers=H).json()['rid']
    prof = app.state.ctx.profiles.active()['doc']
    same = {'feed_rate': prof['settings']['feedRate'], 'pen_down_z': prof['grbl']['zOn'],
            'pen_up_z': prof['grbl']['zOff'], 'copies': 1}
    j = client.post('/api/v1/jobs', json={'source': {'render_id': rid, 'page': 0}, 'overrides': same},
                    headers=H).json()
    assert j['source']['render_id'] == rid                     # no re-render for identical values
    jobs_dir = app.state.ctx.cfg.jobs_dir
    assert os.path.exists(os.path.join(jobs_dir, j['id'] + '.gcode.an.pkl'))
    j2 = client.post('/api/v1/jobs', json={'source': {'render_id': rid, 'page': 0},
                                           'overrides': {'feed_rate': prof['settings']['feedRate'] + 300}},
                     headers=H).json()
    assert j2['source']['render_id'] != rid                    # a real change re-renders
    # start uses the cached analysis (no re-analysis needed) and runs to the end
    client.post('/api/v1/machine/zero', json={'axes': 'xyz'}, headers=H)
    r = client.post('/api/v1/jobs/%s/start' % j['id'], json={}, headers=H)
    assert r.status_code == 200, r.text
    assert job_wait(client, j['id'], timeout=60)['status'] == 'done'
