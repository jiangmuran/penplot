"""WebSocket /api/v1/ws (03 §5)."""
import asyncio
import json
import logging
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..auth import COOKIE, origin_ok
from ..errors import ApiError
from ..events import ALL_TOPICS

log = logging.getLogger('penplot.web.ws')
router = APIRouter()


def _auth(ws, c):
    """-> (principal|None, subprotocol, refresh) ; refresh() re-resolves the
    credential so a disabled/demoted user or revoked session loses control
    without reconnecting (P15)."""
    from ..auth import mark_remote
    host = ws.client.host if ws.client else ''

    def m(p):
        return mark_remote(p, ws.headers, host)
    protos = [p.strip() for p in ws.headers.get('sec-websocket-protocol', '').split(',') if p.strip()]
    chosen = 'penplot.v1' if 'penplot.v1' in protos else None
    for p in protos:
        if p.startswith('bearer.'):
            raw = p[7:]
            return m(c.auth.token(raw)), chosen, (lambda: m(c.auth.token(raw)))
    if not origin_ok(ws.headers, c.cfg):
        return None, chosen, (lambda: None)
    tok = ws.cookies.get(COOKIE)
    return (m(c.auth.session(tok)) if tok else None), chosen, (lambda: m(c.auth.session(tok)) if tok else None)


def _no_nan(v):
    raise ValueError('NaN/Infinity not allowed')


MAX_MSG = 64 * 1024
RATE = 20.0           # messages per second (token bucket)


