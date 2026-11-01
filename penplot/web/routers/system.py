"""Profiles, settings, system."""
from typing import Optional

from fastapi import APIRouter, File, Form, Query, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from ..deps import A, C, R
from ..errors import ApiError
from ..schemas import (AppSettings, AuditEntry, DiagnosticsRequest, DiagnosticsResult, FakeFault, Health,
                       RecoveryInfo, LogEntry, Metrics, Profile, ProfileCreate,
                       ProfilePatch, ProfileUpdate, RestartRequest, SystemInfo, WifiInfo, WsTypes)
from ._util import attachment

router = APIRouter()


# ---------------------------------------------------------------- profiles
@router.get('/profiles', response_model=list[Profile], tags=['profiles'])
def list_profiles(request: Request, p: R):
    return request.app.state.ctx.profiles.list()


@router.post('/profiles', response_model=Profile, status_code=201, tags=['profiles'])
def create_profile(body: ProfileCreate, request: Request, p: A):
    return request.app.state.ctx.profiles.create(body.name, body.doc, body.copy_from)


@router.post('/profiles/import', response_model=Profile, status_code=201, tags=['profiles'])
async def import_profile(request: Request, p: A, files: list[UploadFile] = File(...),
                         name: Optional[str] = Form(None), type: Optional[str] = Form(None)):
    """multipart `files` (one or more): a penplot profile export / MachineConfig json, or the original
    software's settings.json + Grbl.json / Marlin.json / EBB.json / KAT.json (+ AdvancedViewData.json,
    AxesData.json), or a zip of those. Form `type` (Grbl/Marlin/Ebb/K_AT) overrides detection."""
    if type and type not in ('Grbl', 'Marlin', 'Ebb', 'K_AT'):
        raise ApiError(400, 'bad_type', 'type 只能是 Grbl / Marlin / Ebb / K_AT')
    items = []
    for f in files[:20]:
        data = await f.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ApiError(413, 'too_large', '配置文件太大')
        items.append((f.filename or 'profile.json', data))
    c = request.app.state.ctx
    if len(items) == 1 and not items[0][1][:2] == b'PK':
        try:
            d = __import__('json').loads(items[0][1].decode('utf-8-sig'))
        except ValueError:
            raise ApiError(400, 'bad_profile', '配置文件无法解析')
        if isinstance(d, dict) and ('doc' in d or ('type' in d and 'settings' in d)):
            prof = c.profiles.import_json(items[0][0], items[0][1])
            if name:
                prof = await c.profiles.patch(prof['id'], name, None)
            return prof
    return c.profiles.import_original(items, name, type)


@router.get('/profiles/{profile_id}', response_model=Profile, tags=['profiles'])
def get_profile(profile_id: str, request: Request, p: R):
    return request.app.state.ctx.profiles.get(profile_id)


@router.put('/profiles/{profile_id}', response_model=Profile, tags=['profiles'])
async def put_profile(profile_id: str, body: ProfileUpdate, request: Request, p: A):
    return await request.app.state.ctx.profiles.update(profile_id, body.name, body.doc)


@router.patch('/profiles/{profile_id}', response_model=Profile, tags=['profiles'])
async def patch_profile(profile_id: str, body: ProfilePatch, request: Request, p: A):
    return await request.app.state.ctx.profiles.patch(profile_id, body.name, body.doc)


@router.delete('/profiles/{profile_id}', status_code=204, tags=['profiles'])
def delete_profile(profile_id: str, request: Request, p: A):
    request.app.state.ctx.profiles.delete(profile_id)
    return Response(status_code=204)


@router.post('/profiles/{profile_id}/activate', response_model=Profile, tags=['profiles'])
async def activate_profile(profile_id: str, request: Request, p: A):
    return await request.app.state.ctx.profiles.activate(profile_id, actor=p.actor)


@router.get('/profiles/{profile_id}/export', response_class=Response, tags=['profiles'],
            responses={200: {'content': {'application/json': {}}}})
def export_profile(profile_id: str, request: Request, p: R):
    data, name = request.app.state.ctx.profiles.export_json(profile_id)
    return Response(data, media_type='application/json', headers={'Content-Disposition': attachment(name)})


