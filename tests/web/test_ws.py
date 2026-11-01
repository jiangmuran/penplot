import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from conftest import H, PW, gcode_file, make_app, square_gcode


def _recv_until(ws, pred, n=400):
    for _ in range(n):
        m = ws.receive_json()
        if pred(m):
            return m
    raise AssertionError('message not seen')


def test_ws_hello_job_progress_and_estop_cmd(client, app):
    with client.websocket_connect('/api/v1/ws') as ws:
        hello = ws.receive_json()
        assert hello['type'] == 'hello' and hello['seq'] == 1
        assert hello['snapshot']['machine']['connected'] is True and hello['snapshot']['job'] is None
        ws.send_json({'type': 'subscribe', 'topics': ['status', 'progress', 'job', 'log', 'alarm', 'error']})
        ws.send_json({'type': 'ping', 't': 123})
        _recv_until(ws, lambda m: m['type'] == 'pong' and m['t'] == 123)
        f = gcode_file(client, square_gcode(80))
        j = client.post('/api/v1/jobs', json={'source': {'file_id': f['file']['id']}, 'start': True}, headers=H).json()
        m = _recv_until(ws, lambda m: m['type'] == 'job' and m['data']['to'] == 'running')
        assert m['data']['job']['id'] == j['id']
        p = _recv_until(ws, lambda m: m['type'] == 'progress')
        assert p['data']['job_id'] == j['id'] and p['data']['total'] == j['total_lines']
        lg = _recv_until(ws, lambda m: m['type'] == 'log')
        assert any(x['dir'] == '>' for x in lg['data']['lines'])
        ws.send_json({'type': 'cmd', 'id': 'k1', 'op': 'estop', 'args': {}})
        seen = {}
        _recv_until(ws, lambda m: seen.setdefault(m['type'] if m['type'] != 'job' else 'job:' + m['data']['to'], m)
                    and 'ack' in seen and 'job:aborted' in seen)
        assert seen['ack']['id'] == 'k1' and seen['ack']['ok'] is True
        assert seen['job:aborted']['data']['reason'] == 'estop'
        ws.send_json({'type': 'cmd', 'id': 'k2', 'op': 'pause', 'args': {}})
        ack = _recv_until(ws, lambda m: m['type'] == 'ack')
        assert ack['ok'] is False and ack['error']['code'] == 'no_job'
        seqs = []
        ws.send_json({'type': 'ping', 't': 1})
        m = _recv_until(ws, lambda m: m['type'] == 'pong')
        assert m['seq'] > ack['seq']
        del seqs


def test_ws_requires_auth(tmp_path):
    app = make_app(tmp_path)
    with TestClient(app) as c:
        with c.websocket_connect('/api/v1/ws') as ws:
            with pytest.raises(WebSocketDisconnect) as e:
                ws.receive_json()
            assert e.value.code == 4423
        c.post('/api/v1/auth/setup', json={'password': PW}, headers=H)
        tok = c.post('/api/v1/auth/tokens', json={'name': 'r', 'scopes': ['read']}, headers=H).json()['token']
        c.post('/api/v1/auth/logout', headers=H)
        with c.websocket_connect('/api/v1/ws') as ws:
            with pytest.raises(WebSocketDisconnect) as e:
                ws.receive_json()
            assert e.value.code == 4401
        # bearer via subprotocol; read scope cannot send commands
        with c.websocket_connect('/api/v1/ws', subprotocols=['penplot.v1', 'bearer.' + tok]) as ws:
            assert ws.receive_json()['type'] == 'hello'
            ws.send_json({'type': 'cmd', 'id': 'x', 'op': 'estop'})       # everyone may e-stop
            ack = _recv_until(ws, lambda m: m['type'] == 'ack')
            assert ack['ok'] is True
            ws.send_json({'type': 'cmd', 'id': 'y', 'op': 'pause'})
            ack = _recv_until(ws, lambda m: m['type'] == 'ack' and m['id'] == 'y')
            assert ack['ok'] is False and ack['error']['code'] == 'forbidden'
            ws.send_json({'type': 'tt_keys', 'id': 'z', 'data': 'hi'})     # P2
            ack = _recv_until(ws, lambda m: m['type'] == 'ack' and m['id'] == 'z')
            assert ack['ok'] is False and ack['error']['code'] == 'forbidden'


def test_eventbus_slow_client_drops_and_gaps():
    from penplot.web.events import MAXQ, EventBus
    bus = EventBus()
    s = bus.subscribe(topics={'status', 'log', 'job'})
    for i in range(MAXQ + 50):
        bus.publish('log', {'lines': [i]})
    for i in range(100):
        bus.publish('status', {'i': i})
    bus.publish('job', {'job_id': 'x'})
    out = s.drain()
    assert out[0] == {'type': 'gap', 'dropped': 51}
    statuses = [m for m in out if m['type'] == 'status']
    assert len(statuses) == 1 and statuses[0]['data']['i'] == 99    # latest-value slot
    assert out[-2]['type'] == 'job'
    assert len(out) <= MAXQ + 2
    time.sleep(0)
