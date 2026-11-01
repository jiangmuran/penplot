"""Seed content: built-in papers, read-only templates tpl-*, samples; every template renders cleanly."""
import json
import os

import pytest
from fastapi.testclient import TestClient

from conftest import H, PW, REPO, make_app

SEED = os.path.join(REPO, 'seed')
pytestmark = pytest.mark.skipif(not os.path.exists(os.path.join(SEED, 'templates', 'index.json')),
                                reason='no seed content')


@pytest.fixture
def seeded(tmp_path):
    app = make_app(tmp_path)
    fd = str(tmp_path / 'fonts')
    for fn in os.listdir(os.path.join(REPO, 'fonts')):
        dst = os.path.join(fd, fn)
        if fn.endswith(('.gfont', '.psf')) and not os.path.exists(dst):
            os.symlink(os.path.join(REPO, 'fonts', fn), dst)
    with TestClient(app) as c:
        c.post('/api/v1/auth/setup', json={'password': PW}, headers=H)
        yield c


def test_seed_papers_templates_samples(seeded):
    c = seeded
    papers = {p['id']: p for p in c.get('/api/v1/papers').json()}
    seed_papers = json.load(open(os.path.join(SEED, 'papers.json')))['papers']
    for sp in seed_papers:
        assert papers[sp['id']]['builtin'] is True
    assert c.put('/api/v1/papers/' + seed_papers[0]['id'], json={'name': 'x', 'width_mm': 1, 'height_mm': 1},
                 headers=H).status_code == 409
    tpls = [p for p in c.get('/api/v1/projects?template=1').json() if p['builtin']]
    idx = json.load(open(os.path.join(SEED, 'templates', 'index.json')))['templates']
    assert sorted(t['id'] for t in tpls) == sorted('tpl-' + t['id'] for t in idx)
    t0 = c.get('/api/v1/projects/' + tpls[0]['id']).json()
    assert t0['category'] and t0['thumb_url']
    assert c.get(t0['thumb_url']).headers['content-type'] == 'image/png'
    r = c.put('/api/v1/projects/' + t0['id'], json={'doc': t0['doc'], 'rev': t0['rev']}, headers=H)
    assert r.status_code == 409 and r.json()['error']['code'] == 'builtin'
    assert c.delete('/api/v1/projects/' + t0['id'], headers=H).status_code == 409
    copy = c.post('/api/v1/projects/%s/duplicate' % t0['id'], headers=H).json()
    assert copy['builtin'] is False and copy['is_template'] is False
    samples = c.get('/api/v1/files?tag=示例').json()
    assert {f['name'] for f in samples} >= {'addresses.csv', 'guests.csv'}


def test_every_seed_template_renders_without_missing_glyphs(seeded):
    c = seeded
    idx = json.load(open(os.path.join(SEED, 'templates', 'index.json')))['templates']
    for t in idx:
        r = c.post('/api/v1/projects/tpl-%s/render?wait=60' % t['id'], json={}, headers=H)
        assert r.status_code == 200, (t['id'], r.text)
        for pg in r.json()['pages']:
            w = pg['warnings']
            assert not w['missing_glyphs'], (t['id'], w)
            assert not w['overflow'] and not w['clipped'], (t['id'], w)
            # fitting the machine travel depends on the active profile (e.g. a 220 mm
            # envelope cannot fit a 200 mm machine) - the UI warns; not a template defect
