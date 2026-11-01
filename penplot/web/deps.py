"""FastAPI dependencies: app context + scope checks (+ CSRF for cookie auth)."""
from typing import Annotated

from fastapi import Depends, Request

from .auth import ANON, UNSAFE, Principal, origin_ok
from .errors import ApiError


def ctx(request: Request):
    return request.app.state.ctx


def principal(request: Request) -> Principal:
    from .auth import mark_remote
    host = request.client.host if request.client else ''
    p = getattr(request.state, 'principal', None)
    if p is not None:
        return mark_remote(p, request.headers, host)
    c = request.app.state.ctx
    p = c.auth.resolve(request.headers, request.cookies)
    request.state.principal = p
    return mark_remote(p, request.headers, host)


def check_request(c, request, p, scope):
    if not c.auth.has_admin():
        raise ApiError(423, 'setup_required', '请先完成初始化设置')
    if p.kind == 'none':
        raise ApiError(401, 'unauthenticated', '请先登录')
    if scope and not p.has(scope):
        raise ApiError(403, 'forbidden', '权限不足（需要 %s）' % scope, {'scope': scope})
    if p.kind == 'session' and request.method in UNSAFE:
        if request.headers.get('x-penplot') != '1':
            raise ApiError(403, 'csrf', '缺少 X-Penplot 请求头')
        if not origin_ok(request.headers, c.cfg):
            raise ApiError(403, 'csrf_origin', 'Origin 与 Host 不一致')


def need(scope):
    def dep(request: Request) -> Principal:
        c = request.app.state.ctx
        p = principal(request)
        check_request(c, request, p, scope)
        return p
    dep.__name__ = 'need_%s' % scope
    return dep


def need_lease():
    """control scope + machine control lease (holder or admin; free lease is auto-taken)."""
    base = need('control')

    def dep(request: Request) -> Principal:
        p = base(request)
        request.app.state.ctx.collab.check(p)
        return p
    dep.__name__ = 'need_lease'
    return dep


R = Annotated[Principal, Depends(need('read'))]
L = Annotated[Principal, Depends(need_lease())]
C = Annotated[Principal, Depends(need('control'))]
A = Annotated[Principal, Depends(need('admin'))]
Ctx = Annotated[object, Depends(ctx)]

__all__ = ['R', 'C', 'A', 'L', 'Ctx', 'need', 'principal', 'ctx', 'ANON', 'check_request']
