"""Teletype REST + PTY WebSocket."""
import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from ..auth import COOKIE, origin_ok
from ..deps import L, R
from ..errors import ApiError
from ..schemas import (TeletypeAction, TeletypeFont, TeletypePreview, TeletypePreviewResult, TeletypeSessionCreate,
                       TeletypeState, TeletypeType, TeletypeTypeResult)

log = logging.getLogger('penplot.web.teletype')
router = APIRouter(prefix='/teletype', tags=['teletype'])


def _tt(request):
    return request.app.state.ctx.teletype


@router.get('/state', response_model=TeletypeState)
def state(request: Request, p: R):
    return _tt(request).state()


@router.get('/font', response_model=TeletypeFont)
def tt_font(request: Request, p: R):
    """The monospace stroke font (grid units: x 0..4, y down 0 cap .. 6 baseline .. 8 descender)."""
    return _tt(request).font_json()


@router.post('/preview', response_model=TeletypePreviewResult,
             responses={404: {'description': 'font_not_found'}})
async def preview(request: Request, p: R, body: Optional[TeletypePreview] = None):
    """Lay out sample text on the teletype grid with the given settings (unset fields: the session's,
    else defaults): geometry, char cells (CJK = 2) and glyph paths exactly as the pen would draw them.
    The font is loaded once off the event loop and cached."""
    return await _tt(request).preview(body or TeletypePreview())


@router.post('/session', response_model=TeletypeState, status_code=201,
             responses={409: {'description': 'job_active / teletype_active / machine_busy / origin_invalid'}})
async def create_session(request: Request, p: L, body: Optional[TeletypeSessionCreate] = None):
    """Start a paper-terminal session: holds the machine like a job (no jobs meanwhile; e-stop works).
    The current pen position becomes the paper's top-left corner (set_zero, default true)."""
    return await _tt(request).create(body or TeletypeSessionCreate(), p)


@router.delete('/session', response_model=TeletypeState)
async def delete_session(request: Request, p: L):
    """End the session: unsent text is dropped, pen up, back to the origin."""
    await _tt(request).close(p)
    return _tt(request).state()


@router.post('/type', response_model=TeletypeTypeResult,
             responses={409: {'description': 'need_paper / origin_invalid / no_session'}})
def type_text(body: TeletypeType, request: Request, p: L):
    """Typing mode: each char is written at once with the session font; CJK / full-width chars take two
    cells; full-width punctuation becomes ASCII only when no font has it. In terminal mode the text goes
    to the shell instead."""
    return _tt(request).keys(body.text, p)


@router.post('/newpage', response_model=TeletypeState)
def newpage(request: Request, p: L):
    """Confirm a fresh sheet is in place: new page, buffered output continues."""
    return _tt(request).newpage()


@router.post('/action', response_model=TeletypeState)
async def action(body: TeletypeAction, request: Request, p: L):
    return await _tt(request).action(body.action, p, body.args)


@router.websocket('/pty')
async def pty_ws(ws: WebSocket):
    """Terminal mode PTY stream (admin only, settings.teletype.terminal_enabled).
    Server -> client: binary frames = terminal output (UTF-8); first frame is the replay.
    Client -> server: binary or text frames = keystrokes; a text frame
    {"type":"resize","rows":N} resizes (columns are fixed to the paper width)."""
    c = ws.app.state.ctx
    protos = [x.strip() for x in ws.headers.get('sec-websocket-protocol', '').split(',') if x.strip()]
    p = None
    for x in protos:
        if x.startswith('bearer.'):
            p = c.auth.token(x[7:])
    if p is None and origin_ok(ws.headers, c.cfg):
        tok = ws.cookies.get(COOKIE)
        p = c.auth.session(tok) if tok else None
    from ..auth import mark_remote
    mark_remote(p, ws.headers, ws.client.host if ws.client else '')
    await ws.accept(subprotocol='penplot.v1' if 'penplot.v1' in protos else None)
    if p is None:
        await ws.close(code=4401)
        return
    tt = c.teletype
    try:
        tt._check_terminal(p)
        q = asyncio.Queue()
        replay = tt.pty_attach(q)
    except ApiError as e:
        await ws.send_text(json.dumps(e.body(), ensure_ascii=False))
        await ws.close(code=4403)
        return
    c.db.audit(p.actor, 'terminal_attach', {})

    async def pump():
        while True:
            data = await q.get()
            await asyncio.wait_for(ws.send_bytes(data), 5.0)
    task = asyncio.create_task(pump())
    try:
        if replay:
            await ws.send_bytes(replay[-200000:])
        while True:
            m = await ws.receive()
            if m.get('type') == 'websocket.disconnect':
                break
            if m.get('bytes') is not None:
                tt.pty_input(m['bytes'])
            elif m.get('text') is not None:
                t = m['text']
                if t.startswith('{'):
                    try:
                        d = json.loads(t)
                    except ValueError:
                        d = None
                    if isinstance(d, dict) and d.get('type') == 'resize':
                        tt.pty_resize(d.get('rows'))
                        continue
                tt.pty_input(t)
    except (WebSocketDisconnect, RuntimeError, ApiError):
        pass
    finally:
        task.cancel()
        tt.pty_detach(q)
        try:
            await ws.close()
        except Exception:
            pass
