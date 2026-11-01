"""RenderService: builds task args (papers, fonts, files resolved in the
parent), stores results in the tmpfs render cache, previews, exports, batch."""
import asyncio
import copy
import io
import json
import logging
import os
import secrets
import shutil
import zipfile

from ..compose import decode_paths, preview_svg
from .db import jdump
from .errors import ApiError, not_found

log = logging.getLogger('penplot.web.render')
GCODE_KEYS = ('feed_rate', 'jog_speed', 'pen_down_z', 'pen_up_z', 'z_speed', 'tool_on_delay',
              'tool_off_delay', 'optimize', 'near_dst', 'simplify', 'copy_gap_mm', 'start_gcode',
              'end_gcode', 'origin', 'placement')


class RenderService:
    def __init__(self, ctx):
        self.ctx = ctx
        self.cfg = ctx.cfg
        self.root = ctx.cfg.render_dir
        os.makedirs(self.root, exist_ok=True)

    # ------------------------------------------------------------ args
    def _doc_refs(self, doc):
        fonts, files = set(), set()
        for pg in doc.get('pages') or []:
            for el in pg.get('elements') or []:
                pr = el.get('props') or {}
                if pr.get('font_id'):
                    fonts.add(pr['font_id'])
                for m in pr.get('font_mix') or []:
                    if m.get('font_id'):
                        fonts.add(m['font_id'])
                if pr.get('text_font_id'):              # svg <text>
                    fonts.add(pr['text_font_id'])
                fonts.update(v for v in (pr.get('text_font_map') or {}).values() if v)
                if pr.get('file_id'):
                    files.add(pr['file_id'])
        return fonts, files

    def _args(self, doc, project_id=None, project_rev=None, variables=None, overrides=None, profile_id=None,
              page_filter=None, name=None):
        c = self.ctx
        prof = c.profiles.get(profile_id) if profile_id else c.profiles.active()
        papers = []
        for pg in doc.get('pages') or []:
            ref = pg.get('paper') or doc.get('paper') or {'paper_id': 'a4-normal'}
            try:
                papers.append(c.papers.resolve(ref))
            except ApiError:
                raise ApiError(404, 'paper_not_found', '纸张不存在：%s' % (ref.get('paper_id'),))
        fonts, files = self._doc_refs(doc)
        default_font = c.fonts.default_font(c.settings.value('default_font'))
        missing_fonts = sorted(f for f in fonts if not c.fonts.exists(f))
        if missing_fonts:
            # seed templates may name fonts this device lacks: fall back to the default font
            doc = copy.deepcopy(doc)
            for pg in doc.get('pages') or []:
                for el in pg.get('elements') or []:
                    pr = el.get('props') or {}
                    if pr.get('font_id') in missing_fonts:
                        pr['font_id'] = default_font
                    if pr.get('font_mix'):
                        pr['font_mix'] = [m for m in pr['font_mix'] if m.get('font_id') not in missing_fonts] or None
                    if pr.get('text_font_id') in missing_fonts:
                        pr['text_font_id'] = default_font
                    if pr.get('text_font_map'):
                        pr['text_font_map'] = {k: v for k, v in pr['text_font_map'].items() if v not in missing_fonts}
            fonts = {f for f in fonts if f not in missing_fonts} | {default_font}
        file_paths = {}
        for fid in files:
            info = c.files.get(fid)
            file_paths[fid] = c.files.blob_path(info)
        ov = overrides.model_dump(exclude_none=True) if hasattr(overrides, 'model_dump') else (overrides or {})
        if ov.get('origin'):
            doc = copy.deepcopy(doc)
            for pg in doc.get('pages') or []:
                pg['origin'] = None
        rid = 'r' + secrets.token_hex(5)
        fmap = {k: v for k, v in c.fonts.paths().items() if k in fonts or k == default_font}
        return rid, {
            'rid': rid, 'out_dir': os.path.join(self.root, rid), 'doc': doc, 'papers': papers,
            'fonts': fmap, 'files': file_paths, 'default_font': default_font,
            'profile_doc': prof['doc'], 'profile_id': prof['id'], 'project_print': doc.get('print') or {},
            'overrides': ov, 'work_area': prof['doc'].get('work_area'), 'variables': variables or {},
            'page_filter': page_filter, 'project_id': project_id, 'project_rev': project_rev, 'name': name,
            'font_fallbacks': missing_fonts, 'el_cache': self.cfg.el_cache_dir,
        }

    def _on_done(self, res):
        self.prune()
        return res

    def submit_project(self, project_id, body, slot=None):
        if body.doc is not None:
            doc = body.doc.model_dump(by_alias=True)
            rev = None
            name = doc.get('name')
            if project_id:
                p = self.ctx.projects.get(project_id)
                name = p['name']
        else:
            p = self.ctx.projects.get(project_id)
            doc, rev, name = p['doc'], p['rev'], p['name']
        variables = dict(body.variables or {})
        pf = None if body.pages == 'all' else list(body.pages)
        rid, args = self._args(doc, project_id, rev, variables, body.overrides, body.profile_id, pf, name)
        return self.ctx.tasks.submit('render_project', args, slot=slot, on_done=self._on_done)

    def submit_text(self, body, slot=None):
        el = {'id': 'text', 'type': 'flow_text', 'transform': {}, 'z': 0, 'hidden': False,
              'props': {'text': body.text, 'font_id': body.font_id,
                        'font_mix': [m.model_dump() for m in body.font_mix] if body.font_mix else None,
                        'text_size': body.text_size, 'char_space': body.char_space, 'align': body.align,
                        'paragraph': body.paragraph.model_dump(), 'jitter': body.jitter.model_dump(),
                        'seed': body.seed if body.seed is not None else 0}}
        doc = {'version': 1, 'name': '文本', 'variables': [], 'paper': body.paper.model_dump(),
               'print': {'optimize': body.optimize},
               'pages': [{'id': 'p1', 'paper': None, 'origin': None, 'elements': [el]}]}
        rid, args = self._args(doc, None, None, {}, body.overrides, body.profile_id, None, '文本')
        return self.ctx.tasks.submit('render_text', args, slot=slot, on_done=self._on_done)

    def overrides_affect_gcode(self, ov, rid=None):
        """True if applying `ov` to render `rid` would change its G-code.

        The print sheet sends every print field it shows (feed, pen Z, origin,
        ...), usually with the values the preview already used. Re-rendering a
        big project just because a key is *present* made 「开始打印」 wait for a
        full render. Compare the effective configuration instead."""
        keys = [k for k in GCODE_KEYS if k in ov]
        if not keys:
            return False
        if rid is None:
            return True
        try:
            req = self._request(rid)
        except Exception:
            return True
        import json
        from ..settings import machine_config_to_dict
        from .printcfg import effective
        base = dict(req.get('overrides') or {})
        merged = dict(base)
        merged.update({k: ov[k] for k in keys})

        def sig(o):
            mc, opts, origin = effective(req.get('profile_doc') or {}, req.get('project_print'), o)
            opts = {k: v for k, v in (opts or {}).items() if k not in ('copies', 'copy_mode', 'multi_page')}
            d = machine_config_to_dict(mc)
            # only the firmware section that generates this machine's G-code counts
            # (pen_down_z also writes marlin.penDownMM on a GRBL profile, etc.)
            own = {'Grbl': ('grbl',), 'Marlin': ('marlin',), 'K_AT': ('marlin', 'kat'), 'Ebb': ('ebb',)}
            keep = ('type', 'settings', 'axes', 'advanced') + own.get(d.get('type'), ('grbl', 'marlin', 'ebb', 'kat'))
            d = {k: v for k, v in d.items() if k in keep}

            def num(v):            # 1500 == 1500.0 (API floats vs profile ints)
                if isinstance(v, bool) or v is None:
                    return v
                if isinstance(v, (int, float)):
                    return float(v)
                if isinstance(v, dict):
                    return {k: num(x) for k, x in v.items()}
                if isinstance(v, (list, tuple)):
                    return [num(x) for x in v]
                return v
            return json.dumps(num([d, opts, origin]), sort_keys=True, default=str)
        try:
            return sig(base) != sig(merged)
        except Exception:
            return True

    async def rerender(self, rid, overrides):
        req = self._request(rid)
        merged = dict(req.get('overrides') or {})
        merged.update(overrides or {})
        req['overrides'] = merged
        nrid = 'r' + secrets.token_hex(5)
        req['rid'] = nrid
        req['out_dir'] = os.path.join(self.root, nrid)
        task = self.ctx.tasks.submit('render_project', req, on_done=self._on_done)
        res = await self.ctx.tasks.wait(task, 130)
        if res is None:
            self.ctx.tasks.cancel(task.id)
            raise ApiError(503, 'render_timeout', '渲染超时')
        return nrid

    # ------------------------------------------------------------ results
    def _dir(self, rid):
        if not rid or '/' in rid or '..' in rid:
            raise not_found('渲染结果')
        d = os.path.join(self.root, rid)
        if not os.path.isfile(os.path.join(d, 'result.json')):
            raise ApiError(404, 'render_expired', '渲染结果不存在或已过期，请重新渲染', {'rid': rid})
        return d

    def _request(self, rid):
        with open(os.path.join(self._dir(rid), 'request.json'), encoding='utf-8') as f:
            return json.load(f)

    def get(self, rid):
        with open(os.path.join(self._dir(rid), 'result.json'), encoding='utf-8') as f:
            r = json.load(f)
        try:
            with open(os.path.join(self._dir(rid), 'meta.json'), encoding='utf-8') as f:
                r['name'] = json.load(f).get('name')
        except (OSError, ValueError):
            pass
        return r

    def _page(self, rid, index):
        r = self.get(rid)
        for p in r['pages']:
            if p['index'] == index:
                return r, p
        raise not_found('页面', {'index': index})

    def gcode_path(self, rid, index):
        self._page(rid, index)
        return os.path.join(self._dir(rid), 'page-%d.gcode' % index)

    def paths_bin(self, rid, index, space='page'):
        self._page(rid, index)
        with open(os.path.join(self._dir(rid), 'page-%d.%s.bin' % (index, space)), 'rb') as f:
            return f.read()

    def _meta(self, rid, index):
        try:
            with open(os.path.join(self._dir(rid), 'meta.json'), encoding='utf-8') as f:
                pages = json.load(f).get('pages') or []
            return pages[index] if index < len(pages) else {}
        except (OSError, ValueError):
            return {}

    def preview_svg(self, rid, index, space='page', travel=False):
        r, p = self._page(rid, index)
        paths = decode_paths(self.paths_bin(rid, index, space))
        if space == 'machine':
            return preview_svg(paths, p['width_mm'], p['height_mm'], travel=travel, y_up=True)
        return preview_svg(paths, p['width_mm'], p['height_mm'], travel=travel,
                           margins=self._meta(rid, index).get('margins'))

    def placement(self, rid, index, dx_mm=0.0, dy_mm=0.0):
        """The page as placed on the machine bed (machine coords, y up): work area,
        paper outline, drawing bbox, origin, frame path. dx/dy preview a placement
        shift (page mm, right/down) without re-rendering."""
        from ..geometry import Path
        from ..layout import OriginSpec, check_bounds, export_transform_mm, work_area_rect
        r, p = self._page(rid, index)
        req = self._request(rid)
        meta = self._meta(rid, index)
        origin = OriginSpec.coerce(meta.get('origin') or {})
        mtype = (req.get('profile_doc') or {}).get('type')
        wa = req.get('work_area') or {'w_mm': 0, 'h_mm': 0}
        w, h = p['width_mm'], p['height_mm']
        rect = Path()
        rect.rect(0.0, 0.0, w, h)
        shift = Path()
        shift.move_to(0.0, 0.0)
        shift.line_to(float(dx_mm), float(dy_mm))
        export_transform_mm([rect, shift], w, h, origin, machine_type=mtype,
                            anchor_bbox=p.get('bbox'))
        sx = shift.coords[2] - shift.coords[0]
        sy = shift.coords[3] - shift.coords[1]
        paper = [[round(rect.coords[i], 3), round(rect.coords[i + 1], 3)] for i in range(0, len(rect.coords), 2)]
        bb = p.get('machine_bbox')
        if bb:
            bb = [bb[0] + sx, bb[1] + sy, bb[2] + sx, bb[3] + sy]
        wr = work_area_rect(float(wa.get('w_mm', 0)), float(wa.get('h_mm', 0)), origin)
        travel = [min(0.0, bb[0]), min(0.0, bb[1]), max(0.0, bb[2]), max(0.0, bb[3])] if bb else None
        bad = check_bounds(travel, float(wa.get('w_mm', 0)), float(wa.get('h_mm', 0)), origin) if travel else []
        px = [v[0] for v in paper]
        py = [v[1] for v in paper]
        fits = bool(bb) and bb[0] >= min(px) - 0.5 and bb[2] <= max(px) + 0.5 and bb[1] >= min(py) - 0.5 \
            and bb[3] <= max(py) + 0.5
        frame = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], bb[1]]] if bb else []
        return {'space': 'machine', 'origin': [0.0, 0.0], 'origin_spec': origin.__dict__,
                'work_area': [round(v, 3) for v in wr], 'paper': paper,
                'bbox': [round(v, 3) for v in bb] if bb else None,
                'frame': [[round(x, 3), round(y, 3)] for x, y in frame], 'offset_mm': [float(dx_mm), float(dy_mm)],
                'machine_offset_mm': [round(sx, 3), round(sy, 3)], 'out_of_work_area': bool(bad),
                'violations': bad, 'fits_paper': fits, 'est_s': p['est_s'],
                'apply_hint': {'overrides': {'placement': {'dx_mm': float(dx_mm), 'dy_mm': float(dy_mm)}}}}

    def placement_svg(self, rid, index, dx_mm=0.0, dy_mm=0.0):
        info = self.placement(rid, index, dx_mm, dy_mm)
        paths = decode_paths(self.paths_bin(rid, index, 'machine'))
        sx, sy = info['machine_offset_mm']
        xs = [info['work_area'][0], info['work_area'][2]] + [v[0] for v in info['paper']]
        ys = [info['work_area'][1], info['work_area'][3]] + [v[1] for v in info['paper']]
        x0, x1, y0, y1 = min(xs) - 5, max(xs) + 5, min(ys) - 5, max(ys) + 5
        W, Hh = x1 - x0, y1 - y0
        fy = lambda y: -y  # noqa
        o = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="%.2f %.2f %.2f %.2f">' % (x0, -y1, W, Hh)]
        wa = info['work_area']
        o.append('<rect x="%.2f" y="%.2f" width="%.2f" height="%.2f" fill="#f2f2f2" stroke="#999" stroke-width="0.5"/>'
                 % (wa[0], fy(wa[3]), wa[2] - wa[0], wa[3] - wa[1]))
        o.append('<path d="M%s" fill="#fff" stroke="#bbb" stroke-width="0.4"/>'
                 % 'L'.join('%.2f %.2f' % (x, fy(y)) for x, y in info['paper']))
        d = []
        for pth in paths:
            c = pth.coords
            for i, op in enumerate(pth.ops):
                d.append('%s%.2f %.2f' % ('M' if op == 0 else 'L', c[2 * i] + sx, fy(c[2 * i + 1] + sy)))
        o.append('<path d="%s" fill="none" stroke="#111" stroke-width="0.35"/>' % ''.join(d))
        if info['frame']:
            col = '#d33' if info['out_of_work_area'] else '#07f'
            o.append('<path d="M%s" fill="none" stroke="%s" stroke-width="0.4" stroke-dasharray="2 1"/>'
                     % ('L'.join('%.2f %.2f' % (x, fy(y)) for x, y in info['frame']), col))
        o.append('<g stroke="#07f" stroke-width="0.6"><path d="M0 0h8M0 0v-8"/><circle cx="0" cy="0" r="1.5" '
                 'fill="none"/></g></svg>')
        return ''.join(o)

    def save(self, rid, page, name):
        r = self.get(rid)
        idx = [page] if page is not None else [p['index'] for p in r['pages']]
        out = []
        for i in idx:
            r2, p = self._page(rid, i)
            with open(self.gcode_path(rid, i), 'rb') as f:
                data = f.read()
            nm = name if len(idx) == 1 else '%s-p%d' % (name, i + 1)
            if not nm.lower().endswith('.gcode'):
                nm += '.gcode'
            out.append(self.ctx.files.add_bytes(data, nm, 'gcode', meta={
                'lines': p['gcode_lines'], 'bbox': p['machine_bbox'], 'est_s': p['est_s'],
                'draw_mm': p['stats']['draw_mm'], 'render_id': rid, 'page': i}))
        return out

    def export(self, rid, body):
        r = self.get(rid)
        idx = [p['index'] for p in r['pages']] if body.pages == 'all' else list(body.pages)
        for i in idx:
            self._page(rid, i)
        base = (r.get('name') or rid).replace('/', '_')
        if body.format == 'gcode':
            if len(idx) == 1:
                with open(self.gcode_path(rid, idx[0]), 'rb') as f:
                    return f.read(), '%s-p%d.gcode' % (base, idx[0] + 1), 'text/plain; charset=utf-8'
            body = body.model_copy(update={'format': 'zip'})
        if body.format == 'svg':
            if len(idx) == 1:
                return (self.preview_svg(rid, idx[0], body.space).encode('utf-8'),
                        '%s-p%d.svg' % (base, idx[0] + 1), 'image/svg+xml')
            body = body.model_copy(update={'format': 'zip'})
        if body.format == 'zip':
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
                for i in idx:
                    z.write(self.gcode_path(rid, i), 'page-%d.gcode' % (i + 1))
                    z.writestr('page-%d.svg' % (i + 1), self.preview_svg(rid, i, body.space))
                z.writestr('render.json', json.dumps(r, ensure_ascii=False, indent=1))
            return buf.getvalue(), '%s.zip' % base, 'application/zip'
        pages = []
        for i in idx:
            _r, p = self._page(rid, i)
            paths = decode_paths(self.paths_bin(rid, i, 'page'))
            pages.append((paths, p['width_mm'], p['height_mm']))
        if body.format == 'pdf':
            from ..export.pdf import pdf_bytes
            return pdf_bytes(pages, base), '%s.pdf' % base, 'application/pdf'
        if body.format == 'png':
            if not self.ctx.features.get('png'):
                raise ApiError(501, 'feature_unavailable', 'PNG 导出需要 pillow', {'feature': 'png'})
            _paths, w, h = pages[0]
            px = w * h * (body.dpi / 25.4) ** 2
            if px > 40e6:
                raise ApiError(400, 'too_large', 'PNG 太大（%.0f 万像素）：降低 dpi' % (px / 1e4))
            dst = os.path.join(self.cfg.upload_dir, 'exp-%s.png' % secrets.token_hex(6))
            t = self.ctx.tasks.submit('export_render', {'format': 'png', 'dst': dst, 'dpi': body.dpi, 'pages': [
                {'bin': os.path.join(self._dir(rid), 'page-%d.page.bin' % idx[0]), 'w': w, 'h': h}],
                'background': self._png_background(rid, idx[0]) if body.background else None})
            if not t.done_ev.wait(120) or t.state != 'done':
                raise ApiError(500, 'export_failed', 'PNG 导出失败：%s' % ((t.error or {}).get('message') or '超时'))
            with open(dst, 'rb') as f:
                data = f.read()
            os.unlink(dst)
            return data, '%s-p%d.png' % (base, idx[0] + 1), 'image/png'
        raise ApiError(400, 'bad_format', '不支持的格式')

    def _png_background(self, rid, index):
        """The source page's reference background (visible ones only) for the faint PNG layer.
        Backgrounds never reach the render child: paths / G-code / SVG / PDF cannot contain them."""
        from .backgrounds import page_background
        _r, p = self._page(rid, index)
        bg = page_background(self._request(rid).get('doc'), p.get('source_page', index))
        if not bg or not bg.get('visible', True) or not bg.get('file_id'):
            return None
        try:
            info = self.ctx.files.get(bg['file_id'])
        except ApiError:
            return None
        return {'path': self.ctx.files.blob_path(info), 'px_w': bg.get('px_w'), 'px_h': bg.get('px_h'),
                'transform': bg.get('transform') or {}, 'opacity': bg.get('opacity', 0.5)}

    # ------------------------------------------------------------ batch
    def submit_batch(self, project_id, body):
        """Table parsing and row selection happen in the batch child (P10)."""
        p = self.ctx.projects.get(project_id)
        info = self.ctx.files.get(body.data_file_id)
        if info['kind'] != 'table':
            raise ApiError(400, 'bad_table', '数据文件不是表格')
        rid, base = self._args(p['doc'], project_id, p['rev'], {}, body.overrides, None, None, p['name'])
        args = {'rid': rid, 'base': {k: v for k, v in base.items() if k not in ('rid', 'out_dir')},
                'table': {'path': self.ctx.files.blob_path(info), 'name': info['name'], 'sheet': body.sheet,
                          'mapping': body.mapping,
                          'rows': [body.preview_row] if body.preview_row is not None else body.rows},
                'out_root': self.root}
        ov = body.overrides
        preview = body.preview_row is not None
        loop = self.ctx.loop

        def on_done(res):
            if preview:
                r0 = res['rows'][0]
                return {'batch_id': None, 'jobs': [], 'rows': 1, 'render': self.get(r0['rid']),
                        'missing_glyphs': res.get('missing_glyphs')}
            row_vars = [(r['row'], r['variables']) for r in res['rows']]
            fut = asyncio.run_coroutine_threadsafe(self._batch_jobs(p, res, row_vars, body, ov), loop)
            out = fut.result(300)
            out['missing_glyphs'] = res.get('missing_glyphs')
            return out
        return self.ctx.tasks.submit('batch_render', args, on_done=on_done)

    async def _batch_jobs(self, p, res, row_vars, body, ov):
        from ..compose import substitute
        jobs = self.ctx.jobs
        prof = self.ctx.profiles.active()
        bid = 'b' + secrets.token_hex(4)
        overrides = ov.model_dump(exclude_none=True) if ov else {}
        ids = []
        seq = 1
        vars_by_row = dict(row_vars)
        for r in res['rows']:
            rr = self.get(r['rid'])
            name = substitute(body.name_pattern or '{{_row}}', vars_by_row.get(r['row'], {}))
            for pg in rr['pages']:
                gp = self.gcode_path(r['rid'], pg['index'])
                src = {'render_id': r['rid'], 'page': pg['index'], 'project_id': p['id'], 'rev': p['rev'],
                       'batch_row': r['row'], 'variables': vars_by_row.get(r['row'])}
                nm = '%s %s' % (p['name'], name) + (' 第%d页' % (pg['index'] + 1) if len(rr['pages']) > 1 else '')
                ids.append(await jobs._insert(None, src, nm, prof, overrides, bid, seq, src_path=gp))
                seq += 1
        return {'batch_id': bid, 'jobs': ids, 'rows': len(res['rows']), 'render': None}

    # ------------------------------------------------------------ cache
    def prune(self):
        """LRU prune of the render cache to PENPLOT_CACHE_MB (the element
        path cache gets a third of it on top)."""
        from ..compose import prune_cache_dir
        prune_cache_dir(self.cfg.el_cache_dir, self.cfg.cache_mb * 1024 * 1024 // 3)
        limit = self.cfg.cache_mb * 1024 * 1024
        entries = []
        total = 0
        try:
            for d in os.listdir(self.root):
                p = os.path.join(self.root, d)
                if not os.path.isdir(p):
                    continue
                size = sum(os.path.getsize(os.path.join(p, f)) for f in os.listdir(p))
                entries.append((os.path.getmtime(p), size, p))
                total += size
        except OSError:
            return
        entries.sort()
        active_rids = set()
        for r in self.ctx.db.all("SELECT source FROM jobs WHERE status='queued'"):
            try:
                active_rids.add(json.loads(r['source']).get('render_id'))
            except ValueError:
                pass
        for mt, size, p in entries:
            if total <= limit:
                break
            if os.path.basename(p) in active_rids:
                continue
            shutil.rmtree(p, ignore_errors=True)
            total -= size


__all__ = ['RenderService', 'jdump']
