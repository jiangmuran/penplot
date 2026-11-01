"""Task entrypoints: pure functions of JSON args (run in a child process).

Each KINDS[name](args, progress) -> small dict. progress(fraction, msg).
"""
import json
import os
import time


class Cancelled(Exception):
    pass


class BudgetExceeded(BaseException):     # escapes generic `except Exception`
    code = 'task_timeout'

    def __init__(self, message):
        super().__init__(message)
        self.message = message
        self.detail = None


class budget:
    """Hard wall-clock budget for a task body (SIGALRM; only in the main
    thread of a worker process, a no-op in thread mode). A task that runs
    over fails with a clear error instead of leaving the UI at "计算中"."""

    def __init__(self, env, default_s, message):
        try:
            self.s = float(os.environ.get(env, default_s))
        except ValueError:
            self.s = float(default_s)
        self.message = message
        self.armed = False

    def __enter__(self):
        import signal
        import threading
        if self.s > 0 and hasattr(signal, 'setitimer') and threading.current_thread() is threading.main_thread():
            def _fire(signum, frame):
                raise BudgetExceeded(self.message % self.s)
            self.old = signal.signal(signal.SIGALRM, _fire)
            signal.setitimer(signal.ITIMER_REAL, self.s)
            self.armed = True
        return self

    def __exit__(self, *exc):
        if self.armed:
            import signal
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, self.old)
        return False


def error_dict(e):
    code = getattr(e, 'code', None) or ('feature_unavailable' if isinstance(e, ImportError) else 'task_failed')
    msg = getattr(e, 'message', None) or str(e) or e.__class__.__name__
    if isinstance(e, ImportError):
        msg = '缺少可选依赖：%s' % e
    return {'code': code, 'message': msg, 'detail': getattr(e, 'detail', None)}


# ---------------------------------------------------------------- render
def render_project(args, progress):
    with budget('PENPLOT_RENDER_BUDGET_S', 110, '渲染超时（超过 %.0f 秒）：页面太复杂，或图片描摹参数过大（降低 max_px / 换用边缘模式）'):
        return _render_project(args, progress)


