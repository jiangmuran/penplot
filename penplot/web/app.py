"""create_app(): lifespan (DB, MachineService, TaskRunner, FontIndex), routers, static."""
import contextlib
import logging

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import JSONResponse

import penplot

from . import errors
from .config import Config
from .deps import need
from .routers import auth, collab, files, fonts, jobs, machine, papers, projects, render, system, teletype, ws
from .static_files import SpaStatic

log = logging.getLogger('penplot.web')
API = '/api/v1'


def create_app(cfg: Config = None, start_services=True) -> FastAPI:
    cfg = cfg or Config.from_env()

    @contextlib.asynccontextmanager
    async def lifespan(app):
        if start_services:
            from .context import AppContext
            ctx = AppContext(cfg)
            app.state.ctx = ctx
            await ctx.start()
            try:
                yield
            finally:
                await ctx.stop()
        else:
            yield

    app = FastAPI(title='penplot web workbench API', version=penplot.__version__,
                  description='写字机 / 笔式绘图仪工作台 API。认证：Cookie 会话（不安全方法需加 '
                              '`X-Penplot: 1`）或 `Authorization: Bearer ppt_<id>_<secret>`。'
                              '错误体：`{"error":{"code","message","detail"}}`。',
                  lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.cfg = cfg
    errors.install(app)
    app.add_middleware(GZipMiddleware, minimum_size=2048, compresslevel=5)
    from .guard import BodyGuard
    app.add_middleware(BodyGuard, get_ctx=lambda: getattr(app.state, 'ctx', None))

    access = logging.getLogger('penplot.web.access')

    @app.middleware('http')
    async def _access_errors(request: Request, call_next):
        # no access log (SD card / journald noise); only 4xx/5xx at WARN
        resp = await call_next(request)
        if resp.status_code >= 400 and resp.status_code not in (401, 404, 423):
            access.warning('%s %s -> %d', request.method, request.url.path, resp.status_code)
        return resp

    for r in (auth.router, auth.users, fonts.router, papers.router, projects.router, render.router,
              files.router, jobs.router, collab.router, machine.router, system.router, teletype.router, ws.router):
        app.include_router(r, prefix=API)

    _install_openapi(app)
    read_dep = need('read')

    @app.get(API + '/openapi.json', include_in_schema=False)
    def openapi_json(request: Request):
        read_dep(request)
        return JSONResponse(app.openapi())

    @app.get(API + '/docs', include_in_schema=False)
    def swagger(request: Request):
        read_dep(request)
        return get_swagger_ui_html(openapi_url=API + '/openapi.json', title='penplot API')

    static = SpaStatic(cfg.static_dir)
    app.state.static = static

    @app.api_route('/{path:path}', methods=['GET', 'HEAD'], include_in_schema=False)
    def spa(path: str, request: Request):
        if path.startswith('api/'):
            return JSONResponse({'error': {'code': 'not_found', 'message': '接口不存在', 'detail': path}},
                                status_code=404)
        return static.response('/' + path, request.headers.get('accept-encoding', ''))

    return app


def _install_openapi(app):
    """Error responses use ErrorBody everywhere (incl. 422), not FastAPI's HTTPValidationError."""
    from fastapi.openapi.utils import get_openapi

    from .schemas import ErrorBody

    def custom():
        if app.openapi_schema:
            return app.openapi_schema
        spec = get_openapi(title=app.title, version=app.version, description=app.description,
                           routes=app.routes)
        comps = spec.setdefault('components', {}).setdefault('schemas', {})
        eb = ErrorBody.model_json_schema(ref_template='#/components/schemas/{model}')
        for k, v in eb.pop('$defs', {}).items():
            comps.setdefault(k, v)
        comps['ErrorBody'] = eb
        ref = {'$ref': '#/components/schemas/ErrorBody'}
        err = {'description': 'Error', 'content': {'application/json': {'schema': ref}}}
        for path, ops in spec.get('paths', {}).items():
            for method, op in ops.items():
                resp = op.setdefault('responses', {})
                for code in list(resp):
                    if code.startswith(('4', '5')):
                        d = resp[code].get('description') or 'Error'
                        resp[code] = {'description': d, 'content': {'application/json': {'schema': ref}}}
                resp.setdefault('default', err)
        comps.pop('HTTPValidationError', None)
        comps.pop('ValidationError', None)
        spec['servers'] = [{'url': '/'}]
        app.openapi_schema = spec
        return spec

    app.openapi = custom
