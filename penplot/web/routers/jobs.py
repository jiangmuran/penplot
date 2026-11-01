from typing import Optional

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import FileResponse

from ..deps import C, L, R
from ..errors import ApiError
from ..schemas import (BatchInfo, Job, JobCreate, JobFrame, JobPatch, JobPause, JobRetry, JobStart,
                       LogSlice)
from ._util import attachment

router = APIRouter(tags=['jobs'])


@router.post('/jobs', response_model=Job, status_code=201,
             responses={409: {'description': 'job_active / machine_busy'}})
async def create_job(body: JobCreate, request: Request, p: C):
    if body.start:
        request.app.state.ctx.collab.check(p)
    if body.allow_out_of_bounds and not p.is_admin:
        raise ApiError(403, 'forbidden', '只有管理员可以越界打印')
    return await request.app.state.ctx.jobs.create(body, actor=p.actor)


@router.get('/jobs', response_model=list[Job])
def list_jobs(request: Request, p: R, status: Optional[str] = None, batch_id: Optional[str] = None,
              limit: int = Query(100, ge=1, le=5000)):
    return request.app.state.ctx.jobs.list(status=status, batch_id=batch_id, limit=limit)


@router.get('/jobs/current', response_model=Job, responses={204: {'description': 'no active job'}})
def current_job(request: Request, p: R):
    j = request.app.state.ctx.jobs.current()
    if j is None:
        return Response(status_code=204)
    return j


@router.get('/jobs/{job_id}', response_model=Job)
def get_job(job_id: str, request: Request, p: R):
    return request.app.state.ctx.jobs.get(job_id)


@router.patch('/jobs/{job_id}', response_model=Job)
async def patch_job(job_id: str, body: JobPatch, request: Request, p: C):
    return await request.app.state.ctx.jobs.patch(job_id, body)


@router.post('/jobs/{job_id}/start', response_model=Job)
async def start_job(job_id: str, request: Request, p: L, body: Optional[JobStart] = None):
    b = body or JobStart()
    if b.allow_out_of_bounds and not p.is_admin:
        raise ApiError(403, 'forbidden', '只有管理员可以越界打印')
    return await request.app.state.ctx.jobs.start(job_id, b.set_zero, actor=p.actor, pen_up_confirmed=b.pen_up_confirmed,
                                                  allow_out_of_bounds=b.allow_out_of_bounds)


@router.post('/jobs/{job_id}/frame', response_model=Job)
async def frame_job(job_id: str, request: Request, p: L, body: Optional[JobFrame] = None):
    return await request.app.state.ctx.jobs.frame(job_id, body or JobFrame())


@router.post('/jobs/{job_id}/pause', response_model=Job)
async def pause_job(job_id: str, request: Request, p: L, body: Optional[JobPause] = None):
    return await request.app.state.ctx.jobs.pause(job_id, (body or JobPause()).mode)


@router.post('/jobs/{job_id}/resume', response_model=Job)
async def resume_job(job_id: str, request: Request, p: L):
    return await request.app.state.ctx.jobs.resume(job_id)


@router.post('/jobs/{job_id}/stop', response_model=Job)
async def stop_job(job_id: str, request: Request, p: L):
    return await request.app.state.ctx.jobs.stop(job_id)


@router.post('/jobs/{job_id}/estop', response_model=Job)
async def estop_job(job_id: str, request: Request, p: R):
    c = request.app.state.ctx
    await c.machine.estop(actor=p.actor)
    return c.jobs.get(job_id)


@router.post('/jobs/{job_id}/retry', response_model=Job, status_code=201)
async def retry_job(job_id: str, request: Request, p: C, body: Optional[JobRetry] = None):
    return await request.app.state.ctx.jobs.retry(job_id, (body or JobRetry()).from_line)


@router.get('/jobs/{job_id}/log', response_model=LogSlice)
def job_log(job_id: str, request: Request, p: R, since_seq: int = 0, limit: int = Query(500, ge=1, le=5000)):
    return request.app.state.ctx.jobs.log(job_id, since_seq, min(limit, 5000))


@router.get('/jobs/{job_id}/gcode', response_class=FileResponse)
def job_gcode(job_id: str, request: Request, p: R):
    c = request.app.state.ctx
    path, name = c.jobs.gcode_path(job_id)
    return FileResponse(path, media_type='text/plain; charset=utf-8',
                        headers={'Content-Disposition': attachment(name)})


@router.delete('/jobs/{job_id}', status_code=204)
def delete_job(job_id: str, request: Request, p: C):
    request.app.state.ctx.jobs.delete(job_id)
    return Response(status_code=204)


@router.get('/batches/{batch_id}', response_model=BatchInfo)
def get_batch(batch_id: str, request: Request, p: R):
    return request.app.state.ctx.jobs.batch(batch_id)


@router.post('/batches/{batch_id}/start-next', response_model=Job)
async def batch_start_next(batch_id: str, request: Request, p: L):
    return await request.app.state.ctx.jobs.start_next(batch_id, actor=p.actor)


@router.delete('/batches/{batch_id}', status_code=204)
def delete_batch(batch_id: str, request: Request, p: C):
    request.app.state.ctx.jobs.delete_batch(batch_id)
    return Response(status_code=204)
