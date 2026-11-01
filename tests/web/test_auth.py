import os

from fastapi.testclient import TestClient

from conftest import H, PW, make_app


def test_setup_code_flow_and_csrf(tmp_path):
    app = make_app(tmp_path, dev=False)
    with TestClient(app) as c:
        st = c.get('/api/v1/auth/state').json()
        assert st['setup_required'] and st['setup_code_required']
        assert c.get('/api/v1/fonts').status_code == 423
        assert c.get('/api/v1/system/health').status_code == 200
        code = open(os.path.join(str(tmp_path / 'data'), 'setup-code')).read().strip()
        assert len(code) == 8
        # no CSRF header -> 403
        r = c.post('/api/v1/auth/setup', json={'setup_code': code, 'password': PW})
        assert r.status_code == 403 and r.json()['error']['code'] == 'csrf'
        r = c.post('/api/v1/auth/setup', json={'setup_code': '00000000', 'password': PW}, headers=H)
        assert r.status_code == 403 and r.json()['error']['code'] == 'bad_setup_code'
        r = c.post('/api/v1/auth/setup', json={'setup_code': code, 'password': 'short'}, headers=H)
        assert r.status_code == 422 and r.json()['error']['code'] == 'validation_error'
        r = c.post('/api/v1/auth/setup', json={'setup_code': code, 'password': PW}, headers=H)
        assert r.status_code == 200
        assert not os.path.exists(os.path.join(str(tmp_path / 'data'), 'setup-code'))
        assert c.get('/api/v1/auth/state').json()['authenticated']
        assert c.get('/api/v1/fonts').status_code == 200
        # unsafe request without header / with foreign origin
        assert c.post('/api/v1/papers', json={'name': 'x', 'width_mm': 100, 'height_mm': 100}).status_code == 403
        r = c.post('/api/v1/papers', json={'name': 'x', 'width_mm': 100, 'height_mm': 100},
                   headers={'X-Penplot': '1', 'Origin': 'http://evil.example'})
        assert r.status_code == 403 and r.json()['error']['code'] == 'csrf_origin'
        r = c.post('/api/v1/papers', json={'name': 'x', 'width_mm': 100, 'height_mm': 100},
                   headers={'X-Penplot': '1', 'Origin': 'http://testserver'})
        assert r.status_code == 201
        # second setup refused
        assert c.post('/api/v1/auth/setup', json={'password': PW}, headers=H).status_code == 409


def test_login_rate_limit_tokens_scopes(tmp_path):
    app = make_app(tmp_path)
    with TestClient(app) as c:
        assert c.post('/api/v1/auth/setup', json={'password': PW}, headers=H).status_code == 200
        c.post('/api/v1/auth/logout', headers=H)
        assert c.get('/api/v1/fonts').status_code == 401
        for _ in range(5):
            assert c.post('/api/v1/auth/login', json={'password': 'wrong'}, headers=H).status_code == 401
        r = c.post('/api/v1/auth/login', json={'password': PW}, headers=H)
        assert r.status_code == 429 and r.json()['error']['code'] == 'rate_limited'
        app.state.ctx.auth.limiter = type(app.state.ctx.auth.limiter)()
        r = c.post('/api/v1/auth/login', json={'password': PW}, headers=H)
        assert r.status_code == 200 and r.json()['expires_at'] > 0
        # tokens
        r = c.post('/api/v1/auth/tokens', json={'name': 'ro', 'scopes': ['read']}, headers=H)
        assert r.status_code == 201
        ro = r.json()['token']
        assert ro.startswith('ppt_')
        rw = c.post('/api/v1/auth/tokens', json={'name': 'rw', 'scopes': ['control']}, headers=H).json()
        toks = c.get('/api/v1/auth/tokens').json()
        assert {t['name'] for t in toks} == {'ro', 'rw'}
        assert all('token' not in t for t in toks)
    with TestClient(app) as b:   # fresh client: no cookie
        hr = {'Authorization': 'Bearer ' + ro}
        assert b.get('/api/v1/papers', headers=hr).status_code == 200
        # read token cannot control (and needs no CSRF header)
        r = b.post('/api/v1/projects', json={'name': 'x'}, headers=hr)
        assert r.status_code == 403 and r.json()['error']['code'] == 'forbidden'
        hw = {'Authorization': 'Bearer ' + rw['token']}
        assert b.post('/api/v1/projects', json={'name': 'x'}, headers=hw).status_code == 201
        assert b.get('/api/v1/auth/tokens', headers=hw).status_code == 200     # own tokens
        assert b.post('/api/v1/auth/tokens', json={'name': 'x'}, headers=hw).status_code == 403
        assert b.post('/api/v1/users', json={'username': 'x', 'password': 'p' * 10}, headers=hw).status_code == 403
        assert b.get('/api/v1/papers', headers={'Authorization': 'Bearer ppt_x_y'}).status_code == 401
        st = b.get('/api/v1/auth/state', headers=hr).json()
        assert st['authenticated'] and st['via'] == 'token' and st['scopes'] == ['read']


def test_password_change_revokes_other_sessions(tmp_path):
    app = make_app(tmp_path)
    with TestClient(app) as a, TestClient(app) as b:
        assert a.post('/api/v1/auth/setup', json={'password': PW}, headers=H).status_code == 200
        assert b.post('/api/v1/auth/login', json={'password': PW}, headers=H).status_code == 200
        assert len(a.get('/api/v1/auth/sessions').json()) == 2
        r = a.post('/api/v1/auth/password', json={'old': PW, 'new': 'another long pw'}, headers=H)
        assert r.status_code == 204
        assert a.get('/api/v1/papers').status_code == 200
        assert b.get('/api/v1/papers').status_code == 401
        assert b.post('/api/v1/auth/login', json={'password': 'another long pw'}, headers=H).status_code == 200


def test_reset_password_cli(tmp_path):
    app = make_app(tmp_path)
    with TestClient(app) as c:
        c.post('/api/v1/auth/setup', json={'password': PW}, headers=H)
        assert app.state.ctx.auth.reset_password('brand new password') == ('admin', 'brand new password')
        assert c.get('/api/v1/papers').status_code == 401
        assert c.post('/api/v1/auth/login', json={'password': 'brand new password'}, headers=H).status_code == 200


def test_spa_fallback_and_api_404(tmp_path):
    static = tmp_path / 'static'
    (static / 'assets').mkdir(parents=True)
    (static / 'index.html').write_text('<html>spa</html>')
    (static / 'assets' / 'app.js').write_text('console.log(1)')
    (static / 'assets' / 'app.js.gz').write_bytes(__import__('gzip').compress(b'console.log(1)'))
    app = make_app(tmp_path, PENPLOT_STATIC_DIR=str(static))
    with TestClient(app) as c:
        r = c.get('/projects/abc')
        assert r.status_code == 200 and 'spa' in r.text and r.headers['cache-control'] == 'no-cache'
        r = c.get('/assets/app.js', headers={'Accept-Encoding': 'gzip'})
        assert r.status_code == 200 and 'immutable' in r.headers['cache-control']
        assert c.get('/assets/missing.js').status_code == 404
        r = c.get('/api/v1/nope')
        assert r.status_code == 404 and r.json()['error']['code'] == 'not_found'
