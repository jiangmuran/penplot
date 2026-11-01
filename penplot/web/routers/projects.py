from typing import Optional

from fastapi import APIRouter, File, Query, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse

from ..deps import C, R
from ..errors import ApiError
from ..schemas import (BatchRequest, BatchResult, ElementPatch, Project, ProjectCreate,
                       ProjectImportResult, ProjectSummary, ProjectUpdate, RenderRequest,
                       RenderResult, SaveAsTemplate, TaskRef)
from ._util import attachment, wait_or_202

router = APIRouter(prefix='/projects', tags=['projects'])


@router.get('', response_model=list[ProjectSummary])
def list_projects(request: Request, p: R, template: Optional[int] = None, q: Optional[str] = None,
                  limit: int = Query(200, ge=1, le=5000)):
    return request.app.state.ctx.projects.list(template=template, q=q, limit=limit)


@router.post('', response_model=Project, status_code=201)
def create_project(body: ProjectCreate, request: Request, p: C):
    return request.app.state.ctx.projects.create(body)


@router.post('/import', response_model=ProjectImportResult, status_code=201)
async def import_project(request: Request, p: C, file: UploadFile = File(...)):
    c = request.app.state.ctx
    staged = await c.files.stage_upload(file, 200 * 1024 * 1024)
    return await c.projects.import_bundle(file.filename or 'project.json', staged)


@router.get('/{project_id}/thumb.png', response_class=FileResponse,
            responses={200: {'content': {'image/png': {}}}})
def thumb(project_id: str, request: Request, p: R):
    from ..seed import thumb_path
    path = thumb_path(request.app.state.ctx, project_id)
    if not path:
        raise ApiError(404, 'not_found', '没有缩略图')
    return FileResponse(path, media_type='image/png', headers={'Cache-Control': 'private, max-age=86400'})


@router.get('/{project_id}', response_model=Project)
def get_project(project_id: str, request: Request, p: R):
    return request.app.state.ctx.projects.get(project_id)


@router.put('/{project_id}', response_model=Project,
            responses={409: {'description': 'rev_conflict'}})
def put_project(project_id: str, body: ProjectUpdate, request: Request, p: C):
    """Other viewers of the project get WS `project` {kind:'doc', rev, by}. Send `X-Conn-Id`
    (your WS conn_id) so your own client can ignore the echo."""
    return request.app.state.ctx.projects.update(project_id, body, p, request.headers.get('x-conn-id'))


@router.patch('/{project_id}/elements/{element_id}', response_model=Project)
def patch_element(project_id: str, element_id: str, body: ElementPatch, request: Request, p: C,
                  force: int = 0):
    """409 element_locked if another user holds a soft lock on it (force=1 overrides).
    Broadcasts WS `project` {kind:'element', patch} to the other viewers."""
    return request.app.state.ctx.projects.patch_element(project_id, element_id, body, p,
                                                        request.headers.get('x-conn-id'), bool(force))


@router.post('/{project_id}/duplicate', response_model=Project, status_code=201)
def duplicate(project_id: str, request: Request, p: C):
    return request.app.state.ctx.projects.duplicate(project_id)


@router.post('/{project_id}/save-as-template', response_model=Project, status_code=201)
def save_as_template(project_id: str, request: Request, p: C, body: Optional[SaveAsTemplate] = None):
    return request.app.state.ctx.projects.duplicate(project_id, as_template=True,
                                                    name=body.name if body else None)


@router.get('/{project_id}/export', response_class=Response,
            responses={200: {'content': {'application/json': {}, 'application/zip': {}}}})
def export_project(project_id: str, request: Request, p: R, zip: int = 0):
    c = request.app.state.ctx
    data, name, mime = c.projects.export_bundle(project_id, as_zip=bool(zip))
    return Response(data, media_type=mime, headers={'Content-Disposition': attachment(name)})


@router.delete('/{project_id}', status_code=204)
def delete_project(project_id: str, request: Request, p: C):
    request.app.state.ctx.projects.delete(project_id)
    return Response(status_code=204)


@router.post('/{project_id}/render', response_model=RenderResult,
             responses={202: {'model': TaskRef}})
async def render_project(project_id: str, body: RenderRequest, request: Request, p: R,
                         wait: float = Query(5.0, ge=0, le=60)):
    c = request.app.state.ctx
    slot = request.headers.get('x-render-slot')
    task = await run_in_threadpool(c.render.submit_project, project_id, body, slot)
    return await wait_or_202(c, task, wait)


@router.post('/{project_id}/batch', response_model=BatchResult,
             responses={202: {'model': TaskRef}})
async def batch(project_id: str, body: BatchRequest, request: Request, p: C,
                wait: float = Query(5.0, ge=0, le=60)):
    c = request.app.state.ctx
    task = await run_in_threadpool(c.render.submit_batch, project_id, body)
    return await wait_or_202(c, task, wait)