def _render_project(args, progress):
    from ...compose import Resolver, encode_paths, render_document
    from ..printcfg import effective
    t0 = time.time()
    mc, opts, origin = effective(args['profile_doc'], args.get('project_print'), args.get('overrides'))
    res = Resolver(args.get('fonts'), args.get('files'), args.get('default_font'), cache_dir=args.get('el_cache'))
    wa = args.get('work_area') or {}
    pages = render_document(args['doc'], args['papers'], res, mc, origin=origin,
                            work_area=(float(wa.get('w_mm', 0)), float(wa.get('h_mm', 0))),
                            opts=opts, variables=args.get('variables'),
                            page_filter=set(args['page_filter']) if args.get('page_filter') is not None else None,
                            progress=progress)
    out = args['out_dir']
    os.makedirs(out, exist_ok=True)
    infos = []
    meta_pages = []
    for p in pages:
        with open(os.path.join(out, 'page-%d.gcode' % p.index), 'w', encoding='utf-8', newline='') as f:
            f.write(p.gcode)
        with open(os.path.join(out, 'page-%d.page.bin' % p.index), 'wb') as f:
            f.write(encode_paths(p.page_paths))
        with open(os.path.join(out, 'page-%d.machine.bin' % p.index), 'wb') as f:
            f.write(encode_paths(p.machine_paths))
        info = p.info()
        for f in args.get('font_fallbacks') or []:
            info['warnings']['messages'].append('字体「%s」不在本机，已用默认字体代替' % f)
        infos.append(info)
        src_paper = args['papers'][p.source_page] if p.source_page < len(args['papers']) else {}
        meta_pages.append({'margins': src_paper.get('margins'), 'origin': p.origin})
    result = {'rid': args['rid'], 'created_at': time.time(), 'project_id': args.get('project_id'),
              'project_rev': args.get('project_rev'), 'profile_id': args.get('profile_id'),
              'pages': infos, 'elapsed_ms': round((time.time() - t0) * 1000, 1)}
    with open(os.path.join(out, 'result.json'), 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False)
    with open(os.path.join(out, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump({'pages': meta_pages, 'name': args.get('name')}, f, ensure_ascii=False)
    with open(os.path.join(out, 'request.json'), 'w', encoding='utf-8') as f:
        json.dump({k: v for k, v in args.items() if k != 'out_dir'}, f, ensure_ascii=False)
    progress(1.0)
    return result


def batch_render(args, progress):
    """One render per data row; returns {rows:[{row, rid, pages, variables}], missing_glyphs:{row: [...]}}."""
    from ...importers.table import read_table, row_variables
    t = args.get('table')
    if t:
        if t['name'].lower().endswith(('.xlsx', '.xlsm')):
            check_zip(t['path'])
        sheets = read_table(t['path'], t['name'])
        sheet = next((x for x in sheets if t.get('sheet') in (None, x['name'])), None)
        if sheet is None:
            raise _err('not_found', '工作表不存在')
        n = len(sheet['rows'])
        sel = list(range(n)) if t['rows'] == 'all' else [int(i) for i in t['rows']]
        for i in sel:
            if not 0 <= i < n:
                raise _err('bad_input', '行号超出范围：%d' % i)
        if len(sel) > 500:
            raise _err('bad_input', '一次最多 500 行')
        rows = [(i, row_variables(sheet, i, t['mapping'])) for i in sel]
    else:
        rows = args['rows']
    out = []
    missing = {}
    for k, (row_index, variables) in enumerate(rows):
        a = dict(args['base'])
        a['variables'] = variables
        a['rid'] = '%s-%d' % (args['rid'], row_index)
        a['out_dir'] = os.path.join(args['out_root'], a['rid'])
        r = render_project(a, lambda f, m='': progress((k + f) / max(1, len(rows)), m))
        mg = sorted({ch for pg in r['pages'] for ch in pg['warnings']['missing_glyphs']})
        if mg:
            missing[str(row_index + 1)] = mg
        out.append({'row': row_index, 'rid': a['rid'], 'pages': len(r['pages']), 'variables': variables})
    return {'rows': out, 'rid': args['rid'], 'missing_glyphs': missing}


# ---------------------------------------------------------------- images / vectors
def trace_image(args, progress):
    from ...compose import bbox_of, preview_svg, trace_image as tr
    with budget('PENPLOT_TRACE_BUDGET_S', 60, '图片描摹超时（超过 %.0f 秒），请降低 max_px 或换用边缘模式'):
        paths = tr(args['path'], args['props'], cache_dir=args.get('el_cache'),
                   progress=lambda f, m='': progress(0.9 * f, m))
    progress(0.92, '生成预览')
    bb = bbox_of(paths) or (0, 0, 0, 0)
    draw = sum(p.total_length() for p in paths)
    return {'file_id': args['file_id'], 'paths': len(paths), 'width_mm': round(bb[2], 3),
            'height_mm': round(bb[3], 3), 'draw_mm': round(draw, 1),
            'svg': preview_svg(paths, max(bb[2], 1), max(bb[3], 1), page_rect=False)}


def parse_vector(args, progress):
    if args['kind'] == 'svg':
        from ...importers.svg import load_svg
        _paths, info = load_svg(args['path'])
    else:
        from ...importers.dxf import load_dxf
        _paths, info = load_dxf(args['path'])
    return info


def ttf_convert(args, progress):
    from ...ttffont import charset_chars, convert_ttf
    chars = charset_chars(args.get('charset') or 'gb2312-1', args.get('chars'))
    progress(0.01, '读取字体')
    f = convert_ttf(args['src'], args['dst'], chars=chars, mode=args.get('mode', 'skeleton'),
                    size_px=int(args.get('size_px', 160)), face_index=int(args.get('face_index', 0)),
                    simplify_tol=float(args.get('simplify_tol', 1.2)), name=args.get('name'),
                    progress=progress)
    miss = ''.join(c for c in f.missing if not c.isspace())
    return {'font_file': os.path.basename(args['dst']), 'glyphs': f.glyph_count,
            'requested': f.requested, 'missing_count': len(miss), 'missing': miss[:200]}


def export_render(args, progress):
    """png / pdf / svg of render pages -> file at args['dst']."""
    from ...compose import decode_paths
    fmt = args['format']
    pages = []
    for p in args['pages']:
        with open(p['bin'], 'rb') as f:
            pages.append((decode_paths(f.read()), p['w'], p['h']))
    if fmt == 'pdf':
        from ...export.pdf import write_pdf
        write_pdf(args['dst'], pages)
    elif fmt == 'png' and args.get('background'):
        from ..backgrounds import composite_png
        composite_png(args['dst'], pages[0][0], pages[0][1], pages[0][2], int(args.get('dpi', 150)),
                      args['background'])
    elif fmt == 'png':
        from ...export.png import write_png
        write_png(args['dst'], pages[0][0], pages[0][1], pages[0][2], dpi=int(args.get('dpi', 150)))
    return {'dst': args['dst']}


def sleep_task(args, progress):
    """Test helper: sleeps, reporting progress."""
    n = int(args.get('steps', 10))
    for i in range(n):
        time.sleep(float(args.get('dt', 0.1)))
        progress((i + 1) / n)
    return {'slept': n}


def font_sample(args, progress):
    """Font sample SVG in a worker (font cached per worker, off the main process)."""
    from ...compose import Resolver, preview_svg, text_box_paths
    from ...geometry import bbox_of
    from ...settings import Settings
    fid, size_mm, width_mm = args['font_id'], float(args['size_mm']), args.get('width_mm')
    res = Resolver(fonts={fid: args['path']} if args.get('path') else {})
    el = {'id': 'sample', 'props': {'text': args['text'], 'font_id': fid, 'size_mm': size_mm,
                                   'line_height': 1.3, 'seed': 1, 'missing_glyph': 'skip',
                                   'box': {'w': float(width_mm), 'h': 10000} if width_mm else None}}
    warn = {'missing': set(), 'overflow': False}
    paths = text_box_paths(el, res, {}, Settings(), warn)
    bb = bbox_of(paths) or (0, 0, size_mm, size_mm)
    return {'svg': preview_svg(paths, max(bb[2], 1.0) + 1, max(bb[3], 1.0) + 1, page_rect=False,
                               stroke=max(0.15, size_mm / 40.0))}


KINDS = {
    'font_sample': font_sample,
    'render_project': render_project,
    'render_text': render_project,
    'batch_render': batch_render,
    'trace_image': trace_image,
    'parse_vector': parse_vector,
    'ttf_convert': ttf_convert,
    'export_render': export_render,
    'sleep': sleep_task,
}


# ---------------------------------------------------------------- job G-code
def job_bounds_issues(a, mc, work_area, origin):
    """Safety gate (P13): pen-up travel too, Z range, machine-coordinate moves."""
    from ...layout import check_bounds
    issues = []
    tb = a.get('travel_bbox')
    if tb:
        bad = check_bounds(tb, float(work_area.get('w_mm', 0)), float(work_area.get('h_mm', 0)), origin)
        if bad:
            issues.append('移动范围超出工作区（%s，含空走）' % ', '.join(bad))
    zr = a.get('z_range')
    if zr and mc.type in ('Grbl', 'Marlin', 'K_AT'):
        if mc.type == 'Grbl':
            lo, hi = sorted((float(mc.grbl.zOn), float(mc.grbl.zOff)))
            stepper = mc.grbl.type == 'Stepper'
        else:
            lo, hi = sorted((float(mc.marlin.penDownMM), float(mc.marlin.penUpMM)))
            stepper = mc.marlin.type == 'Stepper'
        if stepper and (zr[0] < lo - 1.0 or zr[1] > hi + 1.0):
            issues.append('Z 范围 %.1f…%.1f mm 超出抬落笔范围 %.1f…%.1f mm' % (zr[0], zr[1], lo, hi))
    if a.get('machine_moves'):
        issues.append('含有 G28/G30/G53（第 %s 行），本机没有回零，位置不可预测'
                      % ', '.join(str(x) for x in a['machine_moves'][:5]))
    return issues


def prepare_job_gcode(args, progress):
    """Sanitize (strip comments, refuse realtime/non-ASCII/$ lines) and analyse
    a job's G-code in the rlimited child; writes the clean file to dst."""
    from ...gcode import analyze_gcode, sanitize_gcode
    from ...machine.base import UnsafeGcode
    from ..printcfg import effective
    with open(args['src'], encoding='utf-8', errors='replace') as f:
        text = f.read()
    try:
        clean = sanitize_gcode(text)
    except UnsafeGcode as e:
        err = ValueError(str(e))
        err.code = 'unsafe_gcode'
        err.message = '第 %s 行不能发送：%s' % (e.line_no, e.reason)
        err.detail = {'line': e.line_no, 'text': e.line[:80], 'reason': e.reason}
        raise err
    progress(0.3)
    mc, _opts, origin = effective(args['profile_doc'], {}, args.get('overrides') or {})
    pl = (args.get('overrides') or {}).get('placement') or {}
    if args.get('apply_placement') and (pl.get('dx_mm') or pl.get('dy_mm')):
        from ...gcode import offset_gcode
        # page shift (right, down) -> machine shift through the origin axis mapping
        mx, my = float(pl.get('dx_mm') or 0), -float(pl.get('dy_mm') or 0)
        if origin.get('revxy'):
            mx, my = my, mx
        if origin.get('x_rev'):
            mx = -mx
        if origin.get('y_rev'):
            my = -my
        try:
            clean = offset_gcode(clean, mx, my)
        except ValueError as e:
            e.code, e.message = 'bad_input', str(e)
            raise
    with open(args['dst'], 'w', encoding='utf-8', newline='') as f:
        f.write(clean)
    an = analyze_gcode(clean, mc, keep_arrays=True)
    a = an.to_dict()
    # keep the per-line arrays next to the job file: start / retry load them
    # instead of re-analysing tens of thousands of lines in the main process
    try:
        import pickle
        tmp = args['dst'] + '.an.pkl.part'
        with open(tmp, 'wb') as f:
            pickle.dump(an, f, protocol=pickle.HIGHEST_PROTOCOL)
        os.replace(tmp, args['dst'] + '.an.pkl')
    except Exception:
        pass
    a['issues'] = job_bounds_issues(a, mc, args['profile_doc'].get('work_area') or {}, origin)
    a['origin'] = origin
    return a


KINDS['prepare_job_gcode'] = prepare_job_gcode


# ---------------------------------------------------------------- parsers (P10: never in the main process)
ZIP_MAX_TOTAL = 200 * 1024 * 1024
ZIP_MAX_RATIO = 100
ZIP_MAX_MEMBERS = 1000


def _err(code, message, detail=None):
    e = ValueError(message)
    e.code, e.message, e.detail = code, message, detail
    return e


def check_zip(path):
    import zipfile
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise _err('bad_bundle', '不是有效的 zip 文件')
    infos = z.infolist()
    if len(infos) > ZIP_MAX_MEMBERS:
        raise _err('zip_bomb', 'zip 里的文件太多（>%d）' % ZIP_MAX_MEMBERS)
    total = sum(i.file_size for i in infos)
    packed = sum(max(1, i.compress_size) for i in infos)
    if total > ZIP_MAX_TOTAL or total / packed > ZIP_MAX_RATIO:
        raise _err('zip_bomb', '压缩包解开后太大或压缩比异常（疑似 zip 炸弹），已拒绝',
                   {'uncompressed': total, 'ratio': round(total / packed, 1)})
    return z


def read_bundle(args, progress):
    """Project bundle (.json or .zip) -> {bundle, blobs:{file_id: staged_path}}."""
    import base64
    import secrets
    path, out_dir = args['path'], args['out_dir']
    os.makedirs(out_dir, exist_ok=True)
    blobs = {}
    with open(path, 'rb') as f:
        head = f.read(2)
    if head == b'PK':
        z = check_zip(path)
        try:
            bundle = json.loads(z.read('project.json').decode('utf-8'))
        except KeyError:
            raise _err('bad_bundle', 'zip 里没有 project.json')
        for n in z.namelist():
            if n.startswith('files/') and len(n) > 6 and not n.endswith('/'):
                fid = os.path.splitext(os.path.basename(n))[0]
                dst = os.path.join(out_dir, 'b-' + secrets.token_hex(6))
                with z.open(n) as src, open(dst, 'wb') as o:
                    o.write(src.read())
                blobs[fid] = dst
    else:
        if os.path.getsize(path) > 100 * 1024 * 1024:
            raise _err('too_large', 'JSON 工程文件太大')
        with open(path, encoding='utf-8') as f:
            bundle = json.load(f)
        for fe in bundle.get('files') or []:
            if fe.get('data_b64'):
                dst = os.path.join(out_dir, 'b-' + secrets.token_hex(6))
                with open(dst, 'wb') as o:
                    o.write(base64.b64decode(fe.pop('data_b64')))
                blobs[fe['id']] = dst
    return {'bundle': bundle, 'blobs': blobs}


def read_table_kind(args, progress):
    from ...importers.table import read_table
    path, name = args['path'], args['name']
    if name.lower().endswith(('.xlsx', '.xlsm')):
        check_zip(path)
    sheets = read_table(path, name)
    if args.get('full'):
        return {'sheets': sheets}
    return {'sheets': [{'name': s['name'], 'columns': s['columns'], 'row_count': len(s['rows']),
                        'sample_rows': s['rows'][:5]} for s in sheets]}


def image_probe(args, progress):
    """Verify an upload, refuse > max_pixels before decoding, downscale to max_side."""
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    path = args['path']
    maxpx = int(args.get('max_pixels', 40_000_000))
    try:
        with Image.open(path) as im:
            w, h = im.size
            fmt = (im.format or '').lower()
    except Exception as e:
        raise _err('bad_image', '无法读取图片：%s' % e)
    if fmt not in ('png', 'jpeg', 'webp', 'bmp', 'gif'):
        raise _err('bad_image', '不支持的图片格式 %s' % fmt)
    if w * h > maxpx:
        raise _err('too_large', '图片太大（%d×%d，上限 %d 万像素）' % (w, h, maxpx // 10000))
    with Image.open(path) as im:
        im.verify()
    side = int(args.get('max_side', 4000))
    from ...image import image_size
    dw, dh = image_size(path)          # as displayed (EXIF orientation applied)
    if max(w, h) > side:
        from PIL import ImageOps
        with Image.open(path) as im:
            k = side / float(max(w, h))
            if fmt == 'jpeg':
                im.draft('RGB', (int(w * k) + 1, int(h * k) + 1))     # DCT-domain pre-scale
            # bake the orientation in: the re-encoded PNG carries no EXIF
            im = ImageOps.exif_transpose(im)
            im = im.convert('RGBA' if im.mode in ('RGBA', 'LA', 'P', 'PA') else 'RGB')
            im = im.resize((max(1, int(round(dw * k))), max(1, int(round(dh * k)))), Image.LANCZOS,
                           reducing_gap=3.0)
            im.save(args['out'], 'PNG', compress_level=3)
        return {'px_w': im.size[0], 'px_h': im.size[1], 'orig_px': [dw, dh], 'resized': True}
    return {'px_w': dw, 'px_h': dh, 'resized': False}


def vector_preview(args, progress):
    """Sanitized SVG preview rendered from parsed paths (never echo the upload, P11)."""
    from ...compose import bbox_of, preview_svg
    from ...geometry import translate_all
    kind = args['kind']
    if kind == 'svg':
        from ...importers.svg import load_svg
        paths, _ = load_svg(args['path'])
        bb = bbox_of(paths) or (0, 0, 1, 1)
        translate_all(paths, -bb[0], -bb[1])
        return {'svg': preview_svg(paths, bb[2] - bb[0], bb[3] - bb[1], page_rect=False)}
    if kind == 'dxf':
        from ...importers.dxf import load_dxf
        paths, _ = load_dxf(args['path'])
        bb = bbox_of(paths) or (0, 0, 1, 1)
        translate_all(paths, -bb[0], -bb[1])
        return {'svg': preview_svg(paths, bb[2] - bb[0], bb[3] - bb[1], page_rect=False)}
    from ...gcode import parse_gcode
    from ...settings import machine_config_from_dict
    with open(args['path'], encoding='utf-8', errors='replace') as f:
        paths = parse_gcode(f.read(), machine_config_from_dict(args.get('profile_doc') or {}))
    return {'svg': preview_svg(paths, 0, 0, y_up=True)}


def analyze_file(args, progress):
    from ...gcode import analyze_gcode
    from ...settings import machine_config_from_dict
    with open(args['path'], 'rb') as f:
        raw = f.read()
    if b'\x00' in raw[:4096]:
        raise _err('bad_gcode', '不是文本 G 代码文件')
    a = analyze_gcode(raw.decode('utf-8', 'replace'), machine_config_from_dict(args.get('profile_doc') or {}),
                      keep_arrays=False)
    return a.to_dict()


KINDS.update({'read_bundle': read_bundle, 'read_table': read_table_kind, 'image_probe': image_probe,
              'vector_preview': vector_preview, 'analyze_file': analyze_file})

# reference backgrounds (penplot/web/backgrounds.py)
from ..backgrounds import KINDS as _BG_KINDS  # noqa: E402
KINDS.update(_BG_KINDS)
