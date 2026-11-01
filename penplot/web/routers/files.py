from typing import Optional

from fastapi import APIRouter, File, Form, Query, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from ..deps import C, R
from ..errors import ApiError
from ..backgrounds import BackgroundImports
from ..schemas import (BackgroundImportResult, BackgroundPageRequest, FileInfo, FilePatch, GcodeImportResult,
                       ImageImportResult, TableImportResult, TaskRef, TextImportResult, TraceRequest, TraceResult,
                       VectorImportResult)
from ._util import attachment, wait_or_202

router = APIRouter(tags=['files'])

MB = 1024 * 1024


async def _read(file: UploadFile, limit_mb, request):
    c = request.app.state.ctx
    return await c.files.stage_upload(file, limit_mb * MB)


# ---------------------------------------------------------------- imports
@router.post('/import/image', response_model=ImageImportResult, status_code=201, tags=['imports'])
async def import_image(request: Request, p: C, file: UploadFile = File(...)):
    c = request.app.state.ctx
    staged = await _read(file, 20, request)
    return await c.imports.image(staged, file.filename or 'image')


@router.post('/import/image/{file_id}/trace', response_model=TraceResult,
             responses={202: {'model': TaskRef}}, tags=['imports'])
async def trace_image(file_id: str, body: TraceRequest, request: Request, p: R,
                      wait: float = Query(5.0, ge=0, le=60)):
    c = request.app.state.ctx
    task = await run_in_threadpool(c.imports.trace, file_id, body)
    return await wait_or_202(c, task, wait)


@router.post('/import/background', response_model=BackgroundImportResult, status_code=201, tags=['imports'])
async def import_background(request: Request, p: C, file: UploadFile = File(...),
                            page: int = Form(0, ge=0, le=9999), dpi: float = Form(150, ge=50, le=300)):
    """Reference background for Page.background (never printed): PNG/JPEG/WebP (EXIF rotation baked
    in, longest side <= 3000 px) or a PDF (page `page` rasterised at `dpi`; the PDF is kept as
    `source` so other pages can be picked)."""
    c = request.app.state.ctx
    staged = await _read(file, 20, request)
    return await BackgroundImports(c).upload(staged, file.filename or 'background', page, dpi)


@router.post('/import/background/{source_id}/page', response_model=BackgroundImportResult, tags=['imports'])
async def background_page(source_id: str, body: BackgroundPageRequest, request: Request, p: C):
    """Rasterise another page of an uploaded background PDF."""
    return await BackgroundImports(request.app.state.ctx).page(source_id, body.page, body.dpi)


@router.get('/import/background/{source_id}/pages/{page}/thumb.png', response_class=Response,
            responses={200: {'content': {'image/png': {}}}}, tags=['imports'])
async def background_thumb(source_id: str, page: int, request: Request, p: R, size: int = Query(240, ge=48, le=480)):
    """Small preview of one page of a background PDF (page picker)."""
    data = await BackgroundImports(request.app.state.ctx).thumb(source_id, page, size)
    return Response(data, media_type='image/png', headers={'Cache-Control': 'private, max-age=86400'})


@router.post('/import/svg', response_model=VectorImportResult, status_code=201, tags=['imports'])
async def import_svg(request: Request, p: C, file: UploadFile = File(...)):
    c = request.app.state.ctx
    staged = await _read(file, 10, request)
    return await c.imports.vector(staged, file.filename or 'drawing.svg', 'svg')


@router.post('/import/dxf', response_model=VectorImportResult, status_code=201, tags=['imports'])
async def import_dxf(request: Request, p: C, file: UploadFile = File(...)):
    c = request.app.state.ctx
    staged = await _read(file, 20, request)
    return await c.imports.vector(staged, file.filename or 'drawing.dxf', 'dxf')


@router.post('/import/gcode', response_model=GcodeImportResult, status_code=201, tags=['imports'])
async def import_gcode(request: Request, p: C, file: UploadFile = File(...)):
    c = request.app.state.ctx
    staged = await _read(file, 50, request)
    return await c.imports.gcode(staged, file.filename or 'file.gcode')


@router.post('/import/text', response_model=TextImportResult, tags=['imports'])
async def import_text(request: Request, p: R, file: UploadFile = File(...)):
    data = await file.read(5 * MB + 1)
    if len(data) > 5 * MB:
        raise ApiError(413, 'too_large', '文本文件超过 5 MB')
    return request.app.state.ctx.imports.text(data)


@router.post('/import/table', response_model=TableImportResult, status_code=201, tags=['imports'])
async def import_table(request: Request, p: C, file: UploadFile = File(...)):
    c = request.app.state.ctx
    staged = await _read(file, 20, request)
    return await c.imports.table(staged, file.filename or 'data.csv')


# ---------------------------------------------------------------- library
@router.get('/files', response_model=list[FileInfo])
def list_files(request: Request, p: R, kind: Optional[str] = None, q: Optional[str] = None,
               tag: Optional[str] = None, limit: int = Query(200, ge=1, le=5000)):
    return request.app.state.ctx.files.list(kind=kind, q=q, tag=tag, limit=limit)


@router.post('/files', response_model=FileInfo, status_code=201)
async def upload_file(request: Request, p: C, file: UploadFile = File(...),
                      kind: Optional[str] = Form(None), tags: Optional[str] = Form(None)):
    c = request.app.state.ctx
    staged = await _read(file, 100, request)
    tag_list = [t.strip() for t in (tags or '').split(',') if t.strip()]
    return await run_in_threadpool(c.files.add_staged, staged, file.filename or 'file', kind, tag_list)


@router.get('/files/{file_id}', response_model=FileInfo)
def get_file(file_id: str, request: Request, p: R):
    return request.app.state.ctx.files.get(file_id)


@router.get('/files/{file_id}/content', response_class=FileResponse)
def file_content(file_id: str, request: Request, p: R, download: int = 0):
    c = request.app.state.ctx
    info = c.files.get(file_id)
    # P11: user content is never active content on our origin
    headers = {'Cache-Control': 'private, max-age=86400',
               'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
               'X-Content-Type-Options': 'nosniff'}
    raster = info['mime'] in ('image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/gif')
    mime = info['mime']
    if download or not raster:
        headers['Content-Disposition'] = attachment(info['name'])
        if not raster:
            mime = 'application/octet-stream' if info['kind'] in ('svg', 'export', 'asset') else mime
    return FileResponse(c.files.blob_path(info), media_type=mime, headers=headers)


@router.get('/files/{file_id}/preview.svg', response_class=Response,
            responses={200: {'content': {'image/svg+xml': {}}}})
async def file_preview(file_id: str, request: Request, p: R):
    c = request.app.state.ctx
    svg = await c.files.preview_svg(file_id)
    return Response(svg, media_type='image/svg+xml', headers={'Cache-Control': 'private, max-age=3600'})


@router.patch('/files/{file_id}', response_model=FileInfo)
def patch_file(file_id: str, body: FilePatch, request: Request, p: C):
    return request.app.state.ctx.files.patch(file_id, body.name, body.tags)


@router.delete('/files/{file_id}', status_code=204)
def delete_file(file_id: str, request: Request, p: C):
    request.app.state.ctx.files.delete(file_id)
    return Response(status_code=204)
