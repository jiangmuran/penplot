"""ASGI guard (P9): reject unsafe /api requests before their body is read when
unauthenticated, and enforce per-route body limits (Content-Length and a
running count for chunked bodies). Also sets security headers (P11)."""
import json
from http.cookies import SimpleCookie

from .auth import COOKIE, UNSAFE
from .errors import ApiError

MB = 1024 * 1024
LIMITS = [  # (path prefix, max bytes); first match wins
    ('/api/v1/projects/import', 210 * MB),
    ('/api/v1/import/gcode', 51 * MB),
    ('/api/v1/import/', 21 * MB),
    ('/api/v1/fonts', 31 * MB),
    ('/api/v1/files', 101 * MB),
    ('/api/v1/profiles/import', 2 * MB),
]
DEFAULT_LIMIT = 1 * MB
AUTH_EXEMPT = ('/api/v1/auth/login', '/api/v1/auth/setup', '/api/v1/auth/logout')
SECURITY_HEADERS = [(b'x-content-type-options', b'nosniff'), (b'x-frame-options', b'DENY'),
                    (b'referrer-policy', b'same-origin')]


class _TooLarge(Exception):
    pass


def limit_for(path):
    for pre, n in LIMITS:
        if path.startswith(pre):
            return n
    return DEFAULT_LIMIT


async def _reply(send, status, code, message, detail=None):
    body = json.dumps({'error': {'code': code, 'message': message, 'detail': detail}}, ensure_ascii=False).encode()
    await send({'type': 'http.response.start', 'status': status,
                'headers': [(b'content-type', b'application/json'), (b'content-length', str(len(body)).encode()),
                            (b'connection', b'close')] + SECURITY_HEADERS})
    await send({'type': 'http.response.body', 'body': body})


class BodyGuard:
    def __init__(self, app, get_ctx):
        self.app = app
        self.get_ctx = get_ctx

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        path = scope.get('path', '')
        method = scope.get('method', 'GET')

        async def send_h(msg):
            if msg['type'] == 'http.response.start':
                hs = list(msg.get('headers') or [])
                have = {k.lower() for k, _ in hs}
                hs += [(k, v) for k, v in SECURITY_HEADERS if k not in have]
                ctype = next((v for k, v in hs if k.lower() == b'content-type'), b'')
                if b'svg' in ctype and b'content-security-policy' not in have:
                    hs.append((b'content-security-policy', b"sandbox; default-src 'none'; style-src 'unsafe-inline'"))
                msg = dict(msg, headers=hs)
                started['v'] = True
            await send(msg)
        started = {'v': False}
        if not (path.startswith('/api/') and method in UNSAFE):
            return await self.app(scope, receive, send_h)
        headers = {k.decode('latin-1').lower(): v.decode('latin-1') for k, v in scope.get('headers') or []}
        limit = limit_for(path)
        try:
            clen = int(headers.get('content-length') or 0)
        except ValueError:
            clen = 0
        if clen > limit:
            return await _reply(send, 413, 'too_large', '请求体太大（上限 %d MB）' % max(1, limit // MB),
                                {'limit': limit})
        ctx = self.get_ctx()
        if ctx is not None and path not in AUTH_EXEMPT:
            cookies = {}
            if headers.get('cookie'):
                try:
                    sc = SimpleCookie()
                    sc.load(headers['cookie'])
                    cookies = {k: m.value for k, m in sc.items()}
                except Exception:
                    cookies = {}
            if not ctx.auth.has_admin():
                return await _reply(send, 423, 'setup_required', '请先完成初始化设置')
            try:
                p = ctx.auth.resolve(headers, cookies if COOKIE in cookies else {})
            except ApiError as e:
                return await _reply(send, e.status, e.code, e.message)
            if p.kind == 'none':
                return await _reply(send, 401, 'unauthenticated', '请先登录')
        seen = {'n': 0}

        async def recv():
            msg = await receive()
            if msg['type'] == 'http.request':
                seen['n'] += len(msg.get('body') or b'')
                if seen['n'] > limit:
                    raise _TooLarge()
            return msg
        try:
            await self.app(scope, recv, send_h)
        except _TooLarge:
            if not started['v']:
                await _reply(send, 413, 'too_large', '请求体太大（上限 %d MB）' % max(1, limit // MB), {'limit': limit})
