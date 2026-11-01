"""Reference backgrounds (Page.background): a scanned note template / sheet shown under the
design in the studio and the position preview. Never rendered into paths, G-code, SVG or PDF;
optionally a faint layer in the PNG export.

Task bodies (`bg_prepare`, `bg_pdf_thumb`) run in a worker process (untrusted PDFs/images never
get decoded in the server process); `BackgroundImports` is the parent-side service.
"""
import os
import secrets

from .errors import ApiError

MAX_SIDE = 3000              # px, longest side of a stored background raster
MAX_PIXELS = 40_000_000      # refuse bigger images before decoding
JPEG_Q = 85


class _TaskError(Exception):
    def __init__(self, code, message, detail=None):
        super().__init__(message)
        self.code, self.message, self.detail = code, message, detail


def is_pdf(path):
    try:
        with open(path, 'rb') as f:
            head = f.read(1024)
    except OSError:
        return False
    return b'%PDF-' in head


def _save_raster(im, out):
    """JPEG (scans are photos; small over WiFi) unless the image has transparency."""
    alpha = im.mode in ('RGBA', 'LA', 'PA') or (im.mode == 'P' and 'transparency' in im.info)
    if alpha:
        im = im.convert('RGBA')
        im.save(out, 'PNG', compress_level=6)
        return 'png'
    if im.mode not in ('RGB', 'L'):
        im = im.convert('RGB')
    im.save(out, 'JPEG', quality=JPEG_Q, optimize=True)
    return 'jpeg'


def _pdf_open(path):
    import pypdfium2 as pdfium
    try:
        return pdfium.PdfDocument(path)
    except Exception as e:      # PdfiumError: damaged / encrypted
        msg = str(e)
        if 'password' in msg.lower():
            raise _TaskError('bad_pdf', 'PDF 有密码保护，无法打开')
        raise _TaskError('bad_pdf', '无法读取 PDF：%s' % msg)


def _pdf_render(path, page, dpi=150.0, max_side=MAX_SIDE):
    """Rasterise one page -> (PIL image, page_count, effective dpi)."""
    doc = _pdf_open(path)
    try:
        n = len(doc)
        if n < 1:
            raise _TaskError('bad_pdf', 'PDF 没有页面')
        if page < 0 or page >= n:
            raise _TaskError('bad_page', 'PDF 只有 %d 页' % n, {'page_count': n})
        pg = doc[page]
        try:
            w_pt, h_pt = pg.get_size()
            dpi = max(10.0, min(float(dpi), 600.0))
            k = dpi / 72.0
            side = max(w_pt, h_pt) * k
            if side > max_side:                  # huge pages: lower the dpi instead of failing
                k *= max_side / side
            if w_pt * h_pt * k * k > MAX_PIXELS:
                raise _TaskError('too_large', 'PDF 页面太大')
            bm = pg.render(scale=k, fill_color=(255, 255, 255, 255))
            im = bm.to_pil().convert('RGB')
            return im, n, k * 72.0
        finally:
            pg.close()
    finally:
        doc.close()


