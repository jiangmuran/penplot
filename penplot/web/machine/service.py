"""MachineService: the only serial owner (03 §2.1-2.5).

Threads: core RX thread (controller), one cmd-thread (blocking core calls,
serialised), e-stop thread (on demand). Asyncio tasks: status poller,
reconnect supervisor. Every write goes through controller._wlock.
"""
import asyncio
import collections
import concurrent.futures
import errno
import glob
import logging
import os
import threading
import time

from ...machine import make_controller
from ...machine.grbl import ALARM_HINTS, STATE_TEXT
from ...settings import machine_config_from_dict
from ..errors import ApiError

log = logging.getLogger('penplot.web.machine')

GRBL_SETTING_DESC = {
    0: ('步进脉冲时间', 'μs'), 1: ('步进空闲延时', 'ms'), 2: ('步进端口反相', 'mask'),
    3: ('方向端口反相', 'mask'), 4: ('步进使能反相', 'bool'), 5: ('限位引脚反相', 'bool'),
    6: ('探针引脚反相', 'bool'), 10: ('状态报告选项', 'mask'), 11: ('拐角偏差', 'mm'),
    12: ('圆弧公差', 'mm'), 13: ('英制报告', 'bool'), 20: ('软限位', 'bool'), 21: ('硬限位', 'bool'),
    22: ('回零循环', 'bool'), 23: ('回零方向反相', 'mask'), 24: ('回零定位速度', 'mm/min'),
    25: ('回零搜索速度', 'mm/min'), 26: ('回零去抖', 'ms'), 27: ('回零退离距离', 'mm'),
    30: ('主轴最高转速', 'RPM'), 31: ('主轴最低转速', 'RPM'), 32: ('激光模式', 'bool'),
    100: ('X 每毫米步数', 'step/mm'), 101: ('Y 每毫米步数', 'step/mm'), 102: ('Z 每毫米步数', 'step/mm'),
    110: ('X 最大速度', 'mm/min'), 111: ('Y 最大速度', 'mm/min'), 112: ('Z 最大速度', 'mm/min'),
    120: ('X 加速度', 'mm/s²'), 121: ('Y 加速度', 'mm/s²'), 122: ('Z 加速度', 'mm/s²'),
    130: ('X 最大行程', 'mm'), 131: ('Y 最大行程', 'mm'), 132: ('Z 最大行程', 'mm'),
}
SERIAL_LOCK = '/run/lock/penplot-serial.lock'
RT_BYTES = {'?': b'?', '!': b'!', '~': b'~', '0x18': b'\x18', '0x85': b'\x85'}


def _alarm_info(line, job_id=None):
    code = None
    try:
        code = int(str(line).split(':', 1)[1])
    except (IndexError, ValueError):
        pass
    return {'code': code, 'text': str(line), 'hint': ALARM_HINTS.get(code, ''), 'ts': time.time(),
            'during_job_id': job_id}


def _fuser(path):
    """PID holding a device open (best effort, /proc scan)."""
    try:
        real = os.path.realpath(path)
        for pid in os.listdir('/proc'):
            if not pid.isdigit() or int(pid) == os.getpid():
                continue
            fd_dir = '/proc/%s/fd' % pid
            try:
                for fd in os.listdir(fd_dir):
                    try:
                        if os.readlink(os.path.join(fd_dir, fd)) == real:
                            return int(pid)
                    except OSError:
                        continue
            except OSError:
                continue
    except OSError:
        pass
    return None