# ---------------------------------------------------------------- settings
@router.get('/settings', response_model=AppSettings, tags=['settings'])
def get_settings(request: Request, p: R):
    return request.app.state.ctx.settings.get()


@router.patch('/settings', response_model=AppSettings, tags=['settings'])
def patch_settings(body: dict, request: Request, p: A):
    c = request.app.state.ctx
    if 'teletype' in body or 'pause_on_client_loss_s' in body:
        c.db.audit(p.actor, 'settings_change', {k: body[k] for k in ('teletype', 'pause_on_client_loss_s') if k in body})
    return c.settings.patch(body)


# ---------------------------------------------------------------- system
@router.get('/system/health', response_model=Health, tags=['system'])
def health(request: Request):
    return request.app.state.ctx.system.health()


@router.get('/system/info', response_model=SystemInfo, tags=['system'])
def info(request: Request, p: R):
    return request.app.state.ctx.system.info()


@router.get('/system/metrics', response_model=Metrics, tags=['system'])
async def metrics(request: Request, p: R):
    return await run_in_threadpool(request.app.state.ctx.system.metrics)


@router.get('/system/wifi', response_model=WifiInfo, tags=['system'])
async def wifi(request: Request, p: R):
    return await run_in_threadpool(request.app.state.ctx.system.wifi)


@router.get('/system/logs', response_model=list[LogEntry], tags=['system'])
async def logs(request: Request, p: A, n: int = Query(500, ge=1, le=5000), since: Optional[float] = None,
               priority: Optional[int] = None):
    return await run_in_threadpool(request.app.state.ctx.system.logs, min(n, 5000), since, priority)


@router.get('/system/audit', response_model=list[AuditEntry], tags=['system'])
def audit(request: Request, p: A, limit: int = Query(200, ge=1, le=2000)):
    return request.app.state.ctx.system.audit(min(limit, 2000))


@router.post('/system/restart', status_code=202, tags=['system'])
async def restart(request: Request, p: A, body: Optional[RestartRequest] = None):
    await request.app.state.ctx.system.restart((body or RestartRequest()).force)
    return JSONResponse({'ok': True}, status_code=202)


@router.post('/system/diagnostics', response_model=DiagnosticsResult, tags=['system'])
async def diagnostics(request: Request, p: C, body: Optional[DiagnosticsRequest] = None):
    """Self-test with remediation hints: serial, banner, $$ vs profile, status latency,
    optional pen up/down test (needs confirm + the control lease), WiFi, disk, memory, temp,
    fonts, clock, data dir."""
    c = request.app.state.ctx
    b = body or DiagnosticsRequest()
    if b.pen_test:
        c.collab.check(p)
    return await c.diagnostics.run(b.pen_test, b.confirm)


@router.get('/system/diagnostics', response_model=DiagnosticsResult, tags=['system'],
            responses={204: {'description': 'never run since start'}})
def last_diagnostics(request: Request, p: R):
    last = request.app.state.ctx.diagnostics.last
    return last if last else Response(status_code=204)


@router.get('/machine/recovery', response_model=RecoveryInfo, tags=['machine'])
def recovery(request: Request, p: R):
    """What happened (crash, unplug, alarm, lost origin, failed job) and the steps to get going again;
    each step may carry the API call that performs it."""
    return request.app.state.ctx.diagnostics.recovery()


@router.post('/machine/fake/fault', tags=['machine'], summary='FakeGrbl fault injection (simulator only)')
def fake_fault(body: FakeFault, request: Request, p: A):
    m = request.app.state.ctx.machine
    if m.fake is None:
        raise ApiError(409, 'not_fake', '只有连接的是模拟器时才能注入故障')
    m.fake.inject(body.kind, body.value)
    return {'ok': True, 'faults': dict(m.fake.faults)}


@router.get('/ws/types', response_model=WsTypes, tags=['ws'],
            summary='WebSocket message types (documentation only; always 404)')
def ws_types():
    """Exists only so the WS message models appear in openapi components.
    Connect to `GET /api/v1/ws` (WebSocket) instead."""
    return JSONResponse({'error': {'code': 'not_found', 'message': 'documentation only', 'detail': None}},
                        status_code=404)
