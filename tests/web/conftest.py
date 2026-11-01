import os
import sys
import time

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, REPO)

pytest.importorskip('fastapi')

from fastapi.testclient import TestClient  # noqa: E402

from penplot.web.app import create_app  # noqa: E402
from penplot.web.config import Config  # noqa: E402

H = {'X-Penplot': '1'}
PW = 'correct horse battery'


def make_app(tmp_path, dev=True, task_mode='thread', time_scale=0.02, **env):
    e = {'PENPLOT_DATA_DIR': str(tmp_path / 'data'), 'PENPLOT_CACHE_DIR': str(tmp_path / 'cache'),
         'PENPLOT_FONT_DIR': str(tmp_path / 'fonts'), 'PENPLOT_SERIAL_PORT': 'fake',
         'PENPLOT_FAKE_TIME_SCALE': str(time_scale), 'PENPLOT_TASK_MODE': task_mode,
         'PENPLOT_SERIAL_LOCK': str(tmp_path / 'serial.lock'),
         # fixed test profile (paper-anchored origin, 300x300 travel) so tests don't
         # depend on the real machine defaults in configs/grbl-zpen.json
         'PENPLOT_SEED_PROFILE': os.path.join(os.path.dirname(__file__), 'fixtures', 'test-profile.json')}
    if dev:
        e['PENPLOT_DEV'] = '1'
    e.update(env)
    os.makedirs(e['PENPLOT_FONT_DIR'], exist_ok=True)
    src = os.path.join(REPO, 'fonts', 'penplot-sans.psf')
    dst = os.path.join(e['PENPLOT_FONT_DIR'], 'penplot-sans.psf')
    if os.path.exists(src) and not os.path.exists(dst):
        os.symlink(src, dst)
    os.environ['PENPLOT_SERIAL_LOCK'] = e['PENPLOT_SERIAL_LOCK']
    return create_app(Config.from_env(env=e))


def wait_for(fn, timeout=10.0, dt=0.05):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(dt)
    raise AssertionError('timeout waiting; last=%r' % (last,))


@pytest.fixture
def app(tmp_path):
    return make_app(tmp_path)


@pytest.fixture
def client(app):
    """Logged-in dev client with the FakeGrbl connected."""
    with TestClient(app, base_url='http://testserver') as c:
        r = c.post('/api/v1/auth/setup', json={'password': PW}, headers=H)
        assert r.status_code == 200, r.text
        r = c.post('/api/v1/machine/connect', json={'port': 'fake'}, headers=H)
        assert r.status_code == 200, r.text
        # pen parked up at the paper corner: calibrate XYZ once (Z is never zeroed implicitly)
        r = c.post('/api/v1/machine/zero', json={'axes': 'xyz'}, headers=H)
        assert r.status_code == 200, r.text
        yield c


def job_wait(c, jid, states=('done', 'failed', 'aborted'), timeout=20):
    def chk():
        j = c.get('/api/v1/jobs/' + jid).json()
        return j if j['status'] in states else None
    return wait_for(chk, timeout)


def gcode_file(c, text, name='t.gcode'):
    r = c.post('/api/v1/import/gcode', files={'file': (name, text.encode(), 'text/plain')}, headers=H)
    assert r.status_code == 201, r.text
    return r.json()


def square_gcode(n=40, size=20.0):
    out = ['G21', 'G90', 'F1500', 'G1G90 Z0.0F5000']
    for i in range(n):
        x = (i % 10) * 2.0
        y = -(i // 10) * 2.0
        out += ['G0 X%.3fY%.3fF2500' % (x, y), 'G1G90 Z8.0F5000', 'G1 X%.3fY%.3fF1500' % (x + 1.5, y),
                'G1 X%.3fY%.3fF1500' % (x + 1.5, y - 1.5), 'G1G90 Z0.0F5000']
    out += ['G1G90 Z0.0F5000', 'G90G0 X0Y0']
    return '\r\n'.join(out) + '\r\n'
