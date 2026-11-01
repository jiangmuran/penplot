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
