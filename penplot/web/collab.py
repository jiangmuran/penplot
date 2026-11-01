"""Multi-user collaboration: presence, machine control lease, soft element locks."""
import asyncio
import logging
import time

from .errors import ApiError

log = logging.getLogger('penplot.web.collab')
LOCK_TTL = 120.0


class Collab:
    def __init__(self, ctx):
        self.ctx = ctx
        self.bus = ctx.bus
        self.lease = None            # {user_id, username, display_name, since, last_active, reason}
        self.locks = {}              # project_id -> {element_id: {user_id, username, conn_id, ts}}
        self._ws_gone = {}           # user_id -> ts of last WS disconnect
        self._task = None

    def start(self):
        self._task = asyncio.create_task(self._ticker())

    async def stop(self):
        if self._task:
            self._task.cancel()

    # ------------------------------------------------------------ presence
    def _user_subs(self, user_id):
        return [s for s in self.bus.subs if getattr(s, 'user', None) and s.user['id'] == user_id]

    def presence(self, project_id=None):
        out = []
        for s in list(self.bus.subs):
            u = getattr(s, 'user', None)
            if not u:
                continue
            if project_id and s.project_id != project_id:
                continue
            out.append({'conn_id': s.id, 'user': u, 'page': s.page, 'project_id': s.project_id,
                        'element_id': s.element_id, 'since': s.since, 'client': s.client})
        out.sort(key=lambda e: e['since'])
        return out

    def publish_presence(self):
        self.bus.publish('presence', {'online': self.presence()})

    def joined(self, sub):
        self._ws_gone.pop(sub.user['id'], None)
        self.publish_presence()

    def left(self, sub):
        u = getattr(sub, 'user', None)
        if u and not [s for s in self._user_subs(u['id']) if s is not sub]:
            self._ws_gone[u['id']] = time.time()
        changed = []
        for pid, locks in list(self.locks.items()):
            for eid, l in list(locks.items()):
                if l['conn_id'] == sub.id:
                    del locks[eid]
                    changed.append(pid)
        for pid in set(changed):
            self._publish_locks(pid)
        self.publish_presence()

    def update_presence(self, sub, page=None, project_id=None, element_id=None, client=None):
        old = sub.project_id
        sub.page = page
        sub.project_id = project_id
        sub.element_id = element_id
        if client:
            sub.client = str(client)[:40]
        self.publish_presence()
        if project_id and project_id != old:
            # the newcomer needs the current locks of that project
            sub.offer({'type': 'locks', 'data': {'project_id': project_id, 'locks': self.lock_list(project_id)}})

    # ------------------------------------------------------------ lease
    def lease_info(self):
        l = self.lease
        if not l:
            return {'held': False, 'holder': None, 'since': None, 'last_active': None, 'online': False,
                    'release_after_s': self.release_after()}
        online = bool(self._user_subs(l['user_id']))
        exp = None if online else max(l['last_active'], self._ws_gone.get(l['user_id'], 0.0)) + self.release_after()
        return {'held': True, 'holder': {'id': l['user_id'], 'username': l['username'], 'user': l['username'],
                                         'display_name': l['display_name'], 'role': l['role'], 'since': l['since']},
                'since': l['since'], 'last_active': l['last_active'], 'online': online, 'expires_at': exp,
                'release_after_s': self.release_after()}

    def release_after(self):
        try:
            return float(self.ctx.settings.value('lease_release_s', 60.0))
        except (TypeError, ValueError):
            return 60.0

    def _set(self, p, reason):
        now = time.time()
        self.lease = {'user_id': p.user_id, 'username': p.username, 'display_name': p.display_name,
                      'role': p.role, 'since': now, 'last_active': now}
        self.ctx.db.audit(p.actor, 'lease_take', {'reason': reason})
        self._publish_lease(reason)

    def _publish_lease(self, reason=''):
        d = self.lease_info()
        d['reason'] = reason
        self.bus.publish_threadsafe('lease', d)
        if d['held']:
            h = d['holder']
            self.ctx.attention('lease_taken', '%s 接管了机器控制权' % (h['display_name'] or h['username']),
                               'info', 'info', user_id=h['id'], reason=reason)
        else:
            self.ctx.attention('lease_released', '机器控制权已释放' + ('（持有者离线）' if reason == 'idle' else ''),
                               'info', 'info', reason=reason)

    def _cancel_motion(self):
        try:
            self.ctx.machine.jog_cancel()
        except Exception:
            pass

    def take(self, p, force=False):
        l = self.lease
        if l is None or l['user_id'] == p.user_id:
            if l is None:
                self._set(p, 'take')
            else:
                l['last_active'] = time.time()
            return self.lease_info()
        if force:
            if not p.is_admin:
                raise ApiError(403, 'forbidden', '只有管理员可以强制接管控制权')
            prev = l['username']
            self._cancel_motion()
            self._set(p, 'force')
            self.bus.publish_threadsafe('notice', {'level': 'warning', 'code': 'lease_taken',
                                                   'message': '%s 强制接管了机器控制权（原持有者 %s）'
                                                              % (p.username, prev)})
            return self.lease_info()
        raise ApiError(409, 'lease_held', '机器控制权在 %s 手上' % (l['display_name'] or l['username']),
                       {'holder': self.lease_info()['holder']})

    def release(self, p, reason='release'):
        l = self.lease
        if l is None:
            return self.lease_info()
        if l['user_id'] != p.user_id and not p.is_admin:
            raise ApiError(403, 'forbidden', '只有持有者或管理员可以释放控制权')
        self.lease = None
        self._cancel_motion()
        self.ctx.db.audit(p.actor, 'lease_release', {'holder': l['username']})
        self._publish_lease(reason)
        return self.lease_info()

    def check(self, p):
        """Motion/job control gate: holder or admin; a free lease is auto-taken."""
        if not p.has('control'):
            raise ApiError(403, 'forbidden', '只读用户不能操作机器（只能急停）')
        l = self.lease
        if l is None:
            if p.user_id:
                self._set(p, 'auto')
            return
        if l['user_id'] == p.user_id:
            l['last_active'] = time.time()
            return
        if p.is_admin:
            return
        raise ApiError(409, 'lease_held', '机器控制权在 %s 手上，请先申请' % (l['display_name'] or l['username']),
                       {'holder': self.lease_info()['holder']})

    async def _ticker(self):
        while True:
            await asyncio.sleep(2.0)
            try:
                self._tick()
            except Exception:
                log.exception('collab tick')

    def _tick(self, now=None):
        now = now or time.time()
        l = self.lease
        if l is not None and not self._user_subs(l['user_id']):
            gone = self._ws_gone.get(l['user_id'], 0.0)
            idle_since = max(gone, l['last_active'])
            if now - idle_since > self.release_after():
                self.lease = None
                self._cancel_motion()
                self.ctx.db.audit('system', 'lease_release', {'holder': l['username'], 'reason': 'idle'})
                self._publish_lease('idle')
        for pid, locks in list(self.locks.items()):
            stale = [eid for eid, x in locks.items() if now - x['ts'] > LOCK_TTL]
            for eid in stale:
                del locks[eid]
            if stale:
                self._publish_locks(pid)

    # ------------------------------------------------------------ element locks
    def lock_list(self, pid):
        return [{'element_id': eid, 'user': {'id': x['user_id'], 'username': x['username']},
                 'conn_id': x['conn_id'], 'ts': x['ts']} for eid, x in (self.locks.get(pid) or {}).items()]

    def _publish_locks(self, pid):
        self.bus.publish_threadsafe('locks', {'project_id': pid, 'locks': self.lock_list(pid)}, _project=pid)

    def lock(self, sub, pid, eid):
        locks = self.locks.setdefault(pid, {})
        cur = locks.get(eid)
        if cur and cur['user_id'] != sub.user['id'] and time.time() - cur['ts'] < LOCK_TTL:
            raise ApiError(409, 'element_locked', '%s 正在编辑这个元素' % cur['username'],
                           {'user': {'id': cur['user_id'], 'username': cur['username']}})
        locks[eid] = {'user_id': sub.user['id'], 'username': sub.user['username'], 'conn_id': sub.id,
                      'ts': time.time()}
        self._publish_locks(pid)

    def unlock(self, sub, pid, eid):
        locks = self.locks.get(pid) or {}
        cur = locks.get(eid)
        if cur and cur['user_id'] == sub.user['id']:
            del locks[eid]
            self._publish_locks(pid)

    def locked_by_other(self, pid, eid, user_id):
        cur = (self.locks.get(pid) or {}).get(eid)
        if cur and cur['user_id'] != user_id and time.time() - cur['ts'] < LOCK_TTL:
            return cur
        return None

    # ------------------------------------------------------------ studio relay
    STUDIO_TYPES = {'studio.presence', 'studio.patch', 'studio.saved', 'studio.bye'}

    def relay_studio(self, sub, p, t, data):
        """Relay a studio collaboration message to the OTHER sockets viewing the same
        project (cross-device). Viewers may send presence/bye only. The server adds
        an authoritative `from` {user, conn_id}; the payload is otherwise opaque."""
        if t not in self.STUDIO_TYPES:
            raise ApiError(400, 'bad_type', '未知的 studio 消息 %s' % t)
        if not isinstance(data, dict) or not isinstance(data.get('project_id'), str):
            raise ApiError(422, 'validation_error', 'studio 消息需要 data.project_id')
        if t in ('studio.patch', 'studio.saved') and not p.has('control'):
            raise ApiError(403, 'forbidden', '只读用户不能修改工程')
        pid = data['project_id'][:64]
        if t == 'studio.presence' and sub.project_id != pid:
            sub.project_id = pid                    # route project/locks/studio messages to this socket
            self.publish_presence()
        elif t == 'studio.bye' and sub.project_id == pid:
            sub.project_id = None
        out = dict(data)
        out['from'] = {'user': p.user_dict(), 'conn_id': sub.id}
        msg = {'type': t, 'data': out, '_project': pid, '_topic': 'project'}
        for s in list(self.bus.subs):
            if s is not sub:
                s.offer(msg)

    # ------------------------------------------------------------ project changes
    def project_changed(self, pid, rev, p, kind, patch=None, conn_id=None):
        self.bus.publish_threadsafe('project', {'project_id': pid, 'rev': rev, 'kind': kind,
                                                'by': p.user_dict() if p else None, 'conn_id': conn_id,
                                                'patch': patch}, _project=pid)
