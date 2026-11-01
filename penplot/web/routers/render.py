from typing import Optional

from fastapi import APIRouter, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from ..deps import C, R
from ..schemas import FileInfo, PlacementInfo, RenderExport, RenderResult, RenderSave, RenderTextRequest, Task, TaskRef
from ._util import attachment, wait_or_202

router = APIRouter(tags=['render'])


@router.post('/render/text', response_model=RenderResult, responses={202: {'model': TaskRef}})
async def render_text(body: RenderTextRequest, request: Request, p: R,
                      wait: float = Query(5.0, ge=0, le=60)):
    c = request.app.state.ctx
    slot = request.headers.get('x-render-slot')
    task = await run_in_threadpool(c.render.submit_text, body, slot)
    return await wait_or_202(c, task, wait)


@router.get('/render/{rid}', response_model=RenderResult)
def get_render(rid: str, request: Request, p: R):
    return request.app.state.ctx.render.get(rid)


@router.get('/render/{rid}/pages/{index}/preview.svg', response_class=Response,
            responses={200: {'content': {'image/svg+xml': {}}}})
def preview_svg(rid: str, index: int, request: Request, p: R,
                space: str = Query('page', pattern='^(page|machine)$'), travel: int = 0):
    svg = request.app.state.ctx.render.preview_svg(rid, index, space, bool(travel))
    return Response(svg, media_type='image/svg+xml', headers={'Cache-Control': 'private, max-age=3600'})


@router.get('/render/{rid}/pages/{index}/placement', response_model=PlacementInfo)
def placement(rid: str, index: int, request: Request, p: R, dx_mm: float = 0.0, dy_mm: float = 0.0):
    """Where the page lands on the machine bed (machine coords, y up): work area, paper outline,
    drawing bbox, origin, frame path. dx_mm/dy_mm preview a placement shift (page mm right/down);
    apply it with job/render overrides {"placement": {"dx_mm", "dy_mm"}}."""
    return request.app.state.ctx.render.placement(rid, index, dx_mm, dy_mm)


@router.get('/render/{rid}/pages/{index}/placement.svg', response_class=Response,
            responses={200: {'content': {'image/svg+xml': {}}}})
def placement_svg(rid: str, index: int, request: Request, p: R, dx_mm: float = 0.0, dy_mm: float = 0.0):
    svg = request.app.state.ctx.render.placement_svg(rid, index, dx_mm, dy_mm)
    return Response(svg, media_type='image/svg+xml', headers={'Cache-Control': 'private, max-age=60'})


@router.get('/render/{rid}/pages/{index}/paths', response_class=Response,
            responses={200: {'content': {'application/octet-stream': {}}}})
def paths_bin(rid: str, index: int, request: Request, p: R,
              space: str = Query('page', pattern='^(page|machine)$')):
    """Binary polylines, little endian: u32 magic 'PPL1', u32 n, u32 offsets[n+1]
    (point index), f32 xy[2*offsets[n]]. Page space: mm, y down."""
    data = request.app.state.ctx.render.paths_bin(rid, index, space)
    return Response(data, media_type='application/octet-stream',
                    headers={'Cache-Control': 'private, max-age=3600'})


@router.get('/render/{rid}/pages/{index}/gcode', response_class=FileResponse)
def page_gcode(rid: str, index: int, request: Request, p: R):
    path = request.app.state.ctx.render.gcode_path(rid, index)
    return FileResponse(path, media_type='text/plain; charset=utf-8',
                        headers={'Content-Disposition': attachment('%s-p%d.gcode' % (rid, index + 1))})


@router.post('/render/{rid}/save', response_model=list[FileInfo], status_code=201)
def save_render(rid: str, body: RenderSave, request: Request, p: C):
    return request.app.state.ctx.render.save(rid, body.page, body.name)


@router.post('/render/{rid}/export', response_class=Response,
             responses={200: {'content': {'application/octet-stream': {}}}, 202: {'model': TaskRef}})
async def export_render(rid: str, body: RenderExport, request: Request, p: R):
    c = request.app.state.ctx
    data, name, mime = await run_in_threadpool(c.render.export, rid, body)
    return Response(data, media_type=mime, headers={'Content-Disposition': attachment(name)})


@router.get('/tasks', response_model=list[Task], tags=['tasks'])
def list_tasks(request: Request, p: R, state: Optional[str] = None):
    return request.app.state.ctx.tasks.list(state)


@router.get('/tasks/{task_id}', response_model=Task, tags=['tasks'])
def get_task(task_id: str, request: Request, p: R):
    return request.app.state.ctx.tasks.get(task_id).to_dict()


@router.delete('/tasks/{task_id}', response_model=Task, tags=['tasks'])
def cancel_task(task_id: str, request: Request, p: C):
    return request.app.state.ctx.tasks.cancel(task_id).to_dict()
