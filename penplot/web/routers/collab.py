"""Control lease, presence, project collaboration info."""
from typing import Optional

from fastapi import APIRouter, Request

from ..deps import C, R
from ..schemas import LeaseInfo, LeaseRequest, PresenceEntry, ProjectCollab

router = APIRouter(tags=['collab'])


def _mine(info, p):
    info['mine'] = bool(info.get('held') and info['holder']['id'] == p.user_id)
    return info


@router.get('/machine/lease', response_model=LeaseInfo)
def get_lease(request: Request, p: R):
    return _mine(request.app.state.ctx.collab.lease_info(), p)


@router.post('/machine/lease', response_model=LeaseInfo,
             responses={409: {'description': 'lease_held'}})
def take_lease(request: Request, p: C, body: Optional[LeaseRequest] = None):
    """Take machine control. 409 lease_held if someone else has it (admins may force)."""
    return _mine(request.app.state.ctx.collab.take(p, force=bool(body and body.force)), p)


@router.delete('/machine/lease', response_model=LeaseInfo)
def release_lease(request: Request, p: C):
    return _mine(request.app.state.ctx.collab.release(p), p)


@router.get('/presence', response_model=list[PresenceEntry])
def presence(request: Request, p: R):
    return request.app.state.ctx.collab.presence()


@router.get('/projects/{project_id}/collab', response_model=ProjectCollab)
def project_collab(project_id: str, request: Request, p: R):
    c = request.app.state.ctx
    c.projects.get(project_id)
    return {'project_id': project_id, 'viewers': c.collab.presence(project_id),
            'locks': c.collab.lock_list(project_id)}
