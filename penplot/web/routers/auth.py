from fastapi import APIRouter, Request, Response

from ..auth import COOKIE
from ..deps import A, R, principal
from ..errors import ApiError, not_found
from ..schemas import (AuthState, LoginRequest, LoginResponse, Ok, PasswordChange, SessionInfo,
                       SetupRequest, TokenCreate, TokenCreated, TokenInfo, UserCreate, UserInfo,
                       UserPasswordReset, UserPatch)

router = APIRouter(prefix='/auth', tags=['auth'])


def _ip(request):
    from ..auth import client_ip
    return client_ip(request)


def _set_cookie(resp, cfg, token, ttl, request=None):
    from ..auth import is_https
    secure = bool(cfg.tls_cert) or (request is not None and is_https(request, cfg))
    resp.set_cookie(COOKIE, token, max_age=int(ttl), httponly=True, samesite='strict', path='/',
                    secure=secure)


@router.get('/state', response_model=AuthState)
def auth_state(request: Request):
    c = request.app.state.ctx
    try:
        p = principal(request)
    except ApiError:
        p = None
    authed = p is not None and p.kind != 'none'
    return AuthState(setup_required=not c.auth.has_admin(), authenticated=authed,
                     user=p.username if authed else None, user_info=p.user_dict() if authed else None,
                     role=p.role if authed else None, csrf=True,
                     setup_code_required=not c.cfg.dev,
                     scopes=list(p.scopes) if authed else [],
                     via=p.kind if authed else None, dev=c.cfg.dev)


def _csrf_soft(request, c):
    from ..auth import origin_ok
    if request.headers.get('x-penplot') != '1':
        raise ApiError(403, 'csrf', '缺少 X-Penplot 请求头')
    if not origin_ok(request.headers, c.cfg):
        raise ApiError(403, 'csrf_origin', 'Origin 与 Host 不一致')


@router.post('/setup', response_model=Ok)
def setup(body: SetupRequest, request: Request, response: Response):
    c = request.app.state.ctx
    _csrf_soft(request, c)
    uid = c.auth.setup(body.setup_code, body.password, body.username, body.display_name)
    tok, exp = c.auth.new_session(uid, _ip(request), request.headers.get('user-agent', ''))
    _set_cookie(response, c.cfg, tok, exp - __import__('time').time(), request)
    return Ok()


@router.post('/login', response_model=LoginResponse,
             responses={401: {'model': None}, 429: {'model': None}})
def login(body: LoginRequest, request: Request, response: Response):
    c = request.app.state.ctx
    _csrf_soft(request, c)
    if not c.auth.has_admin():
        raise ApiError(423, 'setup_required', '请先完成初始化设置')
    tok, exp = c.auth.login(body.password, _ip(request), request.headers.get('user-agent', ''),
                            username=body.username)
    _set_cookie(response, c.cfg, tok, exp - __import__('time').time(), request)
    return LoginResponse(expires_at=exp)


@router.post('/logout', status_code=204)
def logout(request: Request):
    c = request.app.state.ctx
    p = principal(request)
    if p.kind == 'session':
        _csrf_soft(request, c)
        c.auth.logout(p.session_hash)
    resp = Response(status_code=204)
    resp.delete_cookie(COOKIE, path='/')
    return resp


@router.get('/me', response_model=UserInfo)
def me(request: Request, p: R):
    return request.app.state.ctx.auth.get_user(p.user_id)


@router.post('/password', status_code=204)
def change_password(body: PasswordChange, request: Request, p: R):
    """Change your own password (any role); revokes your other sessions."""
    c = request.app.state.ctx
    c.auth.change_password(p.user_id, body.old, body.new, p.session_hash)
    return Response(status_code=204)


@router.get('/sessions', response_model=list[SessionInfo])
def sessions(request: Request, p: R, all: int = 0):
    """Your sessions; admins may pass ?all=1."""
    uid = None if (all and p.is_admin) else p.user_id
    return request.app.state.ctx.auth.list_sessions(p.session_hash, uid)


@router.delete('/sessions/{sid}', status_code=204)
def revoke_session(sid: str, request: Request, p: R):
    if not request.app.state.ctx.auth.revoke_session(sid, None if p.is_admin else p.user_id):
        raise not_found('会话')
    return Response(status_code=204)


@router.get('/tokens', response_model=list[TokenInfo])
def tokens(request: Request, p: R, all: int = 0):
    """Your API tokens; admins may pass ?all=1."""
    return request.app.state.ctx.auth.list_tokens(None if (all and p.is_admin) else p.user_id)


@router.post('/tokens', response_model=TokenCreated, status_code=201)
def create_token(body: TokenCreate, request: Request, p: R):
    """Scopes are capped by your role (viewer: read; operator: read+control)."""
    if p.kind != 'session':
        raise ApiError(403, 'forbidden', '只能在登录会话中创建 Token')
    return request.app.state.ctx.auth.create_token(p.user_id, body.name, body.scopes, body.expires_days, p.role)


@router.delete('/tokens/{tid}', status_code=204)
def revoke_token(tid: str, request: Request, p: R):
    if not request.app.state.ctx.auth.revoke_token(tid, None if p.is_admin else p.user_id):
        raise not_found('Token')
    return Response(status_code=204)


# ---------------------------------------------------------------- users (admin)
users = APIRouter(prefix='/users', tags=['users'])


@users.get('', response_model=list[UserInfo])
def list_users(request: Request, p: R):
    """Everyone may see the user list (for presence); only admins change it."""
    return request.app.state.ctx.auth.list_users()


@users.post('', response_model=UserInfo, status_code=201)
def create_user(body: UserCreate, request: Request, p: A):
    return request.app.state.ctx.auth.create_user(body.username, body.password, body.role,
                                                  body.display_name, actor=p.actor)


@users.get('/{uid}', response_model=UserInfo)
def get_user(uid: str, request: Request, p: R):
    return request.app.state.ctx.auth.get_user(uid)


@users.patch('/{uid}', response_model=UserInfo)
def patch_user(uid: str, body: UserPatch, request: Request, p: A):
    return request.app.state.ctx.auth.patch_user(uid, body.role, body.disabled, body.display_name, actor=p.actor)


@users.post('/{uid}/password', status_code=204)
def reset_user_password(uid: str, body: UserPasswordReset, request: Request, p: A):
    """Admin password reset; revokes all of that user's sessions."""
    request.app.state.ctx.auth.admin_set_password(uid, body.new, actor=p.actor)
    return Response(status_code=204)


@users.delete('/{uid}', status_code=204)
def delete_user(uid: str, request: Request, p: A):
    if uid == p.user_id:
        raise ApiError(409, 'self_delete', '不能删除自己')
    request.app.state.ctx.auth.delete_user(uid, actor=p.actor)
    return Response(status_code=204)