class MachineService:
    def __init__(self, ctx):
        self.ctx = ctx
        self.cfg = ctx.cfg
        self.bus = ctx.bus
        self.ctrl = None
        self.mc = None
        self.profile = None
        self.port = None
        self.baud = 115200
        self.fake = None
        self.connecting = False
        self.error = None
        self.manual_disconnect = False
        self.origin_valid = False
        self.z_valid = False
        self.origin_epoch = 0
        self.pen_state = 'unknown'
        self.last_alarm = None
        self.estopping = False
        self._estop_done = None
        self.log_ring = collections.deque(maxlen=5000)
        self.log_seq = 0
        self._log_lock = threading.Lock()
        self._exec = concurrent.futures.ThreadPoolExecutor(1, thread_name_prefix='pp-cmd')
        self._tasks = []
        self._last_pub = None
        self._last_pub_t = 0.0
        self._banners = 0
        self._expect_banner = False   # a reset we caused on purpose (clear_hold)
        self._jog_seen = {}          # client -> (last seq, time); WiFi-retry dedupe
        self._grbl_cache = None
        self._lock_fh = None
        self.loop = None
        self.jog_active_until = 0.0
        self.pending_profile = None
        self._jog_gen = 0
        self.last_ws_jog = None

    # ------------------------------------------------------------ lifecycle
    def load_profile(self, profile):
        self.profile = profile
        doc = dict(profile['doc'])
        self.mc = machine_config_from_dict(doc)
        self.mc.settings.updateStatus = False          # we poll ourselves (§2.2)
        if self.ctrl is not None:
            self.ctrl.machine = self.mc

    @property
    def conn_cfg(self):
        return (self.profile or {}).get('doc', {}).get('connection', {}) or {}

    async def start(self):
        self.loop = asyncio.get_running_loop()
        self._tasks.append(asyncio.create_task(self._poller()))
        self._tasks.append(asyncio.create_task(self._supervisor()))

    async def stop(self):
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        await asyncio.get_running_loop().run_in_executor(None, self._close)
        self._exec.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------ helpers
    @property
    def connected(self):
        return bool(self.ctrl and self.ctrl.connected)

    def busy_reason(self):
        if self.estopping:
            return 'estop'
        tt = getattr(self.ctx, 'teletype', None)
        if tt is not None and tt.session is not None:
            r = tt.busy_reason()
            if r:
                return r
        j = self.ctx.jobs.active if hasattr(self.ctx, 'jobs') else None
        if j is None:
            return None
        if j.status in ('preparing', 'running', 'stopping'):
            return j.status
        if j.status == 'paused':
            s = j.sender
            st = (getattr(self.ctrl, 'state', 'Idle') if self.ctrl else '') or 'Idle'
            if s is not None and not s.pending and st.startswith('Idle'):
                return None
            return 'paused_draining'
        return None

    def require_connected(self):
        if not self.connected:
            raise ApiError(503, 'machine_disconnected', '机器未连接')

    def require_free(self):
        self.require_connected()
        r = self.busy_reason()
        if r:
            j = self.ctx.jobs.active
            raise ApiError(409, 'machine_busy', '任务进行中，手动操作被拒绝',
                           {'job_id': j.id if j else None, 'status': r})

    async def call(self, fn, *a, check=True):
        if check:
            self.require_free()
        else:
            self.require_connected()
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(self._exec, fn, *a)
        except RuntimeError as e:
            # the port vanished between the check and the write (USB unplug)
            if 'not connected' in str(e):
                raise ApiError(503, 'not_connected', '写字机连接已断开，请稍候自动重连或检查 USB 线')
            raise

    async def clear_hold(self):
        """GRBL is in feed hold (Hold:0/Hold:1) but no job/teletype owns it — e.g.
        the machine's own pause button, or a hold that survived a USB reconnect.
        Soft reset flushes whatever was left in the planner (never '~', which
        would resume stale moves). After a completed hold (Hold:0) GRBL keeps
        its position, so the origin stays valid."""
        self.require_connected()
        if self.ctx.jobs.active is not None:
            raise ApiError(409, 'job_active', '有任务占用机器：请在任务里继续或停止')
        tt = getattr(self.ctx, 'teletype', None)
        if tt is not None and tt.session is not None:
            raise ApiError(409, 'teletype_active', '电传打字机会话占用着机器，请先结束会话')
        st = (getattr(self.ctrl, 'state', '') or '')
        if not st.startswith('Hold'):
            return self.status()
        complete = st.startswith('Hold:0')
        before = self._banners
        self._expect_banner = True
        try:
            self.rt(b'\x18')
            for _ in range(30):                     # banner within ~3 s
                await asyncio.sleep(0.1)
                if self._banners > before:
                    break
        finally:
            self._expect_banner = False
        loop = asyncio.get_running_loop()
        for _ in range(15):
            await asyncio.sleep(0.2)
            s2 = await loop.run_in_executor(self._exec, self.ctrl.query_status, 1.0) \
                if hasattr(self.ctrl, 'query_status') else 'Idle'
            if s2 and not s2.startswith('Hold'):
                break
        if not complete:
            self.origin_valid = False
            self.z_valid = False
        return self.status()

    def submit(self, fn, *a):
        """Run on the cmd-thread from any thread; returns a Future."""
        return self._exec.submit(fn, *a)

    def rt(self, b):
        """Realtime byte: straight to the port under the write lock."""
        if not self.ctrl or not self.ctrl.connected:
            raise ApiError(503, 'machine_disconnected', '机器未连接')
        self.ctrl.write_realtime(b)

    def _log(self, direction, text):
        with self._log_lock:
            self.log_seq += 1
            self.log_ring.append((self.log_seq, time.time(), direction, text))
        self.bus.log_line(direction, text)

    def log_slice(self, since_seq=0, limit=500):
        with self._log_lock:
            items = [x for x in self.log_ring if x[0] > since_seq][:limit]
            nxt = self.log_seq
        return {'lines': [{'seq': s, 't': t, 'dir': d, 'text': x} for s, t, d, x in items],
                'next_seq': items[-1][0] if items else nxt}

    def _on_log(self, msg):
        if msg.startswith('>>> '):
            self._log('>', msg[4:])
        elif msg.startswith('<<< '):
            if not msg.startswith('<<< <'):        # status reports are not logged (4 Hz noise)
                self._log('<', msg[4:])
        else:
            self._log('!', msg)

    def _on_event(self, ev):
        """RX thread: O(1) work, discrete events to the loop."""
        t = ev.type
        if t == 'alarm':
            job = self.ctx.jobs.active
            self.last_alarm = _alarm_info(ev.data, job.id if job else None)
            if self.last_alarm['code'] in (1, 2, 3, 6, 7, 8, 9, 10):
                self._invalidate_origin()
            self.bus.publish_threadsafe('alarm', {k: v for k, v in self.last_alarm.items() if k != 'ts'})
            self.ctx.attention('alarm', '写字机报警（%s）%s' % (self.last_alarm['text'],
                               ('：' + self.last_alarm['hint']) if self.last_alarm['hint'] else ''),
                               'error', 'error', alarm_code=self.last_alarm['code'])
        elif t == 'connected':
            self._banners += 1
            if self._banners > 1 and not self.estopping and not self._expect_banner:
                # unexpected banner = MCU reset (DTR, brown-out, foreign 0x18)
                self._invalidate_origin()
                self.bus.publish_threadsafe('notice', {'level': 'warning', 'code': 'origin_invalid',
                                                       'message': '机器已复位，请抬笔并重新设零'})
        elif t == 'disconnected':
            if ev.data not in ('closed',):
                self.bus.publish_threadsafe('notice', {'level': 'error', 'code': 'disconnected',
                                                       'message': '串口断开：%s' % ev.data})
                self.ctx.attention('serial_lost', '和写字机的连接断开了（USB 线？电源？）', 'error', 'error')
            self._invalidate_origin()
            if self.loop:
                self.loop.call_soon_threadsafe(self._publish_status, True)

    def _invalidate_origin(self):
        self.origin_valid = False
        self.z_valid = False
        self.pen_state = 'unknown'
        self.origin_epoch += 1

    # ------------------------------------------------------------ status
    def pen_status(self):
        c = self.ctrl
        if c is None or not c.connected:
            return 'unknown'
        j = self.ctx.jobs.active
        if j is not None and j.sender is not None and j.status in ('running', 'stopping'):
            return 'down' if j.sender._stream_pen_down else 'up'
        if self.z_valid and getattr(c, 'wpos', None) and self.mc.grbl.type == 'Stepper':
            z = c.wpos[2]
            g = self.mc.grbl
            return 'down' if abs(z - g.zOn) < abs(z - g.zOff) else 'up'
        return self.pen_state

    def status(self):
        c = self.ctrl
        j = self.ctx.jobs.active if hasattr(self.ctx, 'jobs') else None
        conn = self.connected
        g = (lambda k, d=None: getattr(c, k, d)) if (c is not None and conn) else (lambda k, d=None: d)
        st = g('state', '') or ''
        if conn and not hasattr(c, 'query_status') and not st:
            st = 'Idle' if not (j and j.status in ('running', 'stopping')) else 'Run'
        base = st.split(':')[0]
        r = lambda v: [round(x, 3) for x in v] if v else None  # noqa
        buf = g('buf')
        return {
            'connected': conn, 'connecting': self.connecting, 'port': self.port or self.conn_cfg.get('port'),
            'baud': self.baud, 'fake': self.fake is not None and conn,
            'firmware': (c.firmware_version if c else '') or '',
            'machine_type': self.mc.type if self.mc else None,
            'profile_id': (self.profile or {}).get('id'), 'profile_name': (self.profile or {}).get('name'),
            'grbl_state': st, 'state_text': STATE_TEXT.get(base, base) if conn else '未连接',
            'wpos': r(g('wpos')), 'mpos': r(g('mpos')), 'wco': r(g('wco')), 'feed': g('feed'),
            'spindle': g('spindle'),
            'buf': {'planner': buf[0], 'rx': buf[1]} if buf else {'planner': None, 'rx': None},
            'ov': list(g('ov')) if g('ov') else None, 'pins': g('pins', '') or '',
            'pen': self.pen_status(), 'origin_valid': self.origin_valid and conn,
            'last_alarm': self.last_alarm, 'job_id': j.id if j else None,
            'teletype': bool(getattr(self.ctx, 'teletype', None) and self.ctx.teletype.session),
            'busy': (not conn) or bool(self.busy_reason()), 'error': self.error,
            'updated_at': (g('status_time') or time.time()),
        }

    def _publish_status(self, force=False):
        s = self.status()
        key = {k: v for k, v in s.items() if k != 'updated_at'}
        now = time.time()
        if force or key != self._last_pub or now - self._last_pub_t > 5.0:
            self._last_pub = key
            self._last_pub_t = now
            self.bus.publish('status', s)

    async def _poller(self):
        last_prog = 0.0
        while True:
            try:
                j = self.ctx.jobs.active
                active = j is not None and j.status in ('preparing', 'running', 'paused', 'stopping')
                tt = getattr(self.ctx, 'teletype', None)
                active = active or (tt is not None and tt.session is not None)
                jogging = time.time() < self.jog_active_until
                if self.estopping:
                    interval = 0.1
                elif active or jogging:
                    interval = 1.0 / max(1.0, min(5.0, float(self.ctx.settings.value('poll_hz', 4.0))))
                elif self.connected:
                    interval = 1.0
                else:
                    interval = 0.5
                if self.connected and hasattr(self.ctrl, 'query_status'):
                    try:
                        self.ctrl.write_realtime(b'?')
                    except Exception:
                        pass
                await asyncio.sleep(min(interval, 0.25) if (active or jogging) else interval)
                self._publish_status(force=active or jogging)
                if tt is not None and tt.session is not None:
                    tt.tick()
                lj = self.last_ws_jog
                if lj is not None and time.time() - lj[1] > 1.0:
                    # deadman: hold-to-jog client stopped sending steps
                    self.last_ws_jog = None
                    if self.connected and (getattr(self.ctrl, 'state', '') or '').startswith('Jog'):
                        self.jog_cancel()
                if j is not None and j.status == 'running':
                    await self._client_loss_check(j)
                if active and j is not None and time.time() - last_prog >= 0.5:
                    last_prog = time.time()
                    p = self.ctx.jobs.progress()
                    if p:
                        self.bus.publish('progress', p)
                    self.ctx.jobs.checkpoint()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception('poller')
                await asyncio.sleep(1.0)

    async def _client_loss_check(self, j):
        """settings.pause_on_client_loss_s: soft-pause a running job when every WS
        client that watched it has been gone that long (armed only after a
        client was seen during the job, so headless script jobs are not paused)."""
        now = time.time()
        if any(getattr(s, 'user', None) for s in self.bus.subs):
            j.ws_seen = now
            return
        lim = self.ctx.settings.value('pause_on_client_loss_s', 120)
        seen = getattr(j, 'ws_seen', None)
        if not lim or seen is None or now - seen < float(lim):
            return
        j.ws_seen = None
        try:
            await self.ctx.jobs.pause(j.id, 'soft')
            self.ctx.attention('client_loss_pause', '所有网页都断开了 %d 秒，任务已自动暂停（笔已抬起）' % int(float(lim)),
                               'warning', 'error', job_id=j.id)
        except ApiError:
            pass

    async def _supervisor(self):
        delay = 2.0
        while True:
            try:
                await asyncio.sleep(delay)
                if self.ctrl is not None and self.ctrl.connected and not self.ctrl.rx_alive:
                    self.ctrl._lost('rx thread died')
                if self.ctrl is not None and not self.ctrl.connected and not self.connecting:
                    await asyncio.get_running_loop().run_in_executor(None, self._close)
                if self.connected or self.connecting or self.manual_disconnect:
                    delay = 2.0
                    continue
                cc = self.conn_cfg
                if not cc.get('auto_connect', True) and not self.cfg.serial_port:
                    continue
                port = self._resolve_port(None)
                if port == 'fake' or os.path.exists(port):
                    try:
                        await self.connect(None, None, None, auto=True)
                        delay = 2.0
                    except ApiError as e:
                        self.error = '%s: %s' % (e.code, e.message)
                        delay = min(10.0, delay * 1.5)
                else:
                    delay = min(10.0, delay * 1.5)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception('supervisor')

    # ------------------------------------------------------------ connect
    def _resolve_port(self, port):
        from ..profiles import DEFAULT_CONNECTION
        return port or self.cfg.serial_port or self.conn_cfg.get('port') or DEFAULT_CONNECTION['port']

    def ports(self):
        out = []
        byid = {}
        for p in glob.glob('/dev/serial/by-id/*'):
            byid[os.path.realpath(p)] = p
        try:
            from serial.tools import list_ports
            items = list(list_ports.comports())
        except Exception:
            items = []
        seen = set()
        for it in items:
            real = os.path.realpath(it.device)
            seen.add(real)
            out.append({'path': it.device, 'by_id': byid.get(real), 'description': it.description or '',
                        'vid': '%04x' % it.vid if it.vid else None, 'pid': '%04x' % it.pid if it.pid else None,
                        'busy_pid': _fuser(it.device)})
        for real, p in byid.items():
            if real not in seen:
                out.append({'path': real, 'by_id': p, 'description': '', 'vid': None, 'pid': None,
                            'busy_pid': _fuser(real)})
        if self.cfg.dev or self.cfg.serial_port == 'fake':
            out.append({'path': 'fake', 'by_id': None, 'description': 'FakeGrbl 模拟器', 'vid': None,
                        'pid': None, 'busy_pid': None})
        return out

    async def connect(self, port=None, baud=None, reset=None, auto=False):
        if self.connected:
            return self.status()
        if self.connecting:
            raise ApiError(409, 'connecting', '正在连接')
        self.connecting = True
        self.manual_disconnect = False
        self._publish_status(True)
        try:
            await asyncio.get_running_loop().run_in_executor(
                self._exec, self._connect_blocking, port, baud, reset)
        finally:
            self.connecting = False
        self._publish_status(True)
        self.bus.publish('notice', {'level': 'info', 'code': 'connected',
                                    'message': '已连接 %s' % self.port})
        return self.status()

    def _connect_blocking(self, port, baud, reset):
        port = self._resolve_port(port)
        baud = int(baud or self.conn_cfg.get('baud') or 115200)
        if reset is None:
            reset = bool(self.conn_cfg.get('reset_on_connect', False))
        self._close()
        ser = None
        fake = None
        if port == 'fake':
            if not (self.cfg.dev or self.cfg.serial_port == 'fake' or getattr(self.cfg, 'allow_fake', False)):
                raise ApiError(400, 'fake_not_allowed', '模拟器只在开发模式可用')
            from .fake import FakeGrbl, FakeMarlin
            if self.mc.type in ('Marlin', 'K_AT'):
                fake = FakeMarlin()
            else:
                fake = FakeGrbl(time_scale=self.cfg.fake_time_scale, faults=os.environ.get('PENPLOT_FAKE_FAULTS'))
            ser = fake
        else:
            if not os.path.exists(port):
                self.error = 'not_found: %s' % port
                raise ApiError(503, 'port_not_found', '串口不存在：%s' % port)
            self._take_lock()
        ctrl = make_controller(self.mc, on_log=self._on_log)
        ctrl.add_event_listener(self._on_event)
        self._banners = 0
        try:
            ctrl.open(port, baud, exclusive=True, reset=bool(reset), ser=ser)
        except Exception as e:
            self._release_lock()
            en = getattr(e, 'errno', None)
            msg = str(e)
            if en in (errno.EBUSY, errno.EAGAIN) or 'busy' in msg.lower() or 'exclusive' in msg.lower():
                pid = _fuser(port)
                self.error = 'port_busy' + (': pid %d' % pid if pid else '')
                raise ApiError(409, 'port_busy', '串口被占用' + ('（PID %d）' % pid if pid else ''),
                               {'busy_pid': pid})
            self.error = msg
            raise ApiError(503, 'connect_failed', '打开串口失败：%s' % msg)
        self.ctrl, self.port, self.baud, self.fake = ctrl, port, baud, fake
        # DTR auto-reset boards need ~2 s for bootloader + banner
        end = time.time() + (2.5 if (reset or port != 'fake') else 1.0)
        while time.time() < end and not ctrl.firmware_version:
            time.sleep(0.05)
        st = ctrl.query_status(1.5) if hasattr(ctrl, 'query_status') else None
        if st is None and not ctrl.firmware_version:
            self._close()
            self.error = 'no_response'
            raise ApiError(503, 'no_response', '机器无响应（波特率/固件？）')
        self.error = None
        self._invalidate_origin()
        if st and st.startswith('Alarm'):
            self.last_alarm = _alarm_info('ALARM', None)
            self.last_alarm['hint'] = '机器处于报警锁定状态：检查后解锁（$X）'
        log.info('connected %s @ %d firmware=%s state=%s', port, baud, ctrl.firmware_version, st)

    def _take_lock(self):
        import fcntl
        path = os.environ.get('PENPLOT_SERIAL_LOCK', SERIAL_LOCK)
        try:
            fh = open(path, 'a+')
        except OSError:
            return
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            fh.close()
            raise ApiError(409, 'port_busy', '串口被其它 penplot 进程占用（CLI print/tool？）')
        self._lock_fh = fh

    def _release_lock(self):
        if self._lock_fh:
            try:
                self._lock_fh.close()
            except Exception:
                pass
            self._lock_fh = None

    def _close(self):
        c = self.ctrl
        if c is not None:
            try:
                c.close()
            except Exception:
                pass
            if self.fake is not None:
                self.fake.close()
        self.ctrl = None
        self.fake = None
        self._release_lock()

    async def disconnect(self):
        j = self.ctx.jobs.active
        if j is not None:
            raise ApiError(409, 'job_active', '任务进行中，不能断开', {'job_id': j.id})
        self.manual_disconnect = True
        await asyncio.get_running_loop().run_in_executor(self._exec, self._close)
        self._invalidate_origin()
        self._publish_status(True)
        return self.status()

    # ------------------------------------------------------------ manual control
    def _check_ok(self, ok, what):
        if ok is False:
            raise ApiError(409, 'command_failed', '%s 失败（固件拒绝或超时）' % what)

    async def jog(self, dx, dy, dz=0.0, feed=None, seq=None, deadman=False, client=''):
        """P7/P8: bounds here (not only in the REST model); a jog_cancel issued
        after this call was queued drops it (generation counter); deadman steps
        (WS hold-to-jog) are capped to ~300 ms of travel."""
        import math
        vals = [float(dx), float(dy), float(dz)] + ([float(feed)] if feed is not None else [])
        if not all(math.isfinite(v) for v in vals):
            raise ApiError(422, 'validation_error', '点动参数必须是有限数字')
        if abs(dx) > 50 or abs(dy) > 50 or abs(dz) > 20:
            raise ApiError(422, 'jog_too_far', '单次点动 XY ≤ 50 mm、Z ≤ 20 mm')
        fmax = 20000.0
        if self._grbl_cache:
            try:
                fmax = min(float(x['value']) for x in self._grbl_cache[1] if x['n'] in (110, 111))
            except ValueError:
                pass
        f = float(feed or self.mc.settings.jogSpeed)
        if not 1 <= f <= fmax:
            raise ApiError(422, 'bad_feed', '点动速度必须在 1–%d mm/分 之间' % fmax)
        if dz and self.z_valid and getattr(self.ctrl, 'wpos', None) and self.mc.grbl.type == 'Stepper':
            g = self.mc.grbl
            lo, hi = sorted((float(g.zOn), float(g.zOff)))
            nz = self.ctrl.wpos[2] + dz
            if nz < lo - 10 or nz > hi + 1:
                raise ApiError(422, 'z_out_of_range', 'Z 点动后会到 %.1f mm，超出 %.1f…%.1f mm' % (nz, lo - 10, hi + 1))
        if deadman:
            cap = f / 60.0 * 0.3
            d = math.sqrt(dx * dx + dy * dy + dz * dz)
            if d > cap > 0:
                k = cap / d
                dx, dy, dz = dx * k, dy * k, dz * k
        gen = self._jog_gen
        if seq is not None:
            # F4: dedupe only a retried request: same client AND same seq within
            # 5 s. A reloaded page / second device restarts its seq at 1 and must
            # not be swallowed by another client's (or an older page's) counter.
            # Per client: within a 5 s burst a seq <= the last one is a WiFi retry
            # or a late/reordered packet -> ignore. After 5 s of no jogs from that
            # client any seq is accepted (a reloaded page restarts at 1).
            now = time.monotonic()
            self._jog_seen = {k: v for k, v in self._jog_seen.items() if now - v[1] < 5.0}
            prev = self._jog_seen.get(client or '')
            if prev is not None and int(seq) <= prev[0]:
                return self.status()
            self._jog_seen[client or ''] = (int(seq), now)
        for v in (dx, dy):
            if abs(float(v)) > 50:
                raise ApiError(400, 'jog_too_far', '单次点动不能超过 50 mm')
        self.require_free()
        self.jog_active_until = time.time() + 1.5

        def run():
            if gen != self._jog_gen:
                return True                    # cancelled while queued (P8)
            self._pre_move()
            return self.ctrl.jog(dx, dy, dz, f)
        ok = await self.call(run)
        self._check_ok(ok, '点动')
        if dz:
            self.z_valid = self.z_valid  # Z moved relative: reference stays
            self.pen_state = 'unknown' if not self.z_valid else self.pen_state
        return self.status()

    def jog_cancel(self):
        self._jog_gen += 1                     # drop jog steps still queued on the cmd-thread
        self.last_ws_jog = None
        if self.connected and hasattr(self.ctrl, 'query_status'):
            self.rt(b'\x85')

    async def zero(self, axes='xy'):
        self.require_free()

        def run():
            ok = self.ctrl.set_zero(axes)
            if ok:
                if 'x' in axes and 'y' in axes:
                    self.origin_valid = True
                if 'z' in axes:
                    self.z_valid = True
                    self.pen_state = 'up'
                self.origin_epoch += 1
            return ok
        ok = await self.call(run)
        self._check_ok(ok, '设零')
        self._publish_status(True)
        return self.status()

    async def pen(self, up):
        self.require_free()
        ok = await self.call(self.ctrl.set_pen, up)
        self._check_ok(ok, '抬笔' if up else '落笔')
        self.pen_state = 'up' if up else 'down'
        return self.status()

    async def goto_origin(self):
        if not self.origin_valid:
            raise ApiError(409, 'origin_invalid', '原点无效，请先设零')
        def run():
            self._pre_move()
            return self.ctrl.go_home()
        ok = await self.call(run)
        self._check_ok(ok, '回原点')
        self.pen_state = 'up'
        return self.status()

    async def homing(self):
        ok = await self.call(self.ctrl.home_axes)
        if not ok:
            raise ApiError(409, 'homing_failed', '回零失败（$22 未开启或无限位开关）')
        self.origin_valid = False
        return self.status()

    async def unlock(self):
        ok = await self.call(self.ctrl.unlock, check=False) if not self.ctx.jobs.active else \
            await self.call(self.ctrl.unlock)
        self._check_ok(ok, '解锁')
        self.last_alarm = None
        return self.status()

    async def sleep(self):
        ok = await self.call(self.ctrl.sleep)
        self._check_ok(ok, '休眠')
        return self.status()

    async def soft_reset(self, actor='-'):
        self.require_connected()
        if self.ctx.jobs.active:
            raise ApiError(409, 'job_active', '任务进行中：请使用急停')
        self.estopping = True       # an expected banner
        try:
            self.rt(b'\x18')
            await asyncio.sleep(0.5)
        finally:
            self.estopping = False
        self._invalidate_origin()
        self.ctx.db.audit(actor, 'soft_reset')
        return self.status()

    async def frame(self, bbox, feed=None, z='up', corners_only=False):
        self.require_free()
        if not self.origin_valid:
            raise ApiError(409, 'origin_invalid', '原点无效，请先设零')
        import math
        from ...layout import OriginSpec, check_bounds
        if not all(math.isfinite(float(v)) for v in bbox) or bbox[0] > bbox[2] or bbox[1] > bbox[3]:
            raise ApiError(422, 'validation_error', '边框坐标不合法')
        wa = (self.profile or {}).get('doc', {}).get('work_area') or {}
        ax = self.mc.axes
        bad = check_bounds(bbox, float(wa.get('w_mm', 0)), float(wa.get('h_mm', 0)),
                           OriginSpec.from_axes(ax))
        if bad:
            raise ApiError(409, 'out_of_work_area', '边框超出工作区（%s）' % ', '.join(bad), {'bbox': bbox})
        if feed is not None and not 1 <= float(feed) <= 20000:
            raise ApiError(422, 'bad_feed', '速度必须在 1–20000 mm/分')
        self.jog_active_until = time.time() + 600
        try:
            ok = await self.call(self._frame_blocking, bbox, feed, z, corners_only)
        finally:
            self.jog_active_until = time.time() + 1.0
        self._check_ok(ok, '走边框')
        return self.status()

    def _pre_move(self):
        """cmd-thread, before a manual move: with a paused job, require a FRESH
        Idle report and remember where to return to on resume."""
        a = self.ctx.jobs.active
        if a is None or a.status != 'paused':
            return
        st = self.ctrl.query_status(1.0) or ''
        if not st.startswith('Idle') or (a.sender is not None and a.sender.pending):
            raise ApiError(409, 'machine_busy', '暂停中的缓冲还没走完，请稍候', {'job_id': a.id})
        self.ctx.jobs.note_manual_move()

    def _frame_blocking(self, bbox, feed, z, corners_only):
        self._pre_move()
        c = self.ctrl
        g = self.mc.grbl
        feed = int(feed or self.mc.settings.jogSpeed)
        start = getattr(c, 'wpos', None) or (0.0, 0.0, 0.0)
        x0, y0, x1, y1 = [float(v) for v in bbox]
        if not c.set_pen(True):
            return False
        if z == 'down_light' and g.type == 'Stepper':
            zl = g.zOff + (g.zOn - g.zOff) * 0.5
            if not c.send('G1G90 Z%.3fF%d' % (zl, g.zSpeed), True):
                return False
        pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
        for i, (x, y) in enumerate(pts):
            if not c.send('G90 G1 X%.3fY%.3fF%d' % (x, y, feed), True):
                return False
            if corners_only and i < 4:
                c.send('G4 P0.5', True)
        c.set_pen(True)
        c.send('G90 G0 X%.3fY%.3f' % (start[0], start[1]), True)
        return c.wait_idle(120) if hasattr(c, 'wait_idle') else True

    @staticmethod
    def check_raw_line(line):
        """P18: one printable-ASCII line, no realtime chars, no EEPROM/boot-block writes."""
        from ...machine.base import line_problem
        if '\n' in line or '\r' in line:
            raise ApiError(400, 'bad_command', '一次只能发送一行命令')
        why = line_problem(line.strip())
        if why:
            raise ApiError(400, 'bad_command', '命令不能发送：%s' % why)
        u = line.strip().upper().replace(' ', '')
        for bad in ('$N', '$RST', '$I=', '$SLP'):
            if u.startswith(bad):
                raise ApiError(400, 'bad_command', '%s 不能用原始命令发送（会改写启动块/EEPROM 或让机器休眠），'
                               '请用对应的功能按钮' % bad)
        import re as _re
        if _re.match(r'^\$\d+=', u):     # F8: only $n=value settings writes; $J= jogs are fine
            raise ApiError(400, 'bad_command', '$n=值 请通过「GRBL 设置」修改（会做校验并备份）')

    async def command(self, line, timeout_s=10.0, actor='-'):
        self.check_raw_line(line)
        self.require_free()
        self.ctx.db.audit(actor, 'raw_cmd', {'line': line})
        res = await self.call(self._command_blocking, line, timeout_s)
        return res

    def _command_blocking(self, line, timeout):
        c = self.ctrl
        lines = []
        done = threading.Event()
        result = {'ok': False}

        def h(ev):
            if ev.type == 'line':
                if ev.data.startswith('<'):
                    return
                lines.append(ev.data)
                low = ev.data.lower()
                if low == 'ok':
                    result['ok'] = True
                    done.set()
                elif low.startswith('error') or low.startswith('alarm'):
                    done.set()
        c.add_event_listener(h)
        try:
            c.send(line, False)
            done.wait(timeout)
        finally:
            c.remove_event_listener(h)
        up = line.strip().upper().replace(' ', '')
        if up.startswith('G10') or up.startswith('G92'):
            self.origin_epoch += 1
        return {'ok': result['ok'], 'reply_lines': lines}

    def realtime(self, name):
        name = name.strip()
        j = self.ctx.jobs.active
        if name in ('!', '~') and j is not None:
            # keep the job state machine in sync: map to job hold/resume
            fut = asyncio.run_coroutine_threadsafe(
                self.ctx.jobs.pause(j.id, 'hold') if name == '!' else self.ctx.jobs.resume(j.id), self.loop) \
                if threading.current_thread() is not threading.main_thread() else None
            if fut is None:
                asyncio.ensure_future(self.ctx.jobs.pause(j.id, 'hold') if name == '!'
                                      else self.ctx.jobs.resume(j.id))
            return
        if name == '0x18' and j is not None:
            raise ApiError(409, 'job_active', '任务进行中：请使用急停')
        b = RT_BYTES.get(name)
        if b is None:
            try:
                v = int(name, 16)
            except ValueError:
                raise ApiError(400, 'bad_byte', '不支持的实时命令')
            if not 0x90 <= v <= 0x9D:
                raise ApiError(400, 'bad_byte', '不支持的实时命令')
            b = bytes([v])
        self.rt(b)
        if b == b'\x18':
            self._invalidate_origin()

    async def grbl_settings(self, refresh=False):
        now = time.time()
        if self._grbl_cache and not refresh and now - self._grbl_cache[0] < 60:
            return self._grbl_cache[1]
        if self.busy_reason() and self._grbl_cache:
            return self._grbl_cache[1]
        params = await self.call(self.ctrl.read_grbl_settings)
        if params is None:
            raise ApiError(503, 'no_response', '读取 $$ 失败')
        out = []
        for n in sorted(params):
            d, u = GRBL_SETTING_DESC.get(n, ('', ''))
            out.append({'n': n, 'value': params[n], 'desc': d, 'unit': u})
        self._grbl_cache = (now, out)
        return out

    async def write_grbl_settings(self, diff, actor='-'):
        cur = {s['n']: s['value'] for s in await self.grbl_settings(True)}
        todo = []
        import math
        for k, v in diff.items():
            try:
                n = int(str(k).lstrip('$'))
            except ValueError:
                raise ApiError(400, 'bad_setting', '设置编号错误：%s' % k)
            if n not in cur and n not in GRBL_SETTING_DESC:
                raise ApiError(400, 'bad_setting', '未知的设置 $%d' % n)
            try:
                fv = float(v)
            except (TypeError, ValueError):
                raise ApiError(400, 'bad_setting', '$%d 的值必须是数字' % n)
            if not math.isfinite(fv) or fv < 0 or fv > 1e6:
                raise ApiError(400, 'bad_setting', '$%d 的值超出范围' % n)
            sv = ('%d' % fv) if fv == int(fv) else ('%.4f' % fv).rstrip('0')
            try:
                same = n in cur and float(cur[n]) == float(sv)
            except ValueError:
                same = cur.get(n) == sv
            if not same:
                todo.append((n, sv))

        def run():
            failed = []
            for n, sv in todo:
                if not self.ctrl.send('$%d=%s' % (n, sv), True):
                    failed.append(n)
            return failed
        failed = await self.call(run)
        self.ctx.db.audit(actor, 'grbl_set', {'changes': dict((str(n), v) for n, v in todo), 'failed': failed})
        if failed:
            raise ApiError(409, 'grbl_set_failed', '部分设置写入失败', {'failed': failed})
        return await self.grbl_settings(True)

    async def macro(self, n):
        from ...machine.base import UnsafeGcode, sanitize_line
        text = getattr(self.mc.advanced, 'macro%d' % n, '') or ''
        try:
            lines = [sanitize_line(x, k, allow_dollar=False) for k, x in enumerate(text.split('\n'), 1)]
        except UnsafeGcode as e:
            raise ApiError(400, 'unsafe_gcode', '宏 %d 第 %s 行不能发送：%s' % (n, e.line_no, e.reason))
        lines = [x for x in lines if x]
        if not lines:
            raise ApiError(400, 'empty_macro', '宏 %d 为空' % n)

        def run():
            return all(self.ctrl.send(x, True) for x in lines)
        ok = await self.call(run)
        self._check_ok(ok, '宏 %d' % n)
        self.origin_epoch += 1
        return self.status()

    # ------------------------------------------------------------ e-stop
    async def estop(self, actor='-'):
        """§2.4. Never rate limited; works in every state."""
        if not self.connected:
            # still abort a job that is preparing
            self.ctx.jobs.abort_active('estop')
            return self.status()
        if self.estopping and self._estop_done is not None:
            await asyncio.wrap_future(self._estop_done)
            return self.status()
        self.estopping = True
        fut = concurrent.futures.Future()
        self._estop_done = fut
        threading.Thread(target=self._estop_seq, args=(fut, actor), daemon=True, name='pp-estop').start()
        try:
            await asyncio.wait_for(asyncio.wrap_future(fut), 8.0)
        except asyncio.TimeoutError:
            pass
        self._publish_status(True)
        return self.status()

    def halt_blocking(self):
        """Feed hold -> wait for the decel (Hold:0) -> soft reset -> banner.
        If the hold completed before the reset GRBL keeps its position;
        otherwise (ALARM:3) unlock and invalidate the origin. Pen up when the
        origin (and Z reference) is still valid. Returns origin_kept."""
        c = self.ctrl
        grbl = hasattr(c, 'query_status')
        if grbl:
            try:
                c.feed_hold()
            except Exception:
                pass
        self.ctx.jobs.estop_abort_sender()
        tt = getattr(self.ctx, 'teletype', None)
        if tt is not None:
            tt.halt_abort()
        if not grbl:
            # Marlin/K_AT: M410 quick-stop (M112 would need a power cycle); EBB: ES
            try:
                if self.mc.type in ('Marlin', 'K_AT'):
                    c.send('M410', False)
                elif self.mc.type == 'Ebb':
                    c.send('ES', False)
            except Exception:
                pass
            self._invalidate_origin()
            return False
        reached = False
        end = time.time() + 1.5
        while time.time() < end:
            st = c.query_status(0.15) or ''
            if st.startswith('Hold:0') or st.startswith('Idle') or st.startswith('Alarm'):
                reached = not st.startswith('Alarm')
                break
        banners = self._banners
        try:
            c.soft_reset()
        except Exception:
            pass
        end = time.time() + 3.0
        while time.time() < end and self._banners == banners and c.connected:
            time.sleep(0.02)
        time.sleep(0.05)
        st = c.query_status(1.0) or ''
        if st.startswith('Alarm') or not reached:
            c.unlock()
            self._invalidate_origin()
        if self.origin_valid and self.z_valid:
            c.set_pen(True)
            self.pen_state = 'up'
        return self.origin_valid

    def _estop_seq(self, fut, actor):
        t0 = time.time()
        try:
            kept = self.halt_blocking()
            self.ctx.jobs.finish_estop()
            tt = getattr(self.ctx, 'teletype', None)
            if tt is not None:
                tt.after_halt('estop')
            self.ctx.db.audit(actor, 'estop', {'kept_origin': kept, 'ms': int((time.time() - t0) * 1000)})
        except Exception as e:
            log.exception('estop')
            self.ctx.jobs.finish_estop()
            fut.set_exception(e) if not fut.done() else None
        finally:
            self.estopping = False
            if not fut.done():
                fut.set_result(True)
