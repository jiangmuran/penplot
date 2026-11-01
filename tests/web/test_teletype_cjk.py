"""Teletype: CJK cells (East-Asian width), wrap / backspace over wide chars,
custom library fonts, glyph fallback, status fields (state == WS events)."""
import pytest
from fastapi.testclient import TestClient

from conftest import H, PW, make_app, wait_for

from penplot.web.teletype.glyphs import MONO, FontGlyphs, Glyphs, char_width
from penplot.web.teletype.paper import Paper, geometry, layout_preview

# tiny CJK test font: 你 好 ， (full-width comma, bottom-left of the em box) and H
TEST_PSF = """#psf 1
name tt-cjk
size 100

glyph 0x4F60 你
m 5 -80
l 95 -80
l 95 0
m 50 -80
l 50 0

glyph 0x597D 好
m 5 -80
l 95 0
m 95 -80
l 5 0

glyph 0x4E2D 中
m 5 -80
l 95 -80
l 95 0
l 5 0
l 5 -80

glyph 0xFF0C ，
m 10 -10
l 15 5

glyph 0x0048 H
m 10 -60
l 10 0
m 40 -60
l 40 0
m 10 -30
l 40 -30
"""


class FakeStreamer:
    def __init__(self):
        self.lines = []

    def queue(self, lines, tag=None):
        self.lines.extend(lines)


def cfg(**kw):
    c = dict(char_h=5.0, paper_w=100.0, paper_h=60.0, margin=5.0, feed=4000, z_down=8.0, z_up=0.0,
             z_speed=5000, max_backlog=1500, letter_spacing=None, line_spacing=None)
    c.update(kw)
    return c


def make_paper(glyphs=None, **kw):
    events = []
    p = Paper(cfg(**kw), FakeStreamer(), lambda kind, **d: events.append((kind, d)), glyphs)
    return p, events


def cells(p):
    return [(c['ch'], c['row'], c['col'], c['w']) for c in p.chars]


def test_char_width():
    assert char_width('A') == 1 and char_width('你') == 2 and char_width('，') == 2 and char_width('Ａ') == 2
    assert char_width('​') == 0 and char_width('́') == 0
    assert char_width('“') == 1 and char_width('“', cjk=True) == 2


def test_wide_cells_wrap_and_backspace():
    p, ev = make_paper()
    cols = p.geo['cols']
    assert cols == 22
    p.typewrite('a你b')
    assert cells(p) == [('a', 0, 0, 1), ('你', 0, 1, 2), ('b', 0, 3, 1)]
    # backspace over 'b' (1 cell), then over 你 (2 cells): back to col 1, overstrike there
    p.typewrite('\b\b')
    assert p.col == 1
    p.typewrite('X')
    assert cells(p)[-1] == ('X', 0, 1, 1)
    # backspace from the right half of 你 (col 2) is a single step to the char's start
    p.typewrite('\b')
    assert p.col == 1
    # wrap: a wide char that doesn't fit in the last column goes to the next line
    p.typewrite('\n' + 'x' * (cols - 1) + '好')
    assert cells(p)[-1] == ('好', 2, 0, 2)
    assert p.col == 2
    # full-width space advances two cells without ink, backspace steps over it whole
    p.typewrite('　')
    assert p.col == 4
    p.typewrite('\b')
    assert p.col == 2
    # zero-width chars are dropped
    n = len(p.chars)
    p.typewrite('​')
    assert len(p.chars) == n
    # every char event carries its glyph path
    chars_ev = [d for k, d in ev if k == 'chars']
    assert all(t[6] in d['glyphs'] for d in chars_ev for t in d['list'])


def test_mono_font_missing_glyphs_box_and_fallback():
    p, ev = make_paper()
    # the built-in font has no hanzi: a visible 2-cell box + a missing warning
    g = p.glyphs
    assert g.prepare('，') == ','            # only the mono font can draw it -> ASCII fallback
    p.typewrite('你')
    assert p.chars[0]['gk'].startswith('b2:') and p.missing == ['你']
    assert ('missing', {'chars': ['你'], 'font': 'mono'}) in ev
    d = p.snapshot()['glyphs'][p.chars[0]['gk']]
    assert d.startswith('M') and 'L' in d


