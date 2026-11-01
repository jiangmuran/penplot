"""AppContext: owns every service; lifespan start/stop; WS snapshot/commands."""
import asyncio
import importlib.util
import logging
import os
import socket
import time

import penplot

from .auth import AuthService
from .db import DB
from .errors import ApiError
from .events import EventBus

log = logging.getLogger('penplot.web')


def probe_features():
    has = lambda m: importlib.util.find_spec(m) is not None  # noqa
    img = has('numpy') and has('PIL')
    return {'image': img, 'vector': has('svgelements'), 'dxf': has('ezdxf'), 'office': has('openpyxl'),
            'ttf': img and has('fontTools'), 'png': has('PIL'), 'pdf': has('pypdfium2') and has('PIL')}


class Idempotency:
    """Idempotency-Key -> response for 30 s."""

    def __init__(self):
        self._d = {}

    async def run(self, key, fn):
        now = time.time()
        if len(self._d) > 500:
            self._d = {k: v for k, v in self._d.items() if now - v[0] < 30}
        if key:
            hit = self._d.get(key)
            if hit and now - hit[0] < 30:
                return hit[1]
        res = fn()
        if asyncio.iscoroutine(res):
            res = await res
        if key:
            self._d[key] = (now, res)
        return res


def sd_notify(msg):
    addr = os.environ.get('NOTIFY_SOCKET')
    if not addr:
        return
    if addr.startswith('@'):
        addr = '\0' + addr[1:]
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
        s.connect(addr)
        s.sendall(msg.encode())
        s.close()
    except OSError:
        pass


class AppContext:
    def __init__(self, cfg):
        self.cfg = cfg
        self.version = penplot.__version__
        self.loop = None
        self.features = probe_features()
        self._bg = []

    async def start(self):
        from .fonts import FontIndex
        from .library import Files, Imports, Papers, Projects
        from .machine.jobs import JobService
        from .machine.service import MachineService
        from .profiles import AppSettingsStore, Profiles
        from .render import RenderService
        from .sysinfo import SystemService
        from .tasks.runner import TaskRunner
        cfg = self.cfg
        self.loop = asyncio.get_running_loop()
        cfg.ensure_dirs()
        self.db = DB(cfg.db_path)
        self.db.migrate()
        self.bus = EventBus()
        self.bus.start()
        self.auth = AuthService(self.db, cfg)
        self.settings = AppSettingsStore(self.db)
        self.tasks = TaskRunner(self, cfg.task_workers, cfg.task_mode)
        self.tasks.start()
        self.papers = Papers(self.db)
        self.papers.seed()
        self.profiles = Profiles(self)
        self.profiles.seed(cfg.seed_profile)
        self.files = Files(self.db, cfg, self)
        self.imports = Imports(self)
        self.projects = Projects(self)
        self.fonts = FontIndex(self.db, cfg, self.tasks)
        self.render = RenderService(self)
        self.system = SystemService(self)
        self.idem = Idempotency()
        from .diagnostics import Diagnostics
        self.diagnostics = Diagnostics(self)
        from .collab import Collab
        self.collab = Collab(self)
        self.machine = MachineService(self)
        self.jobs = JobService(self)
        from .teletype.service import TeletypeService
        self.teletype = TeletypeService(self)
        self.machine.load_profile(self.profiles.active())
        from .seed import load_seed
        try:
            load_seed(self)
        except Exception:
            log.exception('seed')
        self.jobs.recover()
        self.fonts._load()
        if not self.fonts._rows:
            await self.loop.run_in_executor(None, self.fonts.scan)
        else:
            self.loop.run_in_executor(None, self.fonts.scan)     # pick up changes in the background
        self.auth.ensure_setup_code()
        await self.machine.start()
        self.collab.start()
        self._bg.append(asyncio.create_task(self.system.publisher()))
        self._bg.append(asyncio.create_task(self._watchdog()))
        sd_notify('READY=1')
        log.info('penplot web %s ready (data=%s, dev=%s, features=%s)', self.version, cfg.data_dir, cfg.dev,
                 self.features)

    async def stop(self):
        sd_notify('STOPPING=1')
        try:
            self.teletype._teardown()
        except Exception:
            pass
        try:
            await self.jobs.shutdown()
        except Exception:
            log.exception('job shutdown')
        for t in self._bg:
            t.cancel()
        await self.collab.stop()
        await self.machine.stop()
        self.tasks.stop()
        await self.bus.stop()
        self.db.close()

    async def _watchdog(self):
        while True:
            sd_notify('WATCHDOG=1')
            await asyncio.sleep(20)

    def attention(self, code, message, level='warning', sound=None, **data):
        """WS `attention`: something a human should notice now (sound / notification).
        Thread-safe. sound: done | paper | error | info."""
        d = {'code': code, 'level': level, 'message': message,
             'sound': sound or {'info': 'info', 'warning': 'paper', 'error': 'error'}.get(level, 'info')}
        d.update({k: v for k, v in data.items() if v is not None})
        self.bus.publish_threadsafe('attention', d)

    # ------------------------------------------------------------ WS helpers
    def snapshot(self):
        job = self.jobs.current()
        batch = None
        if job and job.get('batch_id'):
            try:
                b = self.jobs.batch(job['batch_id'])
                batch = {'id': b['id'], 'total': len(b['jobs']), 'next_job_id': b['next_job_id']}
            except ApiError:
                pass
        tt = self.teletype.state() if getattr(self, 'teletype', None) and self.teletype.session else None
        return {'machine': self.machine.status(), 'job': job, 'tasks': self.tasks.active_list(), 'batch': batch,
                'lease': self.collab.lease_info(), 'presence': self.collab.presence(), 'teletype': tt}

    async def ws_command(self, op, args, actor='-', principal=None):
        m = self.machine
        if op == 'estop':
            await m.estop(actor=actor)
            return {'machine': m.status()}
        if op != 'jog_cancel' and principal is not None:
            self.collab.check(principal)
        # P7: same pydantic models as REST
        from pydantic import ValidationError
        from .schemas import JobPause, JogRequest, PenRequest, RealtimeRequest

        def val(model):
            try:
                return model.model_validate(args)
            except ValidationError as e:
                raise ApiError(422, 'validation_error', '请求参数不合法',
                               [{'loc': list(x.get('loc', ())), 'msg': x.get('msg')} for x in e.errors()])
        j = self.jobs.active
        if op in ('pause', 'resume', 'stop'):
            if j is None:
                raise ApiError(409, 'no_job', '没有进行中的任务')
            if op == 'pause':
                return await self.jobs.pause(j.id, val(JobPause).mode)
            if op == 'resume':
                return await self.jobs.resume(j.id)
            return await self.jobs.stop(j.id)
        if op == 'jog':
            b = val(JogRequest)
            client = 'ws:%s' % ((principal.session_hash or principal.id) if principal else actor)
            return await m.jog(b.dx, b.dy, b.dz, b.feed, b.seq, deadman=True, client=client)
        if op == 'jog_cancel':
            m.jog_cancel()
            return {'ok': True}
        if op == 'pen':
            return await m.pen(val(PenRequest).state == 'up')
        if op == 'realtime':
            m.realtime(val(RealtimeRequest).byte)
            return {'ok': True}
        raise ApiError(400, 'bad_op', '未知命令 %s' % op)
