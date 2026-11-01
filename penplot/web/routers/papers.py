from fastapi import APIRouter, Request, Response

from ..deps import A, R
from ..schemas import PaperBase, PaperSpec

router = APIRouter(prefix='/papers', tags=['papers'])


@router.get('', response_model=list[PaperSpec])
def list_papers(request: Request, p: R):
    return request.app.state.ctx.papers.list()


@router.post('', response_model=PaperSpec, status_code=201)
def create_paper(body: PaperBase, request: Request, p: A):
    return request.app.state.ctx.papers.create(body)


@router.get('/{paper_id}', response_model=PaperSpec)
def get_paper(paper_id: str, request: Request, p: R):
    return request.app.state.ctx.papers.get(paper_id)


@router.put('/{paper_id}', response_model=PaperSpec)
def put_paper(paper_id: str, body: PaperBase, request: Request, p: A):
    return request.app.state.ctx.papers.update(paper_id, body)


@router.delete('/{paper_id}', status_code=204)
def delete_paper(paper_id: str, request: Request, p: A):
    request.app.state.ctx.papers.delete(paper_id)
    return Response(status_code=204)
