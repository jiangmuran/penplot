"""Papers, projects/templates, files library, imports."""
import base64
import copy
import hashlib
import io
import json
import logging
import os
import secrets
import shutil
import time
import zipfile

from ..layout import page_presets
from .db import jdump, jload
from .errors import ApiError, not_found

log = logging.getLogger('penplot.web.library')

_PRESET_IDS = ['a4-normal', 'a4-narrow', 'a4-moderate', 'a4-wide', 'a3-normal', 'a3-narrow', 'a3-moderate',
               'a3-wide', '16k-normal', '16k-narrow', '16k-moderate', '16k-wide']


def _id(prefix):
    return prefix + secrets.token_hex(4)


# ---------------------------------------------------------------- papers
class Papers:
    def __init__(self, db):
        self.db = db

    def seed(self):
        now = time.time()
        for pid, p in zip(_PRESET_IDS, page_presets()):
            doc = {'width_mm': p['pageWidth'], 'height_mm': p['pageHeight'],
                   'margins': {'l': p['leftGap'], 'r': p['rightGap'], 't': p['topGap'], 'b': p['bottomGap']},
                   'orientation': 'portrait', 'rotation': 0,
                   'ruling': {'line_num': p['lineNum'], 'line_gap': 0.0, 'line_gap_offset': 0.0, 'base_line': 1.0}}
            self.db.execute('INSERT OR REPLACE INTO papers(id,name,builtin,doc,updated_at) VALUES(?,?,1,?,?)',
                            (pid, p['name'], jdump(doc), now))

    def _out(self, r):
        d = jload(r['doc'], {})
        d.update({'id': r['id'], 'name': r['name'], 'builtin': bool(r['builtin'])})
        return d

    def list(self):
        return [self._out(r) for r in self.db.all('SELECT * FROM papers ORDER BY builtin DESC, rowid')]

    def get(self, pid):
        r = self.db.one('SELECT * FROM papers WHERE id=?', (pid,))
        if not r:
            raise not_found('纸张')
        return self._out(r)

    def create(self, body):
        pid = _id('pp')
        d = body.model_dump()
        name = d.pop('name')
        self.db.execute('INSERT INTO papers(id,name,builtin,doc,updated_at) VALUES(?,?,0,?,?)',
                        (pid, name, jdump(d), time.time()))
        return self.get(pid)

    def update(self, pid, body):
        p = self.get(pid)
        if p['builtin']:
            raise ApiError(409, 'builtin', '内置纸张不能修改，请另存')
        d = body.model_dump()
        name = d.pop('name')
        self.db.execute('UPDATE papers SET name=?, doc=?, updated_at=? WHERE id=?', (name, jdump(d), time.time(), pid))
        return self.get(pid)

    def delete(self, pid):
        p = self.get(pid)
        if p['builtin']:
            raise ApiError(409, 'builtin', '内置纸张不能删除')
        self.db.execute('DELETE FROM papers WHERE id=?', (pid,))

    def resolve(self, ref):
        """PaperRef dict -> paper dict."""
        ref = ref or {}
        if ref.get('spec'):
            return dict(ref['spec'])
        return self.get(ref.get('paper_id') or 'a4-normal')


# ---------------------------------------------------------------- files
KIND_BY_EXT = {'.gcode': 'gcode', '.nc': 'gcode', '.gc': 'gcode', '.ngc': 'gcode', '.tap': 'gcode',
               '.svg': 'svg', '.dxf': 'dxf', '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
               '.webp': 'image', '.bmp': 'image', '.txt': 'text', '.csv': 'table', '.xlsx': 'table',
               '.pdf': 'export', '.zip': 'export', '.json': 'asset'}
MIME = {'gcode': 'text/plain', 'svg': 'image/svg+xml', 'dxf': 'application/dxf', 'text': 'text/plain',
        'table': 'text/csv'}
IMG_MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
            '.bmp': 'image/bmp'}


