"""Multi-user: roles, lease, presence, project broadcast, soft locks, attention events."""
import time

from fastapi.testclient import TestClient

from conftest import H, gcode_file, job_wait, square_gcode, wait_for


def _recv(ws, pred, n=300):
    for _ in range(n):
        m = ws.receive_json()
        if pred(m):
            return m
    raise AssertionError('not seen')


def _user(c, app, name, role):
    c.post('/api/v1/users', json={'username': name, 'password': name + '-password', 'role': role}, headers=H)
    u = TestClient(app)
    assert u.post('/api/v1/auth/login', json={'username': name, 'password': name + '-password'},
                  headers=H).status_code == 200
    return u


def test_users_roles_and_admin_ops(client, app):
    st = client.get('/api/v1/auth/state').json()
    assert st['user'] == 'admin' and st['role'] == 'admin'
    op = _user(client, app, 'ann', 'operator')
    assert op.get('/api/v1/auth/state').json()['scopes'] == ['read', 'control']
    assert op.post('/api/v1/users', json={'username': 'x', 'password': 'p' * 10}, headers=H).status_code == 403
    uid = op.get('/api/v1/auth/me').json()['id']
    # operator token is capped at control
    t = op.post('/api/v1/auth/tokens', json={'name': 't', 'scopes': ['admin']}, headers=H).json()
    assert t['scopes'] == ['read'] or 'admin' not in t['scopes']
    client.post('/api/v1/users/%s/password' % uid, json={'new': 'reset-by-admin'}, headers=H)
    assert op.get('/api/v1/papers').status_code == 401
    adm_id = client.get('/api/v1/auth/me').json()['id']
    r = client.patch('/api/v1/users/' + adm_id, json={'role': 'viewer'}, headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'last_admin'
    assert any('user:admin' == a['actor'] for a in client.get('/api/v1/system/audit').json())


def test_control_lease(client, app):
    op = _user(client, app, 'bob', 'operator')
    lease = client.get('/api/v1/machine/lease').json()
    assert lease['held'] and lease['holder']['username'] == 'admin'      # auto-taken by connect/zero
    r = op.post('/api/v1/machine/jog', json={'dx': 1}, headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'lease_held'
    assert op.post('/api/v1/machine/lease', headers=H).status_code == 409
    assert op.post('/api/v1/machine/lease', json={'force': True}, headers=H).status_code == 403
    client.delete('/api/v1/machine/lease', headers=H)
    assert op.post('/api/v1/machine/lease', headers=H).json()['holder']['username'] == 'bob'
    assert op.post('/api/v1/machine/jog', json={'dx': 1}, headers=H).status_code == 200
    assert client.post('/api/v1/machine/jog', json={'dx': 1}, headers=H).status_code == 200   # admin may act
    r = client.post('/api/v1/machine/lease', json={'force': True}, headers=H)
    assert r.json()['holder']['username'] == 'admin'
    # auto-release when the holder is offline and idle
    c = app.state.ctx.collab
    c.lease['last_active'] = time.time() - 1000
    c._ws_gone[c.lease['user_id']] = time.time() - 1000
    c._tick()
    assert client.get('/api/v1/machine/lease').json()['held'] is False


def test_presence_project_broadcast_and_locks(client, app):
    op = _user(client, app, 'cat', 'operator')
    p = client.post('/api/v1/projects', json={'name': 'shared', 'doc': {'pages': [{'id': 'p1', 'elements': [
        {'id': 'e1', 'type': 'shape', 'props': {'kind': 'rect'}}]}]}}, headers=H).json()
    with client.websocket_connect('/api/v1/ws') as a, op.websocket_connect('/api/v1/ws') as b:
        a.receive_json()
        hb = b.receive_json()
        a.send_json({'type': 'presence', 'page': '/studio', 'project_id': p['id']})
        b.send_json({'type': 'presence', 'page': '/studio', 'project_id': p['id']})
        m = _recv(a, lambda m: m['type'] == 'presence' and len([x for x in m['data']['online']
                                                                if x['project_id'] == p['id']]) == 2)
        assert {x['user']['username'] for x in m['data']['online']} >= {'admin', 'cat'}
        assert {x['user']['username'] for x in client.get('/api/v1/projects/%s/collab' % p['id']).json()['viewers']} \
            == {'admin', 'cat'}
        # b locks e1; a cannot patch it without force
        b.send_json({'type': 'lock', 'id': 'L', 'project_id': p['id'], 'element_id': 'e1'})
        _recv(b, lambda m: m['type'] == 'ack' and m['id'] == 'L' and m['ok'])
        _recv(a, lambda m: m['type'] == 'locks' and m['data']['locks'])
        r = client.patch('/api/v1/projects/%s/elements/e1' % p['id'], json={'z': 3}, headers=H)
        assert r.status_code == 409 and r.json()['error']['code'] == 'element_locked'
        # b edits it: a gets the element patch with rev and author
        r = op.patch('/api/v1/projects/%s/elements/e1' % p['id'], json={'transform': {'x': 9, 'y': 1}},
                     headers={**H, 'X-Conn-Id': hb['conn_id']})
        assert r.status_code == 200
        m = _recv(a, lambda m: m['type'] == 'project')
        assert m['data']['kind'] == 'element' and m['data']['by']['username'] == 'cat'
        assert m['data']['patch']['element']['transform']['x'] == 9 and m['data']['rev'] == r.json()['rev']
        assert m['data']['conn_id'] == hb['conn_id']
        r = client.patch('/api/v1/projects/%s/elements/e1?force=1' % p['id'], json={'z': 3}, headers=H)
        assert r.status_code == 200
    # disconnect released the lock
    assert client.get('/api/v1/projects/%s/collab' % p['id']).json()['locks'] == []


def test_attention_events(client, app):
    seen = []
    app.state.ctx.bus.listeners.append(lambda m: seen.append(m['data']) if m['type'] == 'attention' else None)
    f = gcode_file(client, square_gcode(3))
    j = client.post('/api/v1/jobs', json={'source': {'file_id': f['file']['id']}, 'overrides': {'copies': 2},
                                          'start': True}, headers=H).json()
    job_wait(client, j['id'])
    wait_for(lambda: any(a['code'] == 'paper_change' for a in seen))
    a = next(a for a in seen if a['code'] == 'paper_change')
    assert a['sound'] == 'paper' and a['next_job_id'] and '换上下一张纸' in a['message']
    nxt = client.post('/api/v1/batches/%s/start-next' % j['batch_id'], headers=H).json()
    job_wait(client, nxt['id'])
    wait_for(lambda: any(a['code'] == 'job_done' for a in seen))
    app.state.ctx.machine.fake.trigger_alarm(1)
    wait_for(lambda: any(a['code'] == 'alarm' for a in seen))
    assert next(a for a in seen if a['code'] == 'alarm')['level'] == 'error'


def test_client_loss_auto_pause(client, app):
    client.patch('/api/v1/settings', json={'pause_on_client_loss_s': 0.5}, headers=H)
    f = gcode_file(client, square_gcode(200))
    j = client.post('/api/v1/jobs', json={'source': {'file_id': f['file']['id']}, 'start': True}, headers=H).json()
    with client.websocket_connect('/api/v1/ws') as ws:
        ws.receive_json()
        time.sleep(0.6)
    st = wait_for(lambda: (lambda x: x if x['status'] == 'paused' else None)(
        client.get('/api/v1/jobs/' + j['id']).json()), 10)
    assert st['pause_mode'] == 'soft'
    client.post('/api/v1/jobs/%s/stop' % j['id'], headers=H)
    job_wait(client, j['id'])


def test_studio_relay(client, app):
    viewer = _user(client, app, 'vee', 'viewer')
    op = _user(client, app, 'dan', 'operator')
    with client.websocket_connect('/api/v1/ws') as a, op.websocket_connect('/api/v1/ws') as b, \
            viewer.websocket_connect('/api/v1/ws') as v:
        for w in (a, b, v):
            w.receive_json()
        b.send_json({'type': 'studio.presence', 'data': {'project_id': 'p9', 'client': 'B', 'selection': []}})
        _recv(b, lambda m: m['type'] == 'presence')      # b joined p9
        a.send_json({'type': 'studio.presence', 'data': {'project_id': 'p9', 'client': 'A', 'selection': ['e1']}})
        m = _recv(b, lambda m: m['type'] == 'studio.presence' and m['data']['client'] == 'A')
        assert m['data']['from']['user']['username'] == 'admin' and m['data']['selection'] == ['e1']
        b.send_json({'type': 'studio.patch', 'data': {'project_id': 'p9', 'client': 'B', 'ops': [{'op': 'x'}]}})
        m = _recv(a, lambda m: m['type'] == 'studio.patch', n=2000)
        assert m['data']['ops'] == [{'op': 'x'}] and m['data']['from']['user']['username'] == 'dan'
        v.send_json({'type': 'studio.presence', 'data': {'project_id': 'p9', 'client': 'V'}})
        v.send_json({'type': 'studio.patch', 'id': 'vp', 'data': {'project_id': 'p9', 'client': 'V', 'ops': []}})
        ack = _recv(v, lambda m: m['type'] == 'ack' and m['id'] == 'vp')
        assert ack['ok'] is False and ack['error']['code'] == 'forbidden'
        # a socket on another project never sees it
        b.send_json({'type': 'studio.bye', 'data': {'project_id': 'p9', 'client': 'B'}})
        _recv(a, lambda m: m['type'] == 'studio.bye')
