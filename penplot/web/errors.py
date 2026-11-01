"""API errors -> {"error":{"code","message","detail"}}."""
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    def __init__(self, status, code, message='', detail=None, headers=None):
        super().__init__(message or code)
        self.status = status
        self.code = code
        self.message = message or code
        self.detail = detail
        self.headers = headers

    def body(self):
        return {'error': {'code': self.code, 'message': self.message, 'detail': self.detail}}


def bad_request(msg, detail=None, code='bad_request'):
    return ApiError(400, code, msg, detail)


def not_found(what='resource', detail=None):
    return ApiError(404, 'not_found', '%s 不存在' % what, detail)


def conflict(code, msg, detail=None):
    return ApiError(409, code, msg, detail)


_STATUS_CODES = {400: 'bad_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found',
                 405: 'method_not_allowed', 409: 'conflict', 413: 'too_large', 422: 'validation_error',
                 423: 'setup_required', 429: 'rate_limited', 501: 'feature_unavailable',
                 503: 'unavailable'}


_ZH = {400: '请求不正确', 401: '请先登录', 403: '没有权限', 404: '接口或资源不存在', 405: '不支持这个请求方法',
       409: '状态冲突', 413: '内容太大', 422: '请求参数不合法', 423: '请先完成初始化设置', 429: '请求太频繁，请稍后再试',
       500: '服务器内部错误', 501: '功能不可用', 503: '服务暂时不可用'}


def install(app):
    @app.exception_handler(Exception)
    async def _any(request: Request, exc: Exception):
        import logging
        logging.getLogger('penplot.web').exception('unhandled %s %s', request.method, request.url.path)
        return JSONResponse({'error': {'code': 'internal', 'message': '服务器内部错误：%s' % exc.__class__.__name__,
                                       'detail': str(exc)[:300]}}, status_code=500)

    @app.exception_handler(ApiError)
    async def _api(request: Request, exc: ApiError):
        return JSONResponse(exc.body(), status_code=exc.status, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _val(request: Request, exc: RequestValidationError):
        errs = []
        for e in exc.errors():
            errs.append({'loc': list(e.get('loc', ())), 'msg': e.get('msg'), 'type': e.get('type')})
        return JSONResponse({'error': {'code': 'validation_error', 'message': '请求参数不合法',
                                       'detail': errs}}, status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException):
        code = _STATUS_CODES.get(exc.status_code, 'error')
        msg = _ZH.get(exc.status_code, str(exc.detail))
        return JSONResponse({'error': {'code': code, 'message': msg, 'detail': str(exc.detail)}},
                            status_code=exc.status_code, headers=getattr(exc, 'headers', None))
