"""Machine profiles (MachineConfig docs) and app settings."""
import copy
import json
import os
import secrets
import time

from ..settings import MachineConfig, machine_config_to_dict
from .db import jdump, jload
from .errors import ApiError, not_found

DEFAULT_CONNECTION = {'port': '/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0', 'baud': 115200,
                      'auto_connect': True, 'reset_on_connect': False}

DEFAULT_SETTINGS = {'default_font': None, 'batch_auto_advance': False, 'pause_on_client_loss_s': 120.0,
                    'poll_hz': 4.0, 'session_ttl_h': 720.0, 'eta_factor': 1.0, 'default_paper': 'a4-normal',
                    'lease_release_s': 60.0,
                    'teletype': {'terminal_enabled': False, 'terminal_user': None, 'terminal_shell': None},
                    'ui': {}}


def deep_merge(a, b):
    out = copy.deepcopy(a)
    for k, v in (b or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def normalize_doc(doc):
    """Fill MachineConfig defaults + web fields; unknown keys are kept."""
    from .schemas import ProfileDoc
    base = machine_config_to_dict(MachineConfig(machine_type=(doc or {}).get('type', 'Grbl')))
    d = deep_merge(base, doc or {})
    d.setdefault('connection', {})
    d['connection'] = deep_merge(DEFAULT_CONNECTION, d['connection'])
    d.setdefault('work_area', {'w_mm': 0.0, 'h_mm': 0.0})
    d.setdefault('print_defaults', {})
    from .schemas.common import check_gcode_template
    adv = d.get('advanced') or {}
    for k in ('startGcode', 'endGcode', 'macro1', 'macro2', 'macro3'):
        if adv.get(k):
            try:
                check_gcode_template(str(adv[k]))
            except ValueError as e:
                raise ApiError(400, 'unsafe_gcode', 'advanced.%s %s' % (k, e))
    return ProfileDoc.model_validate(d).model_dump(exclude_none=False)


class Profiles:
    def __init__(self, ctx):
        self.ctx = ctx
        self.db = ctx.db

    def seed(self, path):
        if self.db.scalar('SELECT COUNT(*) FROM profiles'):
            return
        doc = {}
        if path and os.path.exists(path):
            with open(path, encoding='utf-8') as f:
                doc = json.load(f)
        doc = normalize_doc(doc)
        self.db.execute('INSERT INTO profiles(id,name,is_active,doc,updated_at) VALUES(?,?,1,?,?)',
                        ('default', 'GRBL Z 笔', jdump(doc), time.time()))

    def _out(self, r):
        return {'id': r['id'], 'name': r['name'], 'is_active': bool(r['is_active']),
                'doc': jload(r['doc'], {}), 'updated_at': r['updated_at']}

    def list(self):
        return [self._out(r) for r in self.db.all('SELECT * FROM profiles ORDER BY is_active DESC, name')]

    def get(self, pid):
        r = self.db.one('SELECT * FROM profiles WHERE id=?', (pid,))
        if not r:
            raise not_found('机器配置')
        return self._out(r)

    def active(self):
        r = self.db.one('SELECT * FROM profiles WHERE is_active=1')
        if not r:
            r = self.db.one('SELECT * FROM profiles LIMIT 1')
        if not r:
            raise ApiError(500, 'no_profile', '没有机器配置')
        return self._out(r)

    def create(self, name, doc=None, copy_from=None):
        if copy_from:
            d = self.get(copy_from)['doc']
        else:
            d = doc.model_dump() if doc is not None and hasattr(doc, 'model_dump') else (doc or {})
        d = normalize_doc(d)
        pid = 'm' + secrets.token_hex(4)
        self.db.execute('INSERT INTO profiles(id,name,is_active,doc,updated_at) VALUES(?,?,0,?,?)',
                        (pid, name[:80], jdump(d), time.time()))
        return self.get(pid)

    async def _apply_if_active(self, pid, old_doc):
        p = self.get(pid)
        if not p['is_active']:
            return p
        m = self.ctx.machine
        a = self.ctx.jobs.active
        if a is not None:
            # P16: the running job keeps its snapshot; the controller switches after it
            m.pending_profile = p
            return p
        m.load_profile(p)
        oc, nc = (old_doc or {}).get('connection') or {}, p['doc'].get('connection') or {}
        if m.connected and (oc.get('port') != nc.get('port') or oc.get('baud') != nc.get('baud')) and a is None:
            await m.disconnect()
            m.manual_disconnect = False
        return p

    async def update(self, pid, name, doc):
        old = self.get(pid)
        d = normalize_doc(doc.model_dump())
        self.db.execute('UPDATE profiles SET name=COALESCE(?,name), doc=?, updated_at=? WHERE id=?',
                        (name, jdump(d), time.time(), pid))
        return await self._apply_if_active(pid, old['doc'])

    async def patch(self, pid, name, doc_patch):
        old = self.get(pid)
        d = normalize_doc(deep_merge(old['doc'], doc_patch or {}))
        self.db.execute('UPDATE profiles SET name=COALESCE(?,name), doc=?, updated_at=? WHERE id=?',
                        (name, jdump(d), time.time(), pid))
        return await self._apply_if_active(pid, old['doc'])

    def delete(self, pid):
        p = self.get(pid)
        if p['is_active']:
            raise ApiError(409, 'profile_active', '当前使用中的配置不能删除')
        self.db.execute('DELETE FROM profiles WHERE id=?', (pid,))

    async def activate(self, pid, actor='-'):
        p = self.get(pid)
        if self.ctx.jobs.active is not None:
            raise ApiError(409, 'job_active', '任务进行中，不能切换配置')
        old = self.active()
        with self.db.tx():
            self.db.conn.execute('UPDATE profiles SET is_active=0')
            self.db.conn.execute('UPDATE profiles SET is_active=1 WHERE id=?', (pid,))
        self.db.audit(actor, 'profile_activate', {'id': pid})
        m = self.ctx.machine
        m.load_profile(self.get(pid))
        oc, nc = old['doc'].get('connection') or {}, p['doc'].get('connection') or {}
        if m.connected and (oc.get('port') != nc.get('port') or oc.get('baud') != nc.get('baud')):
            await m.disconnect()
            m.manual_disconnect = False
        return self.get(pid)

    ORIG_SECTIONS = {'settings': 'settings', 'grbl': 'grbl', 'marlin': 'marlin', 'ebb': 'ebb', 'kat': 'kat',
                     'k_at': 'kat', 'advanced': 'advanced', 'advancedview': 'advanced', 'advancedviewdata': 'advanced',
                     'axes': 'axes', 'axesdata': 'axes'}
    TYPE_OF = {'grbl': 'Grbl', 'marlin': 'Marlin', 'ebb': 'Ebb', 'kat': 'K_AT'}

    def import_original(self, files, name=None, machine_type=None):
        """The original software's per-section files (settings.json, Grbl.json,
        Marlin.json, EBB.json, KAT.json, AdvancedViewData.json, AxesData.json),
        given as several uploads or one zip -> one profile. Unknown keys are kept."""
        import io
        import zipfile
        items = []
        for fn, data in files:
            if data[:2] == b'PK':
                with zipfile.ZipFile(io.BytesIO(data)) as z:
                    if len(z.infolist()) > 50 or sum(i.file_size for i in z.infolist()) > 5 * 1024 * 1024:
                        raise ApiError(413, 'zip_bomb', '压缩包太大')
                    for n in z.namelist():
                        if n.lower().endswith('.json'):
                            items.append((os.path.basename(n), z.read(n)))
            else:
                items.append((fn, data))
        doc, found, types = {}, [], []
        for fn, data in items:
            try:
                d = json.loads(data.decode('utf-8-sig'))
            except Exception as e:
                raise ApiError(400, 'bad_profile', '%s 无法解析：%s' % (fn, e))
            if not isinstance(d, dict):
                continue
            stem = os.path.splitext(os.path.basename(fn))[0].lower().replace(' ', '')
            if 'type' in d and 'settings' in d and isinstance(d['settings'], dict):
                doc = deep_merge(doc, d)            # a full MachineConfig json
                found.append(fn)
                continue
            sec = self.ORIG_SECTIONS.get(stem)
            if sec is None:
                for k, v in self.ORIG_SECTIONS.items():
                    if stem.startswith(k):
                        sec = v
                        break
            if sec is None:
                raise ApiError(400, 'bad_profile', '不认识的配置文件：%s（支持 settings / Grbl / Marlin / EBB / KAT / '
                               'AdvancedViewData / AxesData .json）' % fn)
            doc[sec] = deep_merge(doc.get(sec) or {}, d)
            found.append(fn)
            if sec in self.TYPE_OF:
                types.append(self.TYPE_OF[sec])
        if not found:
            raise ApiError(400, 'bad_profile', '没有找到配置文件')
        if machine_type:
            doc['type'] = machine_type
        elif 'type' not in doc:
            doc['type'] = types[0] if len(set(types)) == 1 else 'Grbl'
        p = self.create(name or '导入的配置', doc)
        p['imported_files'] = found
        return p

    def import_json(self, filename, data):
        try:
            d = json.loads(data.decode('utf-8-sig'))
        except Exception as e:
            raise ApiError(400, 'bad_profile', '配置文件无法解析：%s' % e)
        if not isinstance(d, dict) or 'type' not in d and 'settings' not in d:
            raise ApiError(400, 'bad_profile', '不是 MachineConfig JSON')
        if 'doc' in d and isinstance(d['doc'], dict):
            name = d.get('name')
            d = d['doc']
        else:
            name = None
        return self.create(name or os.path.splitext(filename)[0], d)

    def export_json(self, pid):
        p = self.get(pid)
        return json.dumps(p['doc'], ensure_ascii=False, indent=2).encode('utf-8'), '%s.json' % p['name']


class AppSettingsStore:
    def __init__(self, db):
        self.db = db
        self._cache = None

    def get(self):
        if self._cache is None:
            d = dict(DEFAULT_SETTINGS)
            for r in self.db.all('SELECT key,value FROM settings'):
                d[r['key']] = jload(r['value'])
            self._cache = d
        return dict(self._cache)

    def value(self, key, default=None):
        v = self.get().get(key)
        return default if v is None else v

    def set_value(self, key, value):
        self.db.set_setting(key, value)
        self._cache = None

    def patch(self, body):
        from .schemas import AppSettings
        cur = self.get()
        merged = deep_merge(cur, body or {})
        AppSettings.model_validate(merged)
        for k, v in merged.items():
            if cur.get(k) != v or k in (body or {}):
                self.db.set_setting(k, v)
        self._cache = None
        return self.get()
