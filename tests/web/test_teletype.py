import os

import pytest
from fastapi.testclient import TestClient

from conftest import H, PW, gcode_file, make_app, square_gcode, wait_for

from penplot.web.teletype.tty import TtyFilter, normalize


def test_tty_filter_semantics():
    t = TtyFilter(20)
    # echo goes out at once; rewrites are overstruck when the line ends
    ops = t.feed('abc')
    assert [o for o in ops if o[0] == 'c'] == [('c', 0, 'a'), ('c', 1, 'b'), ('c', 2, 'c')]
    ops = t.feed('\rxy\n')
    assert ('c', 0, 'x') in ops and ('c', 1, 'y') in ops and ('n',) in ops
    # deleted chars get a '/'
    t.feed('\rhello')
    ops = t.feed('\b\b\x1b[K\n')
    assert ('c', 3, '/') in ops and ('c', 4, '/') in ops
    # alternate screen -> one placeholder line
    ops = t.feed('\x1b[?1049hTOP SCREEN\x1b[?1049l')
    printed = ''.join(o[2] for o in ops if o[0] == 'c')
    assert printed == TtyFilter.NOTE[:20]
    assert normalize('，') == ',' and normalize('Ａ') == 'A'


def test_typing_session_writes_and_holds_machine(client, app):
    events = []
    app.state.ctx.bus.listeners.append(lambda m: events.append(m['data']) if m['type'] == 'teletype' else None)
    r = client.post('/api/v1/teletype/session', json={'char_h': 5, 'paper_w_mm': 100, 'paper_h_mm': 40,
                                                      'margin': 5}, headers=H)
    assert r.status_code == 201, r.text
    st = r.json()
    assert st['active'] and st['cols'] == 22 and st['rows'] == 4 and st['mode'] == 'type'
    r = client.post('/api/v1/teletype/type', json={'text': 'Hi，A\x08B'}, headers=H)
    assert r.json()['echo'] == 'Hi,A\x08B'
    fake = app.state.ctx.machine.fake
    wait_for(lambda: client.get('/api/v1/teletype/state').json()['pending'] == 0, 10)
    paper = client.get('/api/v1/teletype/state').json()['paper']
    chars = [(c[1], c[2], c[3], c[4]) for c in paper['chars']]
    assert chars == [('H', 0, 0, 'ok'), ('i', 0, 1, 'ok'), (',', 0, 2, 'ok'), ('A', 0, 3, 'ok'), ('B', 0, 3, 'ok')]
    assert any(e['kind'] == 'ack' for e in events) and any(e['kind'] == 'chars' for e in events)
    assert any(x.startswith('G10 P0 L20') for x in fake.received_lines)
    # a job cannot start while the session holds the machine
    f = gcode_file(client, square_gcode(2))
    r = client.post('/api/v1/jobs', json={'source': {'file_id': f['file']['id']}, 'start': True}, headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'teletype_active'
    # page full after 4 lines -> need_paper, newpage resumes
    client.post('/api/v1/teletype/type', json={'text': '\n2\n3\n4\n'}, headers=H)
    st = client.get('/api/v1/teletype/state').json()
    assert st['need_paper'] is True
    r = client.post('/api/v1/teletype/type', json={'text': 'x'}, headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'need_paper'
    assert client.post('/api/v1/teletype/newpage', headers=H).json()['page'] == 2
    assert client.post('/api/v1/teletype/type', json={'text': 'x'}, headers=H).status_code == 200
    # e-stop works and keeps the session usable when the hold completed
    r = client.post('/api/v1/machine/estop', headers=H)
    assert r.status_code == 200
    assert client.get('/api/v1/teletype/state').json()['active'] is True
    r = client.delete('/api/v1/teletype/session', headers=H)
    assert r.json()['active'] is False
    assert client.post('/api/v1/jobs', json={'source': {'file_id': f['file']['id']}, 'start': True},
                       headers=H).status_code == 201


def test_ws_keys_and_terminal_disabled(client, app):
    client.post('/api/v1/teletype/session', json={}, headers=H)
    with client.websocket_connect('/api/v1/ws') as ws:
        hello = ws.receive_json()
        assert hello['snapshot']['teletype']['active'] is True
        ws.send_json({'type': 'tt_keys', 'data': 'ok'})
        for _ in range(200):
            m = ws.receive_json()
            if m['type'] == 'teletype' and m['data']['kind'] == 'chars':
                assert [c[1] for c in m['data']['list']] == ['o', 'k']
                break
        else:
            raise AssertionError('no chars event')
    r = client.post('/api/v1/teletype/action', json={'action': 'mode', 'args': {'mode': 'term'}}, headers=H)
    assert r.status_code == 403 and r.json()['error']['code'] == 'terminal_disabled'
    client.delete('/api/v1/teletype/session', headers=H)


@pytest.mark.skipif(not os.path.exists('/bin/bash'), reason='needs bash')
def test_terminal_mode_pty(client, app):
    client.patch('/api/v1/settings', json={'teletype': {'terminal_enabled': True}}, headers=H)
    r = client.post('/api/v1/teletype/session', json={'mode': 'term', 'paper_w_mm': 120}, headers=H)
    assert r.status_code == 201, r.text
    with client.websocket_connect('/api/v1/teletype/pty') as ws:
        ws.send_bytes(b'echo PEN$((40+2))\n')
        got = b''
        for _ in range(100):
            got += ws.receive_bytes()
            if b'PEN42' in got:
                break
        assert b'PEN42' in got
    wait_for(lambda: any(c[1] == '4' for c in client.get('/api/v1/teletype/state').json()['paper']['chars']), 10)
    audit = [a['action'] for a in client.get('/api/v1/system/audit').json()]
    assert 'terminal_start' in audit
    client.delete('/api/v1/teletype/session', headers=H)
