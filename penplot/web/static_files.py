"""SPA static serving: pre-compressed assets (.br/.gz), immutable cache for
/assets/*, no-cache index.html, SPA fallback for non-/api GETs (03 §7)."""
import mimetypes
import os

from starlette.responses import FileResponse, PlainTextResponse, Response

mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('image/svg+xml', '.svg')
mimetypes.add_type('application/manifest+json', '.webmanifest')
mimetypes.add_type('font/woff2', '.woff2')


SPA_CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
           "font-src 'self' data:; connect-src 'self' ws: wss:; worker-src 'self' blob:; object-src 'none'; "
           "frame-ancestors 'none'; base-uri 'self'; form-action 'self'")


class SpaStatic:
    def __init__(self, root):
        self.root = os.path.abspath(root)

    @property
    def present(self):
        return os.path.isfile(os.path.join(self.root, 'index.html'))

    def _resolve(self, rel):
        rel = rel.lstrip('/')
        p = os.path.abspath(os.path.join(self.root, rel))
        if not (p == self.root or p.startswith(self.root + os.sep)):
            return None
        return p if os.path.isfile(p) else None

    def response(self, path, accept_encoding=''):
        if path in ('', '/'):
            path = '/index.html'
        f = self._resolve(path)
        if f is None:
            # SPA fallback: unknown route -> index.html (but not for missing assets)
            if path.startswith('/assets/') or os.path.splitext(path)[1] in ('.js', '.css', '.map', '.png', '.woff2'):
                return PlainTextResponse('not found', status_code=404)
            f = self._resolve('index.html')
            if f is None:
                return PlainTextResponse(
                    'penplot web: SPA not built (webui/dist -> penplot/web/static). API: /api/v1/docs',
                    status_code=404)
        mime = mimetypes.guess_type(f)[0] or 'application/octet-stream'
        is_index = os.path.basename(f) == 'index.html'
        headers = {'Content-Security-Policy': SPA_CSP} if is_index else {}
        headers.update({'Cache-Control': 'no-cache' if is_index else (
            'public, max-age=31536000, immutable' if '/assets/' in f.replace(os.sep, '/') else 'public, max-age=3600'),
            'Vary': 'Accept-Encoding'})
        for enc, ext in (('br', '.br'), ('gzip', '.gz')):
            if enc in accept_encoding and os.path.isfile(f + ext):
                headers['Content-Encoding'] = enc
                return FileResponse(f + ext, media_type=mime, headers=headers)
        return FileResponse(f, media_type=mime, headers=headers)


def not_modified():
    return Response(status_code=304)
