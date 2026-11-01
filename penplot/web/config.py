"""Environment -> Config (plain os.environ, 03 §7.1)."""
import os
import sys
from dataclasses import dataclass, field


def _bool(v, default=False):
    if v is None or v == '':
        return default
    return str(v).strip().lower() in ('1', 'true', 'yes', 'on')


def _bundled(name):
    """Repo-root asset (configs/, seed/): the source checkout first, then
    <prefix>/share/penplot where a wheel install puts them (pyproject data-files)."""
    here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    for base in (here, os.path.join(sys.prefix, 'share', 'penplot')):
        p = os.path.join(base, name)
        if os.path.exists(p):
            return p
    return os.path.join(here, name)


def _repo_fonts():
    here = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    d = os.path.join(here, 'fonts')
    return d if os.path.isdir(d) else None


@dataclass
class Config:
    host: str = '0.0.0.0'
    port: int = 8080
    data_dir: str = '/var/lib/penplot'
    font_dir: str = ''
    cache_dir: str = '/run/penplot'
    cache_mb: int = 150
    static_dir: str = ''
    serial_port: str = ''
    task_workers: int = 2
    task_mode: str = 'process'     # process | thread (tests / debugging)
    log_level: str = 'INFO'
    dev: bool = False
    tls_cert: str = ''
    tls_key: str = ''
    dev_origins: list = field(default_factory=lambda: ['http://localhost:5173',
                                                       'http://127.0.0.1:5173'])
    fake_time_scale: float = 1.0   # FakeGrbl motion speed-up (tests)
    seed_profile: str = ''         # json used to seed the first profile
    seed_dir: str = ''             # seed/ content: papers, built-in templates, samples

    @classmethod
    def from_env(cls, env=None, **over):
        e = os.environ if env is None else env
        dev = _bool(e.get('PENPLOT_DEV'))
        data = e.get('PENPLOT_DATA_DIR') or ('~/.penplot-dev' if dev else '/var/lib/penplot')
        data = os.path.abspath(os.path.expanduser(data))
        cache = e.get('PENPLOT_CACHE_DIR')
        if not cache:
            cache = '/run/penplot' if (os.path.isdir('/run/penplot') and os.access('/run/penplot', os.W_OK)) \
                else os.path.join(data, 'cache')
        font_dir = e.get('PENPLOT_FONT_DIR') or os.path.join(data, 'fonts')
        static = e.get('PENPLOT_STATIC_DIR') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static')
        seed = e.get('PENPLOT_SEED_PROFILE') or _bundled(os.path.join('configs', 'grbl-zpen.json'))
        seed_dir = e.get('PENPLOT_SEED_DIR') or _bundled('seed')
        c = cls(
            seed_dir=os.path.abspath(os.path.expanduser(seed_dir)),
            host=e.get('PENPLOT_HOST', '0.0.0.0'),
            port=int(e.get('PENPLOT_PORT', '8080')),
            data_dir=data,
            font_dir=os.path.abspath(os.path.expanduser(font_dir)),
            cache_dir=os.path.abspath(os.path.expanduser(cache)),
            cache_mb=int(e.get('PENPLOT_CACHE_MB', '150')),
            static_dir=static,
            serial_port=e.get('PENPLOT_SERIAL_PORT', ''),
            task_workers=max(1, int(e.get('PENPLOT_TASK_WORKERS', '2'))),
            task_mode=e.get('PENPLOT_TASK_MODE', 'process'),
            log_level=e.get('PENPLOT_LOG_LEVEL', 'INFO'),
            dev=dev,
            tls_cert=e.get('PENPLOT_TLS_CERT', ''),
            tls_key=e.get('PENPLOT_TLS_KEY', ''),
            fake_time_scale=float(e.get('PENPLOT_FAKE_TIME_SCALE', '1.0')),
            seed_profile=seed,
        )
        extra = e.get('PENPLOT_DEV_ORIGINS')
        if extra:
            c.dev_origins = [o.strip() for o in extra.split(',') if o.strip()]
        for k, v in over.items():
            setattr(c, k, v)
        return c

    @property
    def db_path(self):
        return os.path.join(self.data_dir, 'penplot.db')

    @property
    def files_dir(self):
        return os.path.join(self.data_dir, 'files')

    @property
    def jobs_dir(self):
        return os.path.join(self.data_dir, 'jobs')

    @property
    def render_dir(self):
        return os.path.join(self.cache_dir, 'render')

    @property
    def upload_dir(self):
        return os.path.join(self.cache_dir, 'upload')

    @property
    def el_cache_dir(self):
        """Element path cache (image traces, svg/dxf/gcode/text paths), 03 §3.3."""
        return os.path.join(self.cache_dir, 'el')

    def ensure_dirs(self):
        for d in (self.data_dir, self.font_dir, self.files_dir, self.jobs_dir,
                  self.cache_dir, self.render_dir, self.upload_dir, self.el_cache_dir):
            os.makedirs(d, exist_ok=True)
        tmp = os.environ.get('TMPDIR')
        if tmp:
            try:
                os.makedirs(tmp, exist_ok=True)
            except OSError:
                pass
        # first dev start: seed the font dir with the repo fonts (symlinks,
        # no copy) so a fresh ~/.penplot-dev is usable at once
        if self.dev and not os.listdir(self.font_dir):
            src = _repo_fonts()
            if src:
                for fn in os.listdir(src):
                    if fn.lower().endswith(('.gfont', '.psf')):
                        try:
                            os.symlink(os.path.join(src, fn), os.path.join(self.font_dir, fn))
                        except OSError:
                            pass
