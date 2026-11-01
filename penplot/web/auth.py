"""Auth: scrypt admin password, cookie sessions, API tokens, CSRF, login rate limit (03 §6)."""
import hashlib
import hmac
import logging
import os
import secrets
import threading
import time
from dataclasses import dataclass, field

from .db import jdump, jload
from .errors import ApiError

log = logging.getLogger('penplot.web.auth')

COOKIE = 'pp_session'
SCOPES = ('read', 'control', 'admin')
UNSAFE = ('POST', 'PUT', 'PATCH', 'DELETE')
SCRYPT = dict(n=2 ** 14, r=8, p=1)


# ---------------------------------------------------------------- hashing
def hash_password(pw, n=SCRYPT['n'], r=SCRYPT['r'], p=SCRYPT['p']):
    salt = os.urandom(16)
    h = hashlib.scrypt(pw.encode('utf-8'), salt=salt, n=n, r=r, p=p, dklen=64, maxmem=64 * 1024 * 1024)
    return 'scrypt$%d$%d$%d$%s$%s' % (n, r, p, salt.hex(), h.hex())


def verify_password(pw, stored):
    try:
        alg, n, r, p, salt, h = stored.split('$')
        if alg != 'scrypt':
            return False
        calc = hashlib.scrypt(pw.encode('utf-8'), salt=bytes.fromhex(salt), n=int(n), r=int(r),
                              p=int(p), dklen=len(bytes.fromhex(h)), maxmem=64 * 1024 * 1024)
        return hmac.compare_digest(calc, bytes.fromhex(h))
    except Exception:
        return False