class Staged:
    def __init__(self, path, size, sha):
        self.path, self.size, self.sha256 = path, size, sha


class Files:
    def __init__(self, db, cfg, ctx=None):
        self.db = db
        self.cfg = cfg
        self.ctx = ctx

    async def stage_upload(self, upload, limit):
        """Stream an UploadFile to the tmpfs staging dir (size-limited, hashed)."""
        os.makedirs(self.cfg.upload_dir, exist_ok=True)
        path = os.path.join(self.cfg.upload_dir, 'up-%s' % secrets.token_hex(8))
        h = hashlib.sha256()
        n = 0
        with open(path, 'wb') as f:
            while True:
                chunk = await upload.read(256 * 1024)
                if not chunk:
                    break
                n += len(chunk)
                if n > limit:
                    f.close()
                    os.unlink(path)
                    raise ApiError(413, 'too_large', '文件超过 %d MB' % (limit // (1024 * 1024)))
                h.update(chunk)
                f.write(chunk)
        return Staged(path, n, h.hexdigest())

    def blob_rel(self, sha, ext):
        return os.path.join(sha[:2], sha + ext)

    def blob_path(self, info):
        ext = (info.get('meta') or {}).get('ext') or ''
        return os.path.join(self.cfg.files_dir, self.blob_rel(info['sha256'], ext))

    def _free_ok(self):
        try:
            st = os.statvfs(self.cfg.data_dir)
            return st.f_bavail * st.f_frsize > 500 * 1024 * 1024
        except OSError:
            return True

    def add_staged(self, staged, name, kind=None, tags=None, meta=None):
        ext = os.path.splitext(name)[1].lower()
        kind = kind or KIND_BY_EXT.get(ext, 'asset')
        existing = self.db.one('SELECT * FROM files WHERE sha256=? AND kind=? AND name=?', (staged.sha256, kind, name))
        if existing:
            try:
                os.unlink(staged.path)
            except OSError:
                pass
            return self._out(existing)
        if not self._free_ok() and self.cfg.data_dir:
            os.unlink(staged.path)
            raise ApiError(507, 'disk_full', '存储空间不足（<500 MB）')
        dst = os.path.join(self.cfg.files_dir, self.blob_rel(staged.sha256, ext))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if os.path.exists(dst):
            os.unlink(staged.path)
        else:
            shutil.move(staged.path, dst)
        mime = IMG_MIME.get(ext) or MIME.get(kind) or 'application/octet-stream'
        if ext == '.xlsx':
            mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        m = dict(meta or {})
        m['ext'] = ext
        fid = _id('f')
        self.db.execute('INSERT INTO files(id,kind,name,sha256,size,mime,meta,tags,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
                        (fid, kind, name[:200], staged.sha256, staged.size, mime, jdump(m), jdump(tags or []),
                         time.time()))
        return self.get(fid)

    def add_bytes(self, data, name, kind=None, tags=None, meta=None):
        os.makedirs(self.cfg.upload_dir, exist_ok=True)
        path = os.path.join(self.cfg.upload_dir, 'b-%s' % secrets.token_hex(8))
        with open(path, 'wb') as f:
            f.write(data)
        return self.add_staged(Staged(path, len(data), hashlib.sha256(data).hexdigest()), name, kind, tags, meta)

    def _out(self, r):
        return {'id': r['id'], 'kind': r['kind'], 'name': r['name'], 'sha256': r['sha256'], 'size': r['size'],
                'mime': r['mime'], 'meta': jload(r['meta'], {}) or {}, 'tags': jload(r['tags'], []) or [],
                'created_at': r['created_at']}

    def get(self, fid):
        r = self.db.one('SELECT * FROM files WHERE id=?', (fid,))
        if not r:
            raise not_found('文件', {'file_id': fid})
        return self._out(r)

    def list(self, kind=None, q=None, tag=None, limit=200):
        sql = 'SELECT * FROM files WHERE 1=1'
        args = []
        if kind:
            sql += ' AND kind=?'
            args.append(kind)
        if q:
            sql += ' AND name LIKE ?'
            args.append('%' + q + '%')
        sql += ' ORDER BY created_at DESC LIMIT ?'
        args.append(int(limit))
        out = [self._out(r) for r in self.db.all(sql, args)]
        if tag:
            out = [f for f in out if tag in f['tags']]
        return out

    def patch(self, fid, name=None, tags=None):
        self.get(fid)
        if name:
            self.db.execute('UPDATE files SET name=? WHERE id=?', (name[:200], fid))
        if tags is not None:
            self.db.execute('UPDATE files SET tags=? WHERE id=?', (jdump([t[:40] for t in tags][:20]), fid))
        return self.get(fid)

    def delete(self, fid):
        info = self.get(fid)
        rows = self.db.all("SELECT id FROM jobs WHERE status IN ('queued','preparing','running','paused','stopping') "
                           "AND json_extract(source,'$.file_id')=?", (fid,))
        if rows:
            raise ApiError(409, 'in_use', '文件被排队或进行中的任务使用', {'jobs': [r['id'] for r in rows]})
        self.db.execute('DELETE FROM files WHERE id=?', (fid,))
        if not self.db.one('SELECT id FROM files WHERE sha256=?', (info['sha256'],)):
            try:
                os.unlink(self.blob_path(info))
            except OSError:
                pass

    async def preview_svg(self, fid):
        """Always re-rendered from parsed paths in a child (P10/P11); the uploaded
        SVG itself is never echoed as a preview."""
        info = self.get(fid)
        if info['kind'] not in ('svg', 'dxf', 'gcode'):
            raise ApiError(400, 'no_preview', '此类文件没有矢量预览')
        t = self.ctx.tasks.submit('vector_preview', {'kind': info['kind'], 'path': self.blob_path(info),
                                                     'profile_doc': self.ctx.machine.profile['doc']
                                                     if self.ctx.machine.profile else {}})
        res = await self.ctx.tasks.wait(t, 60)
        if res is None:
            self.ctx.tasks.cancel(t.id)
            raise ApiError(413, 'too_complex', '文件太复杂，预览超时')
        return res['svg']


# ---------------------------------------------------------------- imports
class Imports:
    def __init__(self, ctx):
        self.ctx = ctx

    @property
    def files(self):
        return self.ctx.files

    async def image(self, staged, name):
        if not self.ctx.features.get('image'):
            os.unlink(staged.path)
            raise ApiError(501, 'feature_unavailable', '图片导入需要 pillow', {'feature': 'image'})
        maxside = int(self.ctx.machine.mc.settings.maxImageSize or 4000) if self.ctx.machine.mc else 4000
        out = staged.path + '.png'
        t = self.ctx.tasks.submit('image_probe', {'path': staged.path, 'out': out, 'max_side': maxside,
                                                  'max_pixels': 40_000_000})
        try:
            res = await self.ctx.tasks.wait(t, 60)
        except ApiError:
            os.unlink(staged.path)
            raise
        if res is None:
            os.unlink(staged.path)
            raise ApiError(413, 'too_complex', '图片处理超时')
        if res.get('resized'):
            os.unlink(staged.path)
            with open(out, 'rb') as f:
                data = f.read()
            os.unlink(out)
            info = self.files.add_bytes(data, os.path.splitext(name)[0] + '.png', 'image',
                                        meta={'px_w': res['px_w'], 'px_h': res['px_h'], 'orig_px': res['orig_px']})
        else:
            info = self.files.add_staged(staged, name, 'image', meta={'px_w': res['px_w'], 'px_h': res['px_h']})
        return {'file': info, 'px_w': res['px_w'], 'px_h': res['px_h']}

    def trace(self, file_id, body):
        info = self.files.get(file_id)
        if info['kind'] != 'image':
            raise ApiError(400, 'bad_kind', '不是图片文件')
        if not self.ctx.features.get('image'):
            raise ApiError(501, 'feature_unavailable', '图片描摹需要 numpy/pillow', {'feature': 'image'})
        return self.ctx.tasks.submit('trace_image', {'path': self.files.blob_path(info), 'file_id': file_id,
                                                     'props': body.model_dump(),
                                                     'el_cache': self.ctx.cfg.el_cache_dir},
                                     slot='trace/%s' % file_id, on_done=self._trace_done)

    def _trace_done(self, res):
        from ..compose import prune_cache_dir
        prune_cache_dir(self.ctx.cfg.el_cache_dir, self.ctx.cfg.cache_mb * 1024 * 1024 // 3)
        return res

    async def vector(self, staged, name, kind):
        feat = 'vector' if kind == 'svg' else 'dxf'
        if not self.ctx.features.get(feat):
            os.unlink(staged.path)
            raise ApiError(501, 'feature_unavailable', '%s 导入需要 %s' % (kind.upper(),
                           'svgelements' if kind == 'svg' else 'ezdxf'), {'feature': feat})
        task = self.ctx.tasks.submit('parse_vector', {'path': staged.path, 'kind': kind})
        try:
            meta = await self.ctx.tasks.wait(task, 60)
        except ApiError as e:
            try:
                os.unlink(staged.path)
            except OSError:
                pass
            raise ApiError(400, 'bad_%s' % kind, '无法解析 %s：%s' % (kind.upper(), e.message))
        if meta is None:
            self.ctx.tasks.cancel(task.id)
            raise ApiError(413, 'too_complex', '文件太复杂，解析超时')
        info = self.files.add_staged(staged, name, kind, meta={k: meta.get(k) for k in
                                                              ('bbox_mm', 'width_mm', 'height_mm', 'paths', 'layers',
                                                               'text_runs', 'text_families') if k in meta})
        return {'file': info, 'bbox_mm': meta.get('bbox_mm'), 'width_mm': meta.get('width_mm') or 0.0,
                'height_mm': meta.get('height_mm') or 0.0, 'paths': meta.get('paths') or 0,
                'layers': meta.get('layers') or [], 'text_runs': meta.get('text_runs') or [],
                'text_families': meta.get('text_families') or []}

    async def gcode(self, staged, name):
        t = self.ctx.tasks.submit('analyze_file', {'path': staged.path, 'profile_doc':
                                                   self.ctx.machine.profile['doc'] if self.ctx.machine.profile else {}})
        try:
            a = await self.ctx.tasks.wait(t, 300)
        except ApiError:
            os.unlink(staged.path)
            raise
        if a is None:
            os.unlink(staged.path)
            raise ApiError(413, 'too_complex', 'G 代码分析超时')
        info = self.files.add_staged(staged, name, 'gcode', meta={'lines': a['lines'], 'bbox': a['bbox'],
                                                                 'est_s': a['est_s'], 'draw_mm': a['draw_mm'],
                                                                 'unsafe': bool(a.get('unsafe'))})
        return {'file': info, 'analysis': a}

    def text(self, data):
        from ..importers.table import decode_text
        text, enc = decode_text(data)
        return {'text': text, 'encoding': enc, 'chars': len(text)}

    async def table(self, staged, name):
        low = name.lower()
        if low.endswith('.xlsx') and not self.ctx.features.get('office'):
            os.unlink(staged.path)
            raise ApiError(501, 'feature_unavailable', 'XLSX 需要 openpyxl', {'feature': 'office'})
        if not low.endswith(('.csv', '.xlsx', '.txt', '.tsv')):
            os.unlink(staged.path)
            raise ApiError(400, 'bad_table', '只支持 CSV / XLSX')
        t = self.ctx.tasks.submit('read_table', {'path': staged.path, 'name': name})
        try:
            res = await self.ctx.tasks.wait(t, 120)
        except ApiError as e:
            os.unlink(staged.path)
            raise ApiError(e.status if e.status < 500 else 400, e.code if e.status < 500 else 'bad_table',
                           e.message, e.detail)
        if res is None:
            os.unlink(staged.path)
            raise ApiError(413, 'too_complex', '表格太大，读取超时')
        sheets = res['sheets']
        info = self.files.add_staged(staged, name, 'table',
                                     meta={'sheets': [{'name': x['name'], 'rows': x['row_count']} for x in sheets]})
        return {'file': info, 'sheets': sheets}


# ---------------------------------------------------------------- projects
def _default_doc(name=''):
    return {'version': 1, 'name': name, 'variables': [], 'paper': {'paper_id': 'a4-normal', 'spec': None},
            'print': {}, 'pages': [{'id': 'p1', 'paper': None, 'origin': None, 'elements': []}]}


class Projects:
    def __init__(self, ctx):
        self.ctx = ctx
        self.db = ctx.db

    @staticmethod
    def _extra(r):
        meta = jload(r.get('meta'), {}) or {}
        builtin = bool(r.get('builtin'))
        return {'builtin': builtin, 'category': meta.get('category'), 'description': meta.get('description'),
                'tags': meta.get('tags') or [], 'variables_hint': meta.get('variables') or [],
                'sample_data': meta.get('sample_data'),
                'thumb_url': '/api/v1/projects/%s/thumb.png' % r['id'] if builtin and meta.get('preview') else None}

    def _out(self, r):
        d = {'id': r['id'], 'name': r['name'], 'is_template': bool(r['is_template']), 'rev': r['rev'],
             'doc': jload(r['doc'], {}), 'created_at': r['created_at'], 'updated_at': r['updated_at']}
        d.update(self._extra(r))
        return d

    def _writable(self, pid):
        cur = self.get(pid)
        if cur.get('builtin'):
            raise ApiError(409, 'builtin', '内置模板是只读的：先「复制」再编辑')
        return cur

    def _norm(self, doc, name=None):
        from .schemas import ProjectDoc
        d = ProjectDoc.model_validate(doc).model_dump(by_alias=True)
        if name is not None:
            d['name'] = name
        return d

    def list(self, template=None, q=None, limit=200):
        sql = 'SELECT id,name,is_template,rev,created_at,updated_at,builtin,meta,' \
              'json_array_length(doc,\'$.pages\') AS pages FROM projects WHERE 1=1'
        args = []
        if template is not None:
            sql += ' AND is_template=?'
            args.append(1 if template else 0)
        if q:
            sql += ' AND name LIKE ?'
            args.append('%' + q + '%')
        sql += ' ORDER BY builtin ASC, updated_at DESC LIMIT ?'
        args.append(min(int(limit), 500))
        out = []
        for r in self.db.all(sql, args):
            d = {'id': r['id'], 'name': r['name'], 'is_template': bool(r['is_template']), 'pages': r['pages'] or 0,
                 'rev': r['rev'], 'updated_at': r['updated_at'], 'created_at': r['created_at']}
            d.update(self._extra(r))
            out.append(d)
        return out

    def get(self, pid):
        r = self.db.one('SELECT * FROM projects WHERE id=?', (pid,))
        if not r:
            raise not_found('工程')
        return self._out(r)

    def _insert(self, name, doc, is_template):
        pid = _id('p')
        now = time.time()
        self.db.execute('INSERT INTO projects(id,name,is_template,doc,rev,created_at,updated_at) VALUES(?,?,?,?,1,?,?)',
                        (pid, name[:120], 1 if is_template else 0, jdump(doc), now, now))
        return self.get(pid)

    def create(self, body):
        if body.from_template_id:
            t = self.get(body.from_template_id)
            doc = copy.deepcopy(t['doc'])
            doc['name'] = body.name
        elif body.doc is not None:
            doc = self._norm(body.doc.model_dump(by_alias=True), body.name)
        else:
            doc = self._norm(_default_doc(body.name))
        return self._insert(body.name, doc, body.is_template)

    def update(self, pid, body, by=None, conn_id=None):
        cur = self._writable(pid)
        if body.rev != cur['rev']:
            raise ApiError(409, 'rev_conflict', '工程已被修改（其它窗口？），请刷新', {'rev': cur['rev']})
        doc = body.doc.model_dump(by_alias=True)
        name = body.name or doc.get('name') or cur['name']
        n = self.db.execute('UPDATE projects SET doc=?, name=?, rev=rev+1, updated_at=? WHERE id=? AND rev=?',
                            (jdump(doc), name[:120], time.time(), pid, body.rev)).rowcount
        if not n:
            raise ApiError(409, 'rev_conflict', '工程已被修改，请刷新')
        out = self.get(pid)
        if getattr(self.ctx, 'collab', None):
            self.ctx.collab.project_changed(pid, out['rev'], by, 'doc', None, conn_id)
        return out

    def patch_element(self, pid, eid, body, by=None, conn_id=None, force=False):
        cur = self._writable(pid)
        coll = getattr(self.ctx, 'collab', None)
        if coll and by is not None and not force:
            lk = coll.locked_by_other(pid, eid, by.user_id)
            if lk:
                raise ApiError(409, 'element_locked', '%s 正在编辑这个元素' % lk['username'],
                               {'user': {'id': lk['user_id'], 'username': lk['username']}})
        if body.rev is not None and body.rev != cur['rev']:
            raise ApiError(409, 'rev_conflict', '工程已被修改，请刷新', {'rev': cur['rev']})
        doc = cur['doc']
        found = None
        for pg in doc.get('pages') or []:
            if body.page_id and pg.get('id') != body.page_id:
                continue
            for el in pg.get('elements') or []:
                if el.get('id') == eid:
                    found = el
                    break
            if found:
                break
        if found is None:
            raise not_found('元素', {'element_id': eid})
        if body.transform is not None:
            found['transform'] = body.transform.model_dump()
        if body.props:
            found.setdefault('props', {}).update(body.props)
        for k in ('z', 'locked', 'hidden', 'name'):
            v = getattr(body, k)
            if v is not None:
                found[k] = v
        doc = self._norm(doc)
        self.db.execute('UPDATE projects SET doc=?, rev=rev+1, updated_at=? WHERE id=?', (jdump(doc), time.time(), pid))
        out = self.get(pid)
        if coll:
            patch = {'page_id': body.page_id, 'element_id': eid,
                     'element': next((e for pg in out['doc']['pages'] for e in pg['elements'] if e['id'] == eid), None)}
            coll.project_changed(pid, out['rev'], by, 'element', patch, conn_id)
        return out

    def duplicate(self, pid, as_template=False, name=None):
        cur = self.get(pid)
        nm = name or (cur['name'] + (' 模板' if as_template else ' 副本'))
        doc = copy.deepcopy(cur['doc'])
        doc['name'] = nm
        # a copy of a built-in template is an ordinary (editable) project unless saved as template
        return self._insert(nm, doc, as_template or (cur['is_template'] and not cur.get('builtin')))

    def delete(self, pid):
        self._writable(pid)
        self.db.execute('DELETE FROM projects WHERE id=?', (pid,))

    # ---- bundle export/import ----
    def _file_ids(self, doc):
        ids = set()
        for pg in doc.get('pages') or []:
            for el in pg.get('elements') or []:
                fid = (el.get('props') or {}).get('file_id')
                if fid:
                    ids.add(fid)
            bg = pg.get('background') or {}
            for k in ('file_id', 'source_id'):     # reference background (+ its PDF)
                if bg.get(k):
                    ids.add(bg[k])
        return ids

    def _font_ids(self, doc):
        ids = set()
        for pg in doc.get('pages') or []:
            for el in pg.get('elements') or []:
                pr = el.get('props') or {}
                if pr.get('font_id'):
                    ids.add(pr['font_id'])
                for m in pr.get('font_mix') or []:
                    ids.add(m.get('font_id'))
        return ids

    def export_bundle(self, pid, as_zip=False):
        p = self.get(pid)
        files = []
        for fid in sorted(self._file_ids(p['doc'])):
            try:
                info = self.ctx.files.get(fid)
            except ApiError:
                continue
            with open(self.ctx.files.blob_path(info), 'rb') as f:
                data = f.read()
            files.append((info, data))
        bundle = {'format': 'penplot-project', 'version': 1, 'name': p['name'], 'is_template': p['is_template'],
                  'doc': p['doc'], 'fonts': sorted(self._font_ids(p['doc'])),
                  'files': [{'id': i['id'], 'kind': i['kind'], 'name': i['name'], 'meta': i['meta']}
                            for i, _ in files]}
        safe = ''.join(ch for ch in p['name'] if ch not in '\\/:*?"<>|') or 'project'
        if as_zip:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
                z.writestr('project.json', json.dumps(bundle, ensure_ascii=False, indent=1))
                for info, data in files:
                    z.writestr('files/%s%s' % (info['id'], info['meta'].get('ext', '')), data)
            return buf.getvalue(), safe + '.zip', 'application/zip'
        for b, (info, data) in zip(bundle['files'], files):
            b['data_b64'] = base64.b64encode(data).decode('ascii')
        return json.dumps(bundle, ensure_ascii=False).encode('utf-8'), safe + '.json', 'application/json'

    async def import_bundle(self, filename, staged):
        out_dir = staged.path + '.d'
        t = self.ctx.tasks.submit('read_bundle', {'path': staged.path, 'out_dir': out_dir})
        try:
            res = await self.ctx.tasks.wait(t, 120)
        except ApiError as e:
            raise ApiError(e.status if e.status < 500 else 400, e.code if e.status < 500 else 'bad_bundle',
                           '工程文件无法解析：%s' % e.message, e.detail)
        finally:
            try:
                os.unlink(staged.path)
            except OSError:
                pass
        if res is None:
            raise ApiError(413, 'too_complex', '工程文件太大')
        bundle = res['bundle']
        staged_blobs = res['blobs']
        if 'doc' not in bundle:
            bundle = {'doc': bundle, 'name': bundle.get('name', '导入的工程')}
        doc = bundle['doc']
        id_map = {}
        for f in bundle.get('files') or []:
            sp = staged_blobs.pop(f['id'], None)
            if sp is None:
                continue
            with open(sp, 'rb') as fh:
                raw = fh.read()
            os.unlink(sp)
            meta = {k: v for k, v in (f.get('meta') or {}).items() if k != 'ext'}
            info = self.ctx.files.add_bytes(raw, f.get('name') or f['id'], f.get('kind'), meta=meta)
            id_map[f['id']] = info['id']
        for sp in staged_blobs.values():
            try:
                os.unlink(sp)
            except OSError:
                pass
        shutil.rmtree(out_dir, ignore_errors=True)
        for pg in doc.get('pages') or []:
            for el in pg.get('elements') or []:
                pr = el.get('props') or {}
                if pr.get('file_id') in id_map:
                    pr['file_id'] = id_map[pr['file_id']]
            bg = pg.get('background') or {}
            for k in ('file_id', 'source_id'):
                if bg.get(k) in id_map:
                    bg[k] = id_map[bg[k]]
        try:
            doc = self._norm(doc)
        except Exception as e:
            raise ApiError(400, 'bad_bundle', '工程内容不合法：%s' % e)
        missing = sorted(f for f in self._font_ids(doc) if not self.ctx.fonts.exists(f))
        name = bundle.get('name') or doc.get('name') or os.path.splitext(filename)[0]
        p = self._insert(name, doc, bool(bundle.get('is_template')))
        return {'project': p, 'missing_fonts': missing, 'imported_files': len(id_map)}
