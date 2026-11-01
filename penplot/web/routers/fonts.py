from typing import Optional

from fastapi import APIRouter, File, Form, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response

from ..deps import A, R
from ..errors import ApiError
from ..schemas import (FontConvert, FontCoverage, FontDetail, FontPatch, FontSummary, GlyphPage,
                       TaskRef)

router = APIRouter(prefix='/fonts', tags=['fonts'])

MAX_FONT = 30 * 1024 * 1024


@router.get('', response_model=list[FontSummary])
def list_fonts(request: Request, p: R, q: Optional[str] = None, covers: Optional[str] = None,
               format: Optional[str] = None, source: Optional[str] = None, hidden: bool = False):
    return request.app.state.ctx.fonts.list(q=q, covers=covers, fmt=format, source=source,
                                            include_hidden=hidden)


@router.post('/reindex', response_model=TaskRef, status_code=202)
async def reindex(request: Request, p: A):
    c = request.app.state.ctx
    t = c.tasks.submit_local('font_index', c.fonts.reindex)
    return TaskRef(task_id=t.id, kind=t.kind, state=t.state)


@router.get('/{font_id}', response_model=FontDetail)
def get_font(font_id: str, request: Request, p: R):
    return request.app.state.ctx.fonts.detail(font_id)


@router.get('/{font_id}/coverage', response_model=FontCoverage)
def coverage(font_id: str, request: Request, p: R, text: Optional[str] = None):
    return request.app.state.ctx.fonts.coverage(font_id, text)


@router.get('/{font_id}/glyphs/{codepoint}.svg', response_class=Response,
            responses={200: {'content': {'image/svg+xml': {}}}})
def glyph_svg(font_id: str, codepoint: str, request: Request, p: R):
    c = request.app.state.ctx
    try:
        cs = codepoint.lower()
        cp = int(cs[2:], 16) if cs.startswith(('u+', '0x')) else int(cs)
    except ValueError:
        raise ApiError(400, 'bad_request', 'codepoint 格式错误（十进制，或 u+XXXX / 0xXXXX）')
    svg, etag = c.fonts.glyph_svg(font_id, cp)
    if request.headers.get('if-none-match') == etag:
        return Response(status_code=304, headers={'ETag': etag})
    return Response(svg, media_type='image/svg+xml',
                    headers={'Cache-Control': 'private, max-age=86400', 'ETag': etag})


@router.get('/{font_id}/glyphs', response_model=GlyphPage)
def glyphs(font_id: str, request: Request, p: R, from_: int = Query(0, alias='from', ge=0),
           count: int = 200, text: Optional[str] = None):
    """`from` is an index into the font's sorted codepoint list; with `text` only those chars."""
    return request.app.state.ctx.fonts.glyph_page(font_id, from_, min(max(count, 1), 500), text)


@router.get('/{font_id}/sample.svg', response_class=Response,
            responses={200: {'content': {'image/svg+xml': {}}}})
async def sample(font_id: str, request: Request, p: R, text: Optional[str] = None,
                 size_mm: float = 8.0, width_mm: Optional[float] = None):
    c = request.app.state.ctx
    key, svg, args = await run_in_threadpool(c.fonts.sample_job, font_id, (text or '')[:200], size_mm, width_mm)
    if svg is None:
        if c.tasks.mode == 'process':
            # render in a long-lived worker (own font cache, nice 15): a picker
            # asking for dozens of samples must not load fonts in the main process
            t = c.tasks.submit('font_sample', args, quiet=True)
            res = await c.tasks.wait(t, 30.0)
            if res is None:
                c.tasks.cancel(t.id)
                raise ApiError(503, 'busy', '预览生成超时，请稍后再试')
            svg = res['svg']
        else:
            svg = await run_in_threadpool(c.fonts.sample_svg, font_id, args['text'], size_mm, width_mm)
        c.fonts.sample_store(key, svg)
    return Response(svg, media_type='image/svg+xml', headers={'Cache-Control': 'private, max-age=600'})


@router.post('', response_model=FontSummary, status_code=201,
             responses={202: {'model': TaskRef}})
async def upload_font(request: Request, p: A, file: UploadFile = File(...),
                      mode: str = Form('skeleton'), charset: str = Form('gb2312-1'),
                      chars: Optional[str] = Form(None), size_px: int = Form(256),
                      simplify_tol: float = Form(1.2), face_index: int = Form(0),
                      name: Optional[str] = Form(None)):
    c = request.app.state.ctx
    data = await file.read(MAX_FONT + 1)
    if len(data) > MAX_FONT:
        raise ApiError(413, 'too_large', '字体文件超过 30 MB')
    fn = file.filename or 'font'
    ext = fn.rsplit('.', 1)[-1].lower() if '.' in fn else ''
    if ext in ('gfont', 'psf'):
        return await run_in_threadpool(c.fonts.add_upload, fn, data, name)
    if ext not in ('ttf', 'otf', 'ttc', 'otc'):
        from ...ttffont import TtfError, sniff_font
        try:
            sniff_font(data)          # a TTF/OTF with a missing or odd extension
        except TtfError as e:
            if ext in ('woff', 'woff2'):
                raise ApiError(400, 'bad_format', e.message)
            raise ApiError(400, 'bad_format', '只支持 .gfont/.psf/.ttf/.otf/.ttc 字体文件')
        fn = (fn.rsplit('.', 1)[0] if '.' in fn else fn) + '.ttf'
    t = c.fonts.convert_ttf(fn, data, dict(mode=mode, charset=charset, chars=chars,
                                           size_px=size_px, simplify_tol=simplify_tol,
                                           face_index=face_index, name=name))
    return JSONResponse(TaskRef(task_id=t.id, kind=t.kind, state=t.state).model_dump(), status_code=202)


@router.post('/{font_id}/convert', response_class=Response,
             responses={200: {'content': {'application/octet-stream': {}}}})
async def convert(font_id: str, body: FontConvert, request: Request, p: R):
    c = request.app.state.ctx
    data, fname = await run_in_threadpool(c.fonts.convert, font_id, body.to)
    from urllib.parse import quote
    return Response(data, media_type='application/octet-stream',
                    headers={'Content-Disposition': "attachment; filename*=UTF-8''%s" % quote(fname)})


@router.patch('/{font_id}', response_model=FontSummary)
def patch_font(font_id: str, body: FontPatch, request: Request, p: A):
    return request.app.state.ctx.fonts.patch(font_id, body.display_name, body.hidden)


@router.delete('/{font_id}', status_code=204)
def delete_font(font_id: str, request: Request, p: A):
    request.app.state.ctx.fonts.delete(font_id)
    return Response(status_code=204)