def sha256(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


ROLES = ('admin', 'operator', 'viewer')
ROLE_SCOPES = {'admin': ('read', 'control', 'admin'), 'operator': ('read', 'control'), 'viewer': ('read',)}


@dataclass
class Principal:
    kind: str                     # session | token | none
    id: str = ''
    scopes: tuple = ()
    session_hash: str = ''
    user_id: str = ''
    username: str = ''
    role: str = ''
    display_name: str = ''
    extra: dict = field(default_factory=dict)

    def has(self, scope):
        return scope in self.scopes

    @property
    def is_admin(self):
        return self.role == 'admin'

    @property
    def actor(self):
        if self.username:
            return 'user:%s' % self.username + ('' if self.kind == 'session' else '(token %s)' % self.id[:8])
        return '%s:%s' % (self.kind, self.id[:12])

    def user_dict(self):
        return {'id': self.user_id, 'username': self.username, 'display_name': self.display_name or self.username,
                'role': self.role}


ANON = Principal('none')


# ---------------------------------------------------------------- rate limit
class LoginLimiter:
    """per IP 5 failures / 5 min -> lockout 30 s * 2^n (max 15 min);
    global 30 failures / h -> 15 min lock for everybody."""

    def __init__(self):
        self._ip = {}            # ip -> {'fails': [ts], 'locks': n, 'until': ts}
        self._global = []
        self._global_until = 0.0
        self._lock = threading.Lock()

    def check(self, ip, now=None):
        now = now or time.time()
        with self._lock:
            if now < self._global_until:
                return self._global_until - now
            st = self._ip.get(ip)
            if st and now < st['until']:
                return st['until'] - now
        return 0.0

    def fail(self, ip, now=None):
        now = now or time.time()
        with self._lock:
            st = self._ip.setdefault(ip, {'fails': [], 'locks': 0, 'until': 0.0})
            st['fails'] = [t for t in st['fails'] if now - t < 300] + [now]
            if len(st['fails']) >= 5:
                st['until'] = now + min(900.0, 30.0 * (2 ** st['locks']))
                st['locks'] += 1
                st['fails'] = []
            self._global = [t for t in self._global if now - t < 3600] + [now]
            if len(self._global) >= 30:
                self._global_until = now + 900.0
                self._global = []

    def success(self, ip):
        with self._lock:
            self._ip.pop(ip, None)


# ---------------------------------------------------------------- service
def _expand(scopes):
    scopes = set(scopes)
    if 'admin' in scopes:
        return set(SCOPES)
    if 'control' in scopes:
        return {'read', 'control'}
    return scopes & {'read'}


class AuthService:
    def __init__(self, db, cfg):
        self.db = db
        self.cfg = cfg
        self.limiter = LoginLimiter()
        self._has_users = None

    # -- setup --------------------------------------------------------
    @property
    def setup_code_path(self):
        return os.path.join(self.cfg.data_dir, 'setup-code')

    def has_admin(self):
        """True once first-run setup created a user (name kept for callers)."""
        if self._has_users:
            return True
        ok = (self.db.scalar('SELECT COUNT(*) FROM users') or 0) > 0
        self._has_users = ok
        return ok

    def ensure_setup_code(self):
        """Write the 8-digit setup code on first boot (not in dev mode)."""
        if self.has_admin() or self.cfg.dev:
            return None
        p = self.setup_code_path
        if os.path.exists(p):
            code = open(p).read().strip()
        else:
            code = '%08d' % secrets.randbelow(10 ** 8)
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as f:
                f.write(code + '\n')
        log.warning('first-run setup code: %s (also in %s)', code, p)
        return code

    def setup(self, code, password, username='admin', display_name=None):
        if self.has_admin():
            raise ApiError(409, 'already_setup', '管理员已设置')
        if not self.cfg.dev:
            p = self.setup_code_path
            want = open(p).read().strip() if os.path.exists(p) else None
            if not want or not code or not hmac.compare_digest(want, code.strip()):
                raise ApiError(403, 'bad_setup_code', '初始化码不正确')
        uid = self._insert_user(username or 'admin', password, 'admin', display_name or '管理员')
        self._has_users = True
        try:
            os.unlink(self.setup_code_path)
        except OSError:
            pass
        self.db.audit('setup', 'admin_setup', {'username': username})
        return uid

    def reset_password(self, password=None, username=None):
        """CLI: set a new password for `username` (default: the first admin);
        all of that user's sessions are revoked. Returns (username, password)."""
        if username:
            u = self.db.one('SELECT * FROM users WHERE username=?', (username,))
        else:
            u = self.db.one("SELECT * FROM users WHERE role='admin' ORDER BY created_at LIMIT 1")
        if not u:
            raise ApiError(404, 'not_found', '用户不存在')
        password = password or secrets.token_urlsafe(9)
        self.db.execute('UPDATE users SET pw_hash=?, pw_changed_at=?, disabled=0 WHERE id=?',
                        (hash_password(password), time.time(), u['id']))
        self.db.execute('DELETE FROM sessions WHERE user_id=?', (u['id'],))
        self.db.audit('cli', 'password_reset', {'username': u['username']})
        return u['username'], password

    # -- users ------------------------------------------------------------
    def _insert_user(self, username, password, role, display_name=None):
        if role not in ROLES:
            raise ApiError(400, 'bad_role', '角色必须是 admin / operator / viewer')
        if self.db.one('SELECT id FROM users WHERE username=?', (username,)):
            raise ApiError(409, 'username_taken', '用户名已存在')
        uid = 'u' + secrets.token_hex(4)
        now = time.time()
        self.db.execute('INSERT INTO users(id,username,display_name,role,pw_hash,created_at,pw_changed_at) '
                        'VALUES(?,?,?,?,?,?,?)', (uid, username, display_name, role, hash_password(password), now, now))
        return uid

    @staticmethod
    def _user_out(r):
        return {'id': r['id'], 'username': r['username'], 'display_name': r['display_name'] or r['username'],
                'role': r['role'], 'disabled': bool(r['disabled']), 'created_at': r['created_at'],
                'last_login': r['last_login']}

    def list_users(self):
        return [self._user_out(r) for r in self.db.all('SELECT * FROM users ORDER BY created_at')]

    def get_user(self, uid):
        r = self.db.one('SELECT * FROM users WHERE id=?', (uid,))
        if not r:
            raise ApiError(404, 'not_found', '用户不存在')
        return self._user_out(r)

    def create_user(self, username, password, role, display_name=None, actor='-'):
        uid = self._insert_user(username, password, role, display_name)
        self.db.audit(actor, 'user_create', {'username': username, 'role': role})
        return self.get_user(uid)

    def _admins_left(self, excluding):
        return self.db.scalar("SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0 AND id<>?",
                              (excluding,)) or 0

    def patch_user(self, uid, role=None, disabled=None, display_name=None, actor='-'):
        u = self.get_user(uid)
        if role is not None and role not in ROLES:
            raise ApiError(400, 'bad_role', '角色必须是 admin / operator / viewer')
        demote = (role is not None and role != 'admin') or disabled
        if u['role'] == 'admin' and demote and not self._admins_left(uid):
            raise ApiError(409, 'last_admin', '至少要保留一个可用的管理员')
        if role is not None:
            self.db.execute('UPDATE users SET role=? WHERE id=?', (role, uid))
        if disabled is not None:
            self.db.execute('UPDATE users SET disabled=? WHERE id=?', (1 if disabled else 0, uid))
            if disabled:
                self.db.execute('DELETE FROM sessions WHERE user_id=?', (uid,))
        if display_name is not None:
            self.db.execute('UPDATE users SET display_name=? WHERE id=?', (display_name[:60] or None, uid))
        self.db.audit(actor, 'user_update', {'id': uid, 'role': role, 'disabled': disabled})
        return self.get_user(uid)

    def admin_set_password(self, uid, new, actor='-'):
        self.get_user(uid)
        self.db.execute('UPDATE users SET pw_hash=?, pw_changed_at=? WHERE id=?', (hash_password(new), time.time(), uid))
        self.db.execute('DELETE FROM sessions WHERE user_id=?', (uid,))
        self.db.audit(actor, 'user_password_reset', {'id': uid})

    def delete_user(self, uid, actor='-'):
        u = self.get_user(uid)
        if u['role'] == 'admin' and not self._admins_left(uid):
            raise ApiError(409, 'last_admin', '至少要保留一个可用的管理员')
        self.db.execute('DELETE FROM sessions WHERE user_id=?', (uid,))
        self.db.execute('DELETE FROM api_tokens WHERE user_id=?', (uid,))
        self.db.execute('DELETE FROM users WHERE id=?', (uid,))
        self.db.audit(actor, 'user_delete', {'username': u['username']})

    # -- login / sessions ----------------------------------------------
    def ttl(self):
        h = self.db.get_setting('session_ttl_h', 720)
        try:
            return float(h) * 3600
        except (TypeError, ValueError):
            return 720 * 3600

    def login(self, password, ip='', ua='', username=None):
        wait = self.limiter.check(ip)
        if wait > 0:
            raise ApiError(429, 'rate_limited', '尝试次数过多，请 %d 秒后再试' % int(wait + 1),
                           {'retry_after_s': int(wait + 1)}, headers={'Retry-After': str(int(wait + 1))})
        if username:
            row = self.db.one('SELECT * FROM users WHERE username=?', (username,))
        else:
            rows = self.db.all('SELECT * FROM users')
            row = rows[0] if len(rows) == 1 else next((r for r in rows if r['username'].lower() == 'admin'), None)
        if not row or row['disabled'] or not verify_password(password, row['pw_hash']):
            self.limiter.fail(ip)
            self.db.audit('ip:%s' % ip, 'login_fail', {'username': username})
            raise ApiError(401, 'bad_password', '用户名或密码错误')
        self.limiter.success(ip)
        self.db.execute('UPDATE users SET last_login=? WHERE id=?', (time.time(), row['id']))
        return self.new_session(row['id'], ip, ua)

    def new_session(self, user_id, ip='', ua=''):
        tok = secrets.token_urlsafe(32)
        now = time.time()
        exp = now + self.ttl()
        self.db.execute('INSERT INTO sessions(id_hash,created_at,last_seen,expires_at,ip,ua,user_id) '
                        'VALUES(?,?,?,?,?,?,?)', (sha256(tok), now, now, exp, ip, (ua or '')[:200], user_id))
        return tok, exp

    def _principal(self, kind, pid, u, scopes, session_hash=''):
        return Principal(kind, pid, tuple(s for s in SCOPES if s in scopes), session_hash=session_hash,
                         user_id=u['id'], username=u['username'], role=u['role'],
                         display_name=u['display_name'] or u['username'])

    def session(self, token):
        if not token:
            return None
        h = sha256(token)
        row = self.db.one('SELECT s.*, u.id AS uid, u.username, u.role, u.display_name, u.disabled '
                          'FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?', (h,))
        now = time.time()
        if not row or row['disabled']:
            return None
        if row['expires_at'] < now:
            self.db.execute('DELETE FROM sessions WHERE id_hash=?', (h,))
            return None
        if now - row['last_seen'] > 600:      # sliding expiry, throttled writes
            self.db.execute('UPDATE sessions SET last_seen=?, expires_at=? WHERE id_hash=?',
                            (now, now + self.ttl(), h))
        u = {'id': row['uid'], 'username': row['username'], 'role': row['role'], 'display_name': row['display_name']}
        return self._principal('session', h[:16], u, ROLE_SCOPES.get(row['role'], ()), session_hash=h)

    def logout(self, session_hash):
        self.db.execute('DELETE FROM sessions WHERE id_hash=?', (session_hash,))

    def list_sessions(self, current_hash='', user_id=None):
        q = 'SELECT s.*, u.username FROM sessions s LEFT JOIN users u ON u.id=s.user_id WHERE s.expires_at>?'
        args = [time.time()]
        if user_id:
            q += ' AND s.user_id=?'
            args.append(user_id)
        rows = self.db.all(q + ' ORDER BY s.last_seen DESC', args)
        return [{'id': r['id_hash'][:16], 'ip': r['ip'] or '', 'ua': r['ua'] or '',
                 'created_at': r['created_at'], 'last_seen': r['last_seen'], 'user_id': r['user_id'],
                 'username': r['username'], 'expires_at': r['expires_at'], 'current': r['id_hash'] == current_hash}
                for r in rows]

    def revoke_session(self, short_id, user_id=None):
        q = 'DELETE FROM sessions WHERE substr(id_hash,1,16)=?'
        args = [short_id]
        if user_id:
            q += ' AND user_id=?'
            args.append(user_id)
        return self.db.execute(q, args).rowcount > 0

    def change_password(self, user_id, old, new, keep_hash):
        row = self.db.one('SELECT pw_hash FROM users WHERE id=?', (user_id,))
        if not row or not verify_password(old, row['pw_hash']):
            raise ApiError(403, 'bad_password', '原密码错误')
        self.db.execute('UPDATE users SET pw_hash=?, pw_changed_at=? WHERE id=?',
                        (hash_password(new), time.time(), user_id))
        self.db.execute('DELETE FROM sessions WHERE user_id=? AND id_hash<>?', (user_id, keep_hash or ''))
        self.db.audit('user:%s' % user_id, 'password_change')

    # -- tokens -----------------------------------------------------------
    def create_token(self, user_id, name, scopes, expires_days=None, role=None):
        tid = secrets.token_hex(4)
        secret = secrets.token_urlsafe(24)
        token = 'ppt_%s_%s' % (tid, secret)
        now = time.time()
        exp = now + expires_days * 86400 if expires_days else None
        allowed = set(ROLE_SCOPES.get(role, SCOPES)) if role else set(SCOPES)
        scopes = [s for s in SCOPES if s in set(scopes) and s in allowed] or ['read']
        self.db.execute('INSERT INTO api_tokens(id,name,hash,scopes,created_at,expires_at,user_id) '
                        'VALUES(?,?,?,?,?,?,?)', (tid, name, sha256(token), ','.join(scopes), now, exp, user_id))
        self.db.audit('user:%s' % user_id, 'token_create', {'id': tid, 'name': name, 'scopes': scopes})
        return {'id': tid, 'name': name, 'scopes': scopes, 'created_at': now, 'last_used': None,
                'expires_at': exp, 'token': token, 'user_id': user_id}

    def list_tokens(self, user_id=None):
        q = 'SELECT t.*, u.username FROM api_tokens t LEFT JOIN users u ON u.id=t.user_id'
        args = []
        if user_id:
            q += ' WHERE t.user_id=?'
            args.append(user_id)
        return [{'id': r['id'], 'name': r['name'], 'scopes': r['scopes'].split(','),
                 'created_at': r['created_at'], 'last_used': r['last_used'], 'expires_at': r['expires_at'],
                 'user_id': r['user_id'], 'username': r['username']}
                for r in self.db.all(q + ' ORDER BY t.created_at DESC', args)]

    def revoke_token(self, tid, user_id=None):
        q = 'DELETE FROM api_tokens WHERE id=?'
        args = [tid]
        if user_id:
            q += ' AND user_id=?'
            args.append(user_id)
        return self.db.execute(q, args).rowcount > 0

    def token(self, raw):
        if not raw or not raw.startswith('ppt_'):
            return None
        parts = raw.split('_', 2)
        if len(parts) != 3:
            return None
        row = self.db.one('SELECT t.*, u.id AS uid, u.username, u.role, u.display_name, u.disabled '
                          'FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.id=?', (parts[1],))
        if not row or row['disabled'] or not hmac.compare_digest(row['hash'], sha256(raw)):
            return None
        now = time.time()
        if row['expires_at'] and row['expires_at'] < now:
            return None
        if not row['last_used'] or now - row['last_used'] > 600:
            self.db.execute('UPDATE api_tokens SET last_used=? WHERE id=?', (now, row['id']))
        scopes = _expand(row['scopes'].split(',')) & set(ROLE_SCOPES.get(row['role'], ()))
        u = {'id': row['uid'], 'username': row['username'], 'role': row['role'], 'display_name': row['display_name']}
        return self._principal('token', row['id'], u, scopes)

    # -- request resolution ------------------------------------------------
    def resolve(self, headers, cookies):
        authz = headers.get('authorization', '')
        if authz.lower().startswith('bearer '):
            p = self.token(authz[7:].strip())
            if p is None:
                raise ApiError(401, 'bad_token', 'API Token 无效或已过期')
            return p
        tok = cookies.get(COOKIE)
        if tok:
            p = self.session(tok)
            if p:
                return p
        return ANON


def origin_ok(headers, cfg):
    """Origin/Referer must match Host (or the dev allowlist). Missing both
    is accepted (non-browser clients); browsers always send Origin on
    unsafe cross-origin requests."""
    host = headers.get('host', '')
    origin = headers.get('origin') or ''
    if not origin:
        ref = headers.get('referer') or ''
        if not ref:
            return True
        from urllib.parse import urlsplit
        u = urlsplit(ref)
        origin = '%s://%s' % (u.scheme, u.netloc)
    if origin == 'null':
        return False
    from urllib.parse import urlsplit
    if urlsplit(origin).netloc == host:
        return True
    if cfg.dev and origin in cfg.dev_origins:
        return True
    return False


def jlist(s):
    return jload(s, []) or []


__all__ = ['AuthService', 'Principal', 'ANON', 'ROLES', 'ROLE_SCOPES', 'COOKIE', 'SCOPES', 'UNSAFE', 'origin_ok',
           'hash_password', 'verify_password', 'jdump']


# ---------------------------------------------------------------- reverse proxy (Cloudflare Tunnel)
_LOOPBACK = ('127.0.0.1', '::1', 'localhost')


def via_tunnel(headers, client_host):
    """True when the request came through the local cloudflared tunnel.

    cloudflared connects from loopback and always adds CF-Connecting-IP. The
    header is only trusted from loopback, so a LAN client cannot forge it."""
    return (client_host or '') in _LOOPBACK and bool(headers.get('cf-connecting-ip'))


def client_ip(request):
    """Real client IP: CF-Connecting-IP behind the tunnel, else the socket peer
    (login rate limiting must not lump every remote user under 127.0.0.1)."""
    host = request.client.host if request.client else ''
    if via_tunnel(request.headers, host):
        return request.headers.get('cf-connecting-ip', '').strip()[:64] or host
    return host


def is_https(request, cfg):
    """HTTPS as seen by the browser (direct TLS, or TLS terminated by the tunnel)."""
    if getattr(cfg, 'tls_cert', None):
        return True
    host = request.client.host if request.client else ''
    return host in _LOOPBACK and request.headers.get('x-forwarded-proto', '').lower() == 'https'


def mark_remote(p, headers, client_host):
    """Tag a principal resolved for a request that came through the tunnel
    (internet). Terminal mode refuses remote principals."""
    if p is not None and p.kind != 'none':
        p.extra['remote'] = via_tunnel(headers, client_host)
    return p