def bg_prepare(args, progress):
    """args: path (upload / stored PDF), out (raster path), page, dpi.
    -> {px_w, px_h, format, pdf, page, page_count, dpi, natural_mm}"""
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = None
    path, out = args['path'], args['out']
    if is_pdf(path):
        im, n, dpi = _pdf_render(path, int(args.get('page') or 0), float(args.get('dpi') or 150))
        fmt = _save_raster(im, out)
        w, h = im.size
        return {'px_w': w, 'px_h': h, 'format': fmt, 'pdf': True, 'page': int(args.get('page') or 0),
                'page_count': n, 'dpi': round(dpi, 2),
                'natural_mm': [round(w * 25.4 / dpi, 2), round(h * 25.4 / dpi, 2)]}
    try:
        with Image.open(path) as im0:
            w, h = im0.size
            fmt = (im0.format or '').lower()
    except Exception as e:
        raise _TaskError('bad_image', '无法读取图片：%s' % e)
    if fmt not in ('png', 'jpeg', 'webp', 'bmp', 'gif', 'tiff', 'mpo'):
        raise _TaskError('bad_image', '不支持的图片格式 %s' % fmt)
    if w * h > MAX_PIXELS:
        raise _TaskError('too_large', '图片太大（%d×%d，上限 %d 万像素）' % (w, h, MAX_PIXELS // 10000))
    with Image.open(path) as im0:
        im0.verify()
    with Image.open(path) as im:
        dpi_info = im.info.get('dpi')
        if fmt in ('jpeg', 'mpo') and max(w, h) > MAX_SIDE:
            k = MAX_SIDE / float(max(w, h))
            im.draft('RGB', (int(w * k) + 1, int(h * k) + 1))     # DCT-domain pre-scale
        im = ImageOps.exif_transpose(im)        # bake the camera rotation in; the output has no EXIF
        if im.mode not in ('RGB', 'RGBA', 'L', 'LA'):
            im = im.convert('RGBA' if im.mode in ('P', 'PA') and 'transparency' in im.info else 'RGB')
        # display size after rotation; the draft may already have shrunk it
        if max(im.size) > MAX_SIDE:
            k = MAX_SIDE / float(max(im.size))
            im = im.resize((max(1, round(im.size[0] * k)), max(1, round(im.size[1] * k))), Image.LANCZOS,
                           reducing_gap=3.0)
        out_fmt = _save_raster(im, out)
        pw, ph = im.size
    # physical size from an embedded scanner dpi (72/96 are screen defaults: meaningless)
    natural = None
    dpi = None
    try:
        dx = float(dpi_info[0]) if dpi_info else 0.0
    except (TypeError, ValueError, IndexError):
        dx = 0.0
    if 100 <= dx <= 2400 and round(dx) not in (72, 96):
        # dpi refers to the original pixels; the stored raster may be downscaled
        tw, th = (h, w) if (pw > ph) != (w > h) else (w, h)
        dpi = dx
        natural = [round(tw * 25.4 / dx, 2), round(th * 25.4 / dx, 2)]
    return {'px_w': pw, 'px_h': ph, 'format': out_fmt, 'pdf': False, 'page': 0, 'page_count': 1,
            'dpi': dpi, 'natural_mm': natural}


def bg_pdf_thumb(args, progress):
    """Small PNG of one PDF page (page picker)."""
    im, n, _dpi = _pdf_render(args['path'], int(args.get('page') or 0), 72.0,
                              max_side=int(args.get('max_side') or 240))
    im.save(args['out'], 'PNG', optimize=True)
    return {'page_count': n, 'px_w': im.size[0], 'px_h': im.size[1]}


def composite_png(dst, paths, w_mm, h_mm, dpi, bg):
    """PNG preview with the reference background as a faint layer under the paths.
    bg: {path, px_w, px_h, transform{x,y,scale,rotation}, opacity}."""
    import math

    from PIL import Image, ImageOps

    from ..export.png import png_image
    ink = png_image(paths, w_mm, h_mm, dpi)            # L: 255 paper, 0 ink
    k = dpi / 25.4
    base = Image.new('RGB', ink.size, (255, 255, 255))
    try:
        with Image.open(bg['path']) as src:
            src = src.convert('RGBA')
            t = bg.get('transform') or {}
            s = float(t.get('scale') or 0.1)
            th = math.radians(float(t.get('rotation') or 0.0))
            cx, cy = float(t.get('x') or 0.0), float(t.get('y') or 0.0)
            # stored px_w may differ from the file if it was replaced: use the file
            hx, hy = src.size[0] / 2.0, src.size[1] / 2.0
            sk = s * float(bg.get('px_w') or src.size[0]) / src.size[0]
            c, sn = math.cos(th), math.sin(th)
            # output pixel (X, Y) -> page mm (X/k, Y/k) -> image px (inverse of c + s R(th) (q - h))
            a, b = c / (sk * k), sn / (sk * k)
            d, e = -sn / (sk * k), c / (sk * k)
            c0 = hx - (c * cx + sn * cy) / sk
            f0 = hy - (-sn * cx + c * cy) / sk
            layer = src.transform(base.size, Image.AFFINE, (a, b, c0, d, e, f0), resample=Image.BILINEAR,
                                  fillcolor=(0, 0, 0, 0))
        op = max(0.0, min(1.0, float(bg.get('opacity', 0.5)))) * 0.6      # faint
        alpha = layer.getchannel('A').point(lambda v: int(v * op))
        base.paste(layer.convert('RGB'), (0, 0), alpha)
    except OSError:
        pass                                    # background file missing: plain preview
    base.paste((0, 0, 0), (0, 0), ImageOps.invert(ink))
    base.save(dst, 'PNG', optimize=True)
    return dst


KINDS = {'bg_prepare': bg_prepare, 'bg_pdf_thumb': bg_pdf_thumb}


# ---------------------------------------------------------------- service (parent process)
class BackgroundImports:
    def __init__(self, ctx):
        self.ctx = ctx

    @property
    def files(self):
        return self.ctx.files

    def _need(self, pdf):
        f = self.ctx.features
        if not f.get('png'):
            raise ApiError(501, 'feature_unavailable', '参考背景需要 pillow', {'feature': 'image'})
        if pdf and not f.get('pdf'):
            raise ApiError(501, 'feature_unavailable', 'PDF 背景需要 pypdfium2（pip install penplot[pdf]）',
                           {'feature': 'pdf'})

    async def _run(self, kind, args, timeout=90):
        t = self.ctx.tasks.submit(kind, args)
        res = await self.ctx.tasks.wait(t, timeout)
        if res is None:
            self.ctx.tasks.cancel(t.id)
            raise ApiError(413, 'too_complex', '处理超时：文件太复杂')
        return res

    async def _raster(self, path, page, dpi, name, source=None):
        out = os.path.join(self.ctx.cfg.upload_dir, 'bg-%s' % secrets.token_hex(8))
        try:
            res = await self._run('bg_prepare', {'path': path, 'out': out, 'page': page, 'dpi': dpi})
        except ApiError as e:
            if e.status == 500:
                raise ApiError(400, e.code if e.code != 'task_failed' else 'bad_background', e.message, e.detail)
            raise
        try:
            with open(out, 'rb') as f:
                data = f.read()
        finally:
            try:
                os.unlink(out)
            except OSError:
                pass
        stem = os.path.splitext(name)[0] or 'background'
        suffix = ('-p%d' % (res['page'] + 1)) if res.get('pdf') else ''
        ext = '.png' if res['format'] == 'png' else '.jpg'
        meta = {'px_w': res['px_w'], 'px_h': res['px_h'], 'role': 'background', 'page': res['page'],
                'page_count': res['page_count'], 'dpi': res.get('dpi'), 'natural_mm': res.get('natural_mm')}
        if source:
            meta['source_id'] = source['id']
        info = self.files.add_bytes(data, stem + suffix + ext, 'image', tags=['背景'], meta=meta)
        return {'file': info, 'source': source, 'page': res['page'], 'page_count': res['page_count'],
                'px_w': res['px_w'], 'px_h': res['px_h'], 'dpi': res.get('dpi'),
                'natural_mm': res.get('natural_mm')}

    async def upload(self, staged, name, page=0, dpi=150):
        pdf = is_pdf(staged.path)
        try:
            self._need(pdf)
        except ApiError:
            os.unlink(staged.path)
            raise
        if not pdf:
            try:
                return await self._raster(staged.path, 0, dpi, name)
            finally:
                try:
                    os.unlink(staged.path)
                except OSError:
                    pass
        try:
            res = await self._raster(staged.path, page, dpi, name)
        except ApiError:
            os.unlink(staged.path)
            raise
        src_name = name if name.lower().endswith('.pdf') else name + '.pdf'
        source = self.files.add_staged(staged, src_name, 'asset', tags=['背景'],
                                       meta={'role': 'background_source', 'pdf': True,
                                             'page_count': res['page_count']})
        # link the raster to its source (meta only; the raster is content-addressed)
        res['source'] = source
        res['file'] = self._link(res['file'], source['id'])
        return res

    def _link(self, info, source_id):
        from .db import jdump
        meta = dict(info.get('meta') or {})
        meta['source_id'] = source_id
        self.ctx.db.execute('UPDATE files SET meta=? WHERE id=?', (jdump(meta), info['id']))
        return self.files.get(info['id'])

    def _source(self, source_id):
        info = self.files.get(source_id)
        path = self.files.blob_path(info)
        if not is_pdf(path):
            raise ApiError(400, 'bad_kind', '不是 PDF 文件')
        self._need(True)
        return info, path

    async def page(self, source_id, page, dpi=150):
        info, path = self._source(source_id)
        return await self._raster(path, page, dpi, info['name'], source=info)

    async def thumb(self, source_id, page, max_side=240):
        info, path = self._source(source_id)
        out = os.path.join(self.ctx.cfg.upload_dir, 'bgt-%s.png' % secrets.token_hex(8))
        try:
            await self._run('bg_pdf_thumb', {'path': path, 'out': out, 'page': page, 'max_side': max_side}, 30)
            with open(out, 'rb') as f:
                return f.read()
        finally:
            try:
                os.unlink(out)
            except OSError:
                pass


def page_background(doc, source_page):
    """Page.background of a project page (dict) or None."""
    pages = (doc or {}).get('pages') or []
    if 0 <= source_page < len(pages):
        return pages[source_page].get('background') or None
    return None