@router.websocket('/ws')
async def ws_endpoint(ws: WebSocket):
    c = ws.app.state.ctx
    p, proto, refresh = _auth(ws, c)
    await ws.accept(subprotocol=proto)
    if not c.auth.has_admin():
        await ws.close(code=4423, reason='setup_required')
        return
    if p is None:
        await ws.close(code=4401, reason='unauthenticated')
        return
    sub = c.bus.subscribe()
    sub.user = p.user_dict()
    sub.client = (ws.headers.get('user-agent') or '')[:40]
    sub.last_jog = 0.0
    c.collab.joined(sub)
    seq = 0
    state = {'p': p, 'closing': False}
    inbox = asyncio.Queue(maxsize=64)

    async def send(msg):
        nonlocal seq
        seq += 1
        msg = {k: v for k, v in msg.items() if not k.startswith('_')}
        msg['seq'] = seq
        msg.setdefault('ts', time.time())
        await asyncio.wait_for(ws.send_text(json.dumps(msg, ensure_ascii=False, default=str)), 5.0)

    async def sender():
        while True:
            await sub.wake.wait()
            for m in sub.drain():
                await send(m)

    def fresh():
        np = refresh()
        if np is None:
            state['closing'] = True
            raise ApiError(401, 'unauthenticated', '登录已失效或账号被停用')
        state['p'] = np
        sub.user = np.user_dict()
        return np

    def ack(cid, ok, res=None, err=None):
        if cid is not None:
            sub.offer({'type': 'ack', 'id': str(cid), 'ok': ok, 'result': res, 'error': err})

    async def handle(msg):
        t = msg.get('type')
        cid = msg.get('id')
        try:
            if t == 'subscribe':
                topics = set(msg.get('topics') or []) & ALL_TOPICS
                sub.topics = topics | {'notice', 'attention'}
                return
            if t == 'ping':
                sub.offer({'type': 'pong', 't': msg.get('t') if isinstance(msg.get('t'), (int, float)) else None})
                return
            if t == 'presence':
                now = time.time()
                if now - getattr(sub, '_last_presence', 0.0) < 1.0:
                    sub._pending_presence = msg        # coalesce
                    return
                sub._last_presence = now
                c.collab.update_presence(sub, _s(msg.get('page')), _s(msg.get('project_id')),
                                         _s(msg.get('element_id')), _s(msg.get('client')))
                return
            if isinstance(t, str) and t.startswith('studio.'):
                pp = fresh()
                c.collab.relay_studio(sub, pp, t, msg.get('data'))
                return
            pp = fresh()
            if t in ('lock', 'unlock'):
                if not pp.has('control'):
                    raise ApiError(403, 'forbidden', '只读用户不能锁定元素')
                fn = c.collab.lock if t == 'lock' else c.collab.unlock
                fn(sub, str(msg.get('project_id') or ''), str(msg.get('element_id') or ''))
                ack(cid, True)
                return
            if t == 'tt_keys':
                # P2: identical to REST /teletype/type: control scope + lease
                if not pp.has('control'):
                    raise ApiError(403, 'forbidden', '只读用户不能打字')
                c.collab.check(pp)
                data = msg.get('data')
                if not isinstance(data, str) or len(data) > 20000:
                    raise ApiError(422, 'validation_error', 'data 必须是字符串（≤20000）')
                tt = c.teletype
                if tt.session is not None and tt.session.mode == 'term':
                    tt._check_terminal(pp)
                tt.keys(data, pp)
                ack(cid, True)
                return
            if t == 'cmd':
                op = msg.get('op')
                if op != 'estop' and not pp.has('control'):
                    raise ApiError(403, 'forbidden', '只读用户只能急停')
                args = msg.get('args') or {}
                if not isinstance(args, dict):
                    raise ApiError(422, 'validation_error', 'args 必须是对象')
                if op == 'jog':
                    sub.last_jog = time.time()
                    c.machine.last_ws_jog = (sub.id, sub.last_jog)
                res = await c.ws_command(op, args, actor=pp.actor, principal=pp)
                if hasattr(res, 'model_dump'):
                    res = res.model_dump()
                ack(cid or '', True, res if isinstance(res, dict) else {'value': res})
                return
        except ApiError as e:
            ack(cid if cid is not None else (t or ''), False, err=e.body()['error'])
        except Exception as e:  # noqa
            log.exception('ws %s', t)
            ack(cid if cid is not None else (t or ''), False,
                err={'code': 'internal', 'message': '服务器内部错误', 'detail': str(e)[:200]})

    async def worker():
        # P8/P21: one message at a time per socket (jog and jog_cancel stay ordered)
        while True:
            m = await inbox.get()
            await handle(m)
            pend = getattr(sub, '_pending_presence', None)
            if pend is not None and time.time() - getattr(sub, '_last_presence', 0.0) >= 1.0:
                sub._pending_presence = None
                await handle(pend)

    stask = wtask = None
    tokens, last = RATE, time.time()
    try:
        await send({'type': 'hello', 'server_version': c.version, 'conn_id': sub.id,
                    'snapshot': c.snapshot()})
        stask = asyncio.create_task(sender())
        wtask = asyncio.create_task(worker())
        while not state['closing']:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), 45.0)
            except asyncio.TimeoutError:
                sub.offer({'type': 'pong', 't': None})
                continue
            if len(raw) > MAX_MSG:
                continue
            try:
                msg = json.loads(raw, parse_constant=_no_nan)
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get('type') == 'cmd' and msg.get('op') == 'estop':
                await handle(msg)      # never queued, never rate limited
                continue
            now = time.time()
            tokens = min(RATE, tokens + (now - last) * RATE)
            last = now
            if tokens < 1.0:
                if msg.get('id') is not None:
                    sub.offer({'type': 'ack', 'id': str(msg.get('id')), 'ok': False,
                               'error': {'code': 'rate_limited', 'message': '消息太频繁', 'detail': None}})
                continue
            tokens -= 1.0
            try:
                inbox.put_nowait(msg)
            except asyncio.QueueFull:
                pass
            if stask.done():
                break
    except (WebSocketDisconnect, RuntimeError, asyncio.TimeoutError):
        pass
    except Exception:
        log.exception('ws')
    finally:
        c.bus.unsubscribe(sub)
        c.collab.left(sub)
        # jog deadman: the client that was jogging went away -> cancel motion
        if time.time() - sub.last_jog < 3.0:
            try:
                c.machine.jog_cancel()
            except Exception:
                pass
        for t in (stask, wtask):
            if t:
                t.cancel()
        try:
            await ws.close(code=4401 if state['closing'] else (1013 if stask and stask.done() else 1000))
        except Exception:
            pass


def _s(v):
    return str(v)[:120] if v is not None else None
