from __future__ import annotations

from typing import Literal, Optional

from pydantic import Field

from .common import Model

Scope = Literal['read', 'control', 'admin']
Role = Literal['admin', 'operator', 'viewer']


class UserRef(Model):
    id: str
    username: str
    display_name: str = ''
    role: Role


class UserInfo(UserRef):
    disabled: bool = False
    created_at: float
    last_login: Optional[float] = None


class UserCreate(Model):
    username: str = Field(min_length=1, max_length=40, pattern=r'^[A-Za-z0-9_.\-\u4e00-\u9fff]+$')
    password: str = Field(min_length=10, max_length=200)
    role: Role = 'operator'
    display_name: Optional[str] = Field(None, max_length=60)


class UserPatch(Model):
    role: Optional[Role] = None
    disabled: Optional[bool] = None
    display_name: Optional[str] = Field(None, max_length=60)


class UserPasswordReset(Model):
    new: str = Field(min_length=10, max_length=200)


class AuthState(Model):
    setup_required: bool
    authenticated: bool
    user: Optional[str] = Field(None, description='username')
    user_info: Optional[UserRef] = None
    role: Optional[Role] = None
    csrf: bool = Field(True, description='unsafe requests with cookie auth must send header X-Penplot: 1')
    setup_code_required: bool = Field(True, description='false in dev mode (PENPLOT_DEV=1)')
    scopes: list[Scope] = []
    via: Optional[Literal['session', 'token']] = None
    dev: bool = False


class SetupRequest(Model):
    setup_code: Optional[str] = None
    username: str = Field('admin', min_length=1, max_length=40)
    display_name: Optional[str] = None
    password: str = Field(min_length=10, max_length=200)


class LoginRequest(Model):
    username: Optional[str] = Field(None, description="default: the only user, or 'admin'")
    password: str = Field(min_length=1, max_length=200)


class LoginResponse(Model):
    ok: bool = True
    expires_at: float


class PasswordChange(Model):
    old: str
    new: str = Field(min_length=10, max_length=200)


class SessionInfo(Model):
    id: str = Field(description='short id (first 16 hex of the stored hash)')
    ip: str = ''
    ua: str = ''
    created_at: float
    last_seen: float
    expires_at: float
    current: bool = False
    user_id: Optional[str] = None
    username: Optional[str] = None


class TokenCreate(Model):
    name: str = Field(min_length=1, max_length=80)
    scopes: list[Scope] = ['read']
    expires_days: Optional[int] = Field(None, ge=1, le=3650)


class TokenInfo(Model):
    id: str
    name: str
    scopes: list[Scope]
    user_id: Optional[str] = None
    username: Optional[str] = None
    created_at: float
    last_used: Optional[float] = None
    expires_at: Optional[float] = None


class TokenCreated(TokenInfo):
    token: str = Field(description='ppt_<id>_<secret>; shown once')


# ---------------------------------------------------------------- collaboration
class LeaseInfo(Model):
    held: bool
    holder: Optional[UserRef] = None
    since: Optional[float] = None
    last_active: Optional[float] = None
    online: bool = Field(False, description='holder has a WebSocket open')
    release_after_s: float = Field(60.0, description='auto-release after this long without WS/activity')
    reason: Optional[str] = None
    mine: Optional[bool] = Field(None, description='REST only: the caller holds it')
    expires_at: Optional[float] = Field(None, description='auto-release time while the holder is offline')


class LeaseRequest(Model):
    force: bool = Field(False, description='admin only: take it from the current holder')


class PresenceEntry(Model):
    conn_id: str
    user: UserRef
    page: Optional[str] = None
    project_id: Optional[str] = None
    element_id: Optional[str] = None
    since: float
    client: Optional[str] = None


class ElementLock(Model):
    element_id: str
    user: dict
    conn_id: str
    ts: float


class ProjectCollab(Model):
    project_id: str
    viewers: list[PresenceEntry]
    locks: list[ElementLock]