@pytest.fixture
def cjk_font(tmp_path):
    path = tmp_path / 'tt-cjk.psf'
    path.write_text(TEST_PSF, encoding='utf-8')
    from penplot.psf import load_font
    return FontGlyphs('tt-cjk', load_font(str(path)), 'tt-cjk')


def test_custom_font_metrics_and_geometry(cjk_font):
    g = Glyphs(cjk_font)
    assert g.cjk and g.cell_ratio == 0.5
    # the font keeps its own full-width comma (no ASCII conversion), 2 cells
    assert g.prepare('，') == '，' and g.width('，') == 2
    # 'e' is not in the font: drawn with the built-in font, not converted
    assert g.prepare('e') == 'e'
    geo = geometry(cfg(letter_spacing=1.0, line_spacing=2.0), g)
    assert geo['cw'] == pytest.approx(5 * 0.5 + 1.0) and geo['lh'] == pytest.approx(10.0)
    assert geo['cols'] == int(90 // 3.5)
    st, src = g.draw('你', 2, geo)
    assert src == 'font'
    ys = [y for s in st for _, y in s]
    xs = [x for s in st for x, _ in s]
    assert min(ys) == pytest.approx(0, abs=0.05) and max(ys) == pytest.approx(5, abs=0.05)   # char_h tall
    assert 0 <= min(xs) and max(xs) <= 2 * geo['cw']                                    # inside its 2 cells
    st, _ = g.draw('，', 2, geo)
    assert max(x for s in st for x, _ in s) < geo['cw']          # stays in the left half (em-box position)
    assert g.draw('e', 1, geo)[1] == 'mono' and g.draw('é', 1, geo)[1] == 'box'
    r = layout_preview('你好，He', cfg(), g)
    assert [(c[1], c[3], c[5]) for c in r['chars']] == [('你', 0, 2), ('好', 2, 2), ('，', 4, 2), ('H', 6, 1),
                                                       ('e', 7, 1)]
    assert set(r['glyphs']) == {c[6] for c in r['chars']}


# ---------------------------------------------------------------- API
@pytest.fixture
def capp(tmp_path):
    fdir = tmp_path / 'fonts'
    fdir.mkdir()
    (fdir / 'tt-cjk.psf').write_text(TEST_PSF, encoding='utf-8')
    return make_app(tmp_path)


@pytest.fixture
def cclient(capp):
    with TestClient(capp, base_url='http://testserver') as c:
        assert c.post('/api/v1/auth/setup', json={'password': PW}, headers=H).status_code == 200
        assert c.post('/api/v1/machine/connect', json={'port': 'fake'}, headers=H).status_code == 200
        assert c.post('/api/v1/machine/zero', json={'axes': 'xyz'}, headers=H).status_code == 200
        yield c


def test_custom_font_session(cclient, capp):
    c = cclient
    assert any(f['id'] == 'tt-cjk' for f in c.get('/api/v1/fonts').json())
    events = []
    capp.state.ctx.bus.listeners.append(lambda m: events.append(m['data']) if m['type'] == 'teletype' else None)
    # preview without a session: same layout as the session will use
    r = c.post('/api/v1/teletype/preview', json={'font_id': 'tt-cjk', 'text': '你好，Hé', 'char_h': 5,
                                                 'paper_w': 100, 'paper_h': 60, 'margin': 5}, headers=H)
    assert r.status_code == 200, r.text
    pv = r.json()
    assert pv['font']['cjk'] is True and pv['missing'] == ['é']
    assert [x[5] for x in pv['chars']] == [2, 2, 2, 1, 1]
    assert c.post('/api/v1/teletype/preview', json={'font_id': 'nope'}, headers=H).json()['error']['code'] == \
        'font_not_found'

    r = c.post('/api/v1/teletype/session', json={'char_h': 5, 'paper_w_mm': 100, 'paper_h_mm': 60, 'margin': 5,
                                                 'font_id': 'tt-cjk', 'letter_spacing': 0.5}, headers=H)
    assert r.status_code == 201, r.text
    st = r.json()
    assert st['font']['id'] == 'tt-cjk' and st['cfg']['font_id'] == 'tt-cjk'
    assert st['cols'] == int(90 // 3.0)
    assert st['pen'] is not None and 'state' in st['pen']
    r = c.post('/api/v1/teletype/type', json={'text': '你好，H'}, headers=H)
    assert r.status_code == 200 and r.json()['echo'] == '你好，H'     # no ASCII conversion with a CJK font
    fake = capp.state.ctx.machine.fake
    n0 = len(fake.received_lines)
    wait_for(lambda: c.get('/api/v1/teletype/state').json()['pending'] == 0, 10)
    st = c.get('/api/v1/teletype/state').json()
    chars = [(x[1], x[3], x[4], x[5]) for x in st['paper']['chars']]
    assert chars == [('你', 0, 'ok', 2), ('好', 2, 'ok', 2), ('，', 4, 'ok', 2), ('H', 6, 'ok', 1)]
    assert st['col'] == 7 and st['queued'] == 0 and st['written'] == 4
    assert set(st['paper']['glyphs']) == {x[6] for x in st['paper']['chars']}
    assert n0 > 0 and any(ln.startswith('G1 X') for ln in fake.received_lines)
    # backspace over the 1-cell H then the 2-cell comma
    c.post('/api/v1/teletype/type', json={'text': '\b\b'}, headers=H)
    assert c.get('/api/v1/teletype/state').json()['col'] == 4
    # acks are batched (ids) and every ack batch reports the queue
    wait_for(lambda: sum(len(e['ids']) for e in events if e['kind'] == 'ack') == 4, 5)
    acks = [e for e in events if e['kind'] == 'ack']
    assert acks and all(isinstance(e['ids'], list) and 'queued' in e for e in acks)
    assert sum(len(e['ids']) for e in acks) == 4
    # change font mid-page: waits for the next sheet
    r = c.post('/api/v1/teletype/action', json={'action': 'settings', 'args': {'font_id': 'mono'}}, headers=H)
    st = r.json()
    assert st['font']['id'] == 'tt-cjk' and st['next_font']['id'] == 'mono'
    c.post('/api/v1/teletype/action', json={'action': 'change_paper'}, headers=H)
    st = c.post('/api/v1/teletype/newpage', headers=H).json()
    assert st['font']['id'] == 'mono' and st['next_font'] is None and st['page'] == 2
    assert st['paper']['chars'] == [] and st['need_paper'] is False
    assert st['written'] == 4                     # session total survives the new page
    # with the mono font the comma falls back to ASCII and hanzi become boxes (+ warning)
    r = c.post('/api/v1/teletype/type', json={'text': '中，'}, headers=H)
    assert r.json()['echo'] == '中,'
    st = c.get('/api/v1/teletype/state').json()
    assert '中' in st['missing']
    assert any(e['kind'] == 'missing' and e['chars'] == ['中'] for e in events)
    assert any(e['kind'] == 'need_paper' and e['on'] is False for e in events)
    c.delete('/api/v1/teletype/session', headers=H)


def test_state_matches_ws_hello(cclient):
    c = cclient
    c.post('/api/v1/teletype/session', json={'font_id': 'tt-cjk'}, headers=H)
    c.post('/api/v1/teletype/type', json={'text': '你'}, headers=H)
    wait_for(lambda: c.get('/api/v1/teletype/state').json()['pending'] == 0, 10)
    st = c.get('/api/v1/teletype/state').json()
    with c.websocket_connect('/api/v1/ws') as ws:
        hello = ws.receive_json()
        snap = hello['snapshot']['teletype']
        for k in ('session_id', 'mode', 'page', 'queued', 'written', 'font', 'row', 'col', 'need_paper', 'paused'):
            assert snap[k] == st[k], k
        assert snap['pen']['pos'] is not None
    c.delete('/api/v1/teletype/session', headers=H)


def test_terminal_mode_stays_ascii(tmp_path):
    """Terminal ops always use the built-in font (TtyFilter keeps the ASCII mapping)."""
    from penplot.psf import load_font
    path = tmp_path / 'f.psf'
    path.write_text(TEST_PSF, encoding='utf-8')
    p, _ = make_paper(Glyphs(FontGlyphs('tt-cjk', load_font(str(path)))))
    p.apply([('c', 0, 'H'), ('c', 1, '你')])
    assert [c['gk'][:2] for c in p.chars] == ['m1', 'b2']


def test_mono_is_default():
    assert Glyphs().primary is MONO
