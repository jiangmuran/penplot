"""Seed content (seed/README.md): built-in papers, read-only built-in templates
(`tpl-<id>`), sample CSVs. Idempotent; runs at every startup."""
import hashlib
import json
import logging
import os
import time

from .db import jdump, jload

log = logging.getLogger('penplot.web.seed')
PAPER_FIELDS = ('width_mm', 'height_mm', 'margins', 'orientation', 'rotation', 'ruling', 'category', 'note')


def load_seed(ctx):
    d = ctx.cfg.seed_dir
    if not d or not os.path.isdir(d):
        return {'papers': 0, 'templates': 0, 'samples': 0}
    out = {'papers': _papers(ctx, d), 'templates': _templates(ctx, d), 'samples': _samples(ctx, d)}
    log.info('seed %s: %s', d, out)
    return out


def _papers(ctx, d):
    p = os.path.join(d, 'papers.json')
    if not os.path.exists(p):
        return 0
    with open(p, encoding='utf-8') as f:
        papers = json.load(f).get('papers') or []
    now = time.time()
    n = 0
    for e in papers:
        doc = {k: e[k] for k in PAPER_FIELDS if k in e}
        ctx.db.execute('INSERT OR REPLACE INTO papers(id,name,builtin,doc,updated_at) VALUES(?,?,1,?,?)',
                       (e['id'], e['name'], jdump(doc), now))
        n += 1
    return n


def _templates(ctx, d):
    from .schemas import ProjectDoc
    idx = os.path.join(d, 'templates', 'index.json')
    if not os.path.exists(idx):
        return 0
    with open(idx, encoding='utf-8') as f:
        entries = json.load(f).get('templates') or []
    n = 0
    now = time.time()
    for e in entries:
        fp = os.path.join(d, 'templates', e['file'])
        try:
            with open(fp, encoding='utf-8') as f:
                raw = json.load(f)
            raw = _resolve_assets(ctx, d, raw)
            doc = ProjectDoc.model_validate(raw).model_dump(by_alias=True)
        except Exception as ex:
            log.warning('seed template %s: %s', e.get('id'), ex)
            continue
        pid = 'tpl-' + e['id']
        meta = {k: e.get(k) for k in ('category', 'description', 'tags', 'sample_data', 'preview', 'variables',
                                      'fonts', 'paper_id')}
        meta['seed_hash'] = hashlib.sha256(jdump(doc).encode()).hexdigest()[:16]
        cur = ctx.db.one('SELECT rev, meta FROM projects WHERE id=?', (pid,))
        if cur is None:
            ctx.db.execute('INSERT INTO projects(id,name,is_template,doc,rev,created_at,updated_at,builtin,meta) '
                           'VALUES(?,?,1,?,1,?,?,1,?)', (pid, e['name'], jdump(doc), now, now, jdump(meta)))
        elif (jload(cur['meta'], {}) or {}).get('seed_hash') != meta['seed_hash']:
            ctx.db.execute('UPDATE projects SET name=?, doc=?, rev=rev+1, updated_at=?, builtin=1, is_template=1, '
                           'meta=? WHERE id=?', (e['name'], jdump(doc), now, jdump(meta), pid))
        n += 1
    return n


ASSET_PREFIX = 'asset:'
_ASSET_KINDS = {'.svg': 'svg', '.dxf': 'dxf', '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
                '.webp': 'image', '.gcode': 'gcode', '.nc': 'gcode', '.pdf': 'pdf'}


def _asset_file_id(ctx, d, name):
    """seed/assets/<name> -> files-library id (imported once, deduped by sha256)."""
    path = os.path.realpath(os.path.join(d, 'assets', name))
    if not path.startswith(os.path.realpath(os.path.join(d, 'assets')) + os.sep) or not os.path.isfile(path):
        raise ValueError('seed asset missing: %s' % name)
    with open(path, 'rb') as f:
        data = f.read()
    sha = hashlib.sha256(data).hexdigest()
    row = ctx.db.one('SELECT id FROM files WHERE sha256=?', (sha,))
    if row:
        return row['id']
    ext = os.path.splitext(name)[1].lower()
    kind = _ASSET_KINDS.get(ext, 'asset')
    meta = {'seed': True}
    if kind == 'svg':
        try:
            from ..importers.svg import load_svg
            _paths, info = load_svg(path)
            meta.update({k: v for k, v in (info or {}).items() if isinstance(v, (int, float, str, list, dict))})
        except Exception as ex:
            log.warning('seed asset %s: %s', name, ex)
    info = ctx.files.add_bytes(data, name, kind, tags=['模板素材'], meta=meta)
    return info['id'] if isinstance(info, dict) else info


def _resolve_assets(ctx, d, doc):
    """Replace "asset:<file>" references (element props.file_id, page
    background.file_id) with library file ids, importing seed/assets files."""
    def fix(obj):
        fid = obj.get('file_id') if isinstance(obj, dict) else None
        if isinstance(fid, str) and fid.startswith(ASSET_PREFIX):
            obj['file_id'] = _asset_file_id(ctx, d, fid[len(ASSET_PREFIX):])
    for pg in doc.get('pages') or []:
        fix(pg.get('background') or {})
        for el in pg.get('elements') or []:
            fix(el.get('props') or {})
    return doc


def _samples(ctx, d):
    if ctx.db.get_setting('seed_samples_done'):
        return 0
    n = 0
    sd = os.path.join(d, 'samples')
    if os.path.isdir(sd):
        for fn in sorted(os.listdir(sd)):
            if fn.lower().endswith('.csv'):
                with open(os.path.join(sd, fn), 'rb') as f:
                    ctx.files.add_bytes(f.read(), fn, 'table', tags=['示例'], meta={'seed': True})
                n += 1
    ctx.db.set_setting('seed_samples_done', True)
    return n


def thumb_path(ctx, project_id):
    r = ctx.db.one('SELECT builtin, meta FROM projects WHERE id=?', (project_id,))
    if not r or not r['builtin']:
        return None
    prev = (jload(r['meta'], {}) or {}).get('preview')
    if not prev:
        return None
    p = os.path.abspath(os.path.join(ctx.cfg.seed_dir, 'templates', prev))
    root = os.path.abspath(ctx.cfg.seed_dir)
    return p if p.startswith(root + os.sep) and os.path.isfile(p) else None
