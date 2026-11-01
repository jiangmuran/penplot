"""System info from /proc, /sys, iw, journalctl (all best-effort)."""
import asyncio
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time

import penplot

from .errors import ApiError


def _read(path):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return None


def _cpu_times():
    out = []
    txt = _read('/proc/stat') or ''
    for line in txt.splitlines():
        if line.startswith('cpu') and line[3:4].isdigit():
            v = [int(x) for x in line.split()[1:]]
            idle = v[3] + (v[4] if len(v) > 4 else 0)
            out.append((sum(v), idle))
    return out


def _ips():
    ips = []
    try:
        out = subprocess.run(['hostname', '-I'], capture_output=True, text=True, timeout=1).stdout
        ips = [x for x in out.split() if ':' not in x]
    except Exception:
        pass
    if not ips:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(('10.255.255.255', 1))
            ips = [s.getsockname()[0]]
            s.close()
        except OSError:
            pass
    return ips


class SystemService:
    def __init__(self, ctx):
        self.ctx = ctx
        self.started = time.time()
        self._cpu_prev = _cpu_times()
        self._disk_prev = None
        self._disk_base = self._sd_sectors()
        self._task = None

    def health(self):
        c = self.ctx
        j = c.jobs.active if hasattr(c, 'jobs') else None
        return {'status': 'ok', 'version': penplot.__version__, 'uptime_s': round(time.time() - self.started, 1),
                'machine_connected': c.machine.connected if hasattr(c, 'machine') else False,
                'job_active': j is not None, 'setup_required': not c.auth.has_admin()}

    def build(self):
        p = os.path.join(self.ctx.cfg.static_dir, '_build.json')
        try:
            with open(p) as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def info(self):
        b = self.build()
        c = self.ctx
        return {'version': penplot.__version__, 'git_sha': b.get('sha'), 'built_at': b.get('built_at'),
                'python': sys.version.split()[0], 'os': '%s %s' % (platform.system(), platform.release()),
                'hostname': socket.gethostname(), 'ips': _ips(), 'features': c.features,
                'data_dir': c.cfg.data_dir, 'font_dir': c.cfg.font_dir, 'dev': c.cfg.dev,
                'static_present': os.path.isfile(os.path.join(c.cfg.static_dir, 'index.html'))}

    def _sd_sectors(self):
        txt = _read('/proc/diskstats') or ''
        tot = 0
        for line in txt.splitlines():
            f = line.split()
            if len(f) > 9 and (f[2] in ('mmcblk0', 'mmcblk1', 'sda', 'nvme0n1')):
                tot += int(f[9])
        return tot

    def metrics(self):
        cur = _cpu_times()
        pct = []
        for (t1, i1), (t0, i0) in zip(cur, self._cpu_prev or cur):
            dt = t1 - t0
            pct.append(round(100.0 * (1 - (i1 - i0) / dt), 1) if dt > 0 else 0.0)
        self._cpu_prev = cur
        try:
            load = list(os.getloadavg())
        except OSError:
            load = [0.0, 0.0, 0.0]
        temp = None
        for z in sorted(os.listdir('/sys/class/thermal')) if os.path.isdir('/sys/class/thermal') else []:
            t = _read('/sys/class/thermal/%s/temp' % z)
            if t and t.strip().lstrip('-').isdigit():
                temp = round(int(t) / 1000.0, 1)
                break
        mem = {}
        for line in (_read('/proc/meminfo') or '').splitlines():
            k, _, v = line.partition(':')
            if k in ('MemTotal', 'MemAvailable'):
                mem[k] = int(v.split()[0]) * 1024
        rss = 0
        for line in (_read('/proc/self/status') or '').splitlines():
            if line.startswith('VmRSS:'):
                rss = int(line.split()[1]) * 1024
        du = shutil.disk_usage(self.ctx.cfg.data_dir)
        sd = self._sd_sectors()
        return {'cpu_pct': pct, 'load': [round(x, 2) for x in load], 'temp_c': temp,
                'mem': {'total': mem.get('MemTotal', 0), 'avail': mem.get('MemAvailable', 0), 'proc_rss': rss},
                'disk': {'data_free': du.free, 'total': du.total},
                'sd_writes_mb': round((sd - self._disk_base) * 512 / 1048576.0, 2) if sd else None,
                'tasks_running': len(self.ctx.tasks.running), 'uptime_s': round(time.time() - self.started, 1)}

    def wifi(self):
        iface = None
        sig = qual = None
        for line in (_read('/proc/net/wireless') or '').splitlines()[2:]:
            f = line.split()
            if len(f) >= 4:
                iface = f[0].rstrip(':')
                try:
                    qual = round(float(f[2].rstrip('.')) / 70.0 * 100, 1)
                    sig = float(f[3].rstrip('.'))
                except ValueError:
                    pass
                break
        ssid = bitrate = None
        if iface and shutil.which('iw'):
            try:
                out = subprocess.run(['iw', 'dev', iface, 'link'], capture_output=True, text=True, timeout=1).stdout
                for line in out.splitlines():
                    line = line.strip()
                    if line.startswith('SSID:'):
                        ssid = line[5:].strip()
                    elif line.startswith('tx bitrate:'):
                        bitrate = line[11:].strip()
                    elif line.startswith('signal:'):
                        try:
                            sig = float(line.split()[1])
                        except (IndexError, ValueError):
                            pass
            except Exception:
                pass
        ips = _ips()
        return {'iface': iface, 'ssid': ssid, 'signal_dbm': sig, 'quality': qual, 'bitrate': bitrate,
                'ip': ips[0] if ips else None}

    def logs(self, n=500, since=None, priority=None):
        if not shutil.which('journalctl'):
            return []
        cmd = ['journalctl', '-u', 'penplot-web', '-o', 'json', '-n', str(int(n)), '--no-pager']
        if since:
            cmd += ['--since', '@%d' % int(since)]
        if priority is not None:
            cmd += ['-p', str(int(priority))]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout
        except Exception:
            return []
        res = []
        for line in out.splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            msg = e.get('MESSAGE')
            if isinstance(msg, list):
                msg = bytes(msg).decode('utf-8', 'replace')
            res.append({'ts': int(e.get('__REALTIME_TIMESTAMP', 0)) / 1e6, 'priority': int(e.get('PRIORITY', 6)),
                        'message': msg or '', 'unit': e.get('_SYSTEMD_UNIT')})
        return res

    def audit(self, limit=200):
        rows = self.ctx.db.all('SELECT * FROM audit ORDER BY ts DESC LIMIT ?', (int(limit),))
        out = []
        for r in rows:
            try:
                d = json.loads(r['detail']) if r['detail'] else None
            except ValueError:
                d = r['detail']
            out.append({'ts': r['ts'], 'actor': r['actor'], 'action': r['action'], 'detail': d})
        return out

    async def restart(self, force=False):
        if self.ctx.jobs.active is not None and not force:
            raise ApiError(409, 'job_active', '任务进行中，不能重启（force=true 可强制）')
        self.ctx.bus.publish('notice', {'level': 'warning', 'code': 'restart', 'message': '服务即将重启'})
        self.ctx.db.audit('admin', 'restart', {'force': force})

        async def later():
            await asyncio.sleep(0.5)
            import signal
            os.kill(os.getpid(), signal.SIGTERM)
        asyncio.get_running_loop().create_task(later())

    async def publisher(self):
        """WS `system` every 5 s."""
        while True:
            await asyncio.sleep(5)
            try:
                if not self.ctx.bus.subs:
                    continue
                m = await asyncio.get_running_loop().run_in_executor(None, self.metrics)
                w = await asyncio.get_running_loop().run_in_executor(None, self.wifi)
                self.ctx.bus.publish('system', {'cpu': round(sum(m['cpu_pct']) / max(1, len(m['cpu_pct'])), 1),
                                                'temp_c': m['temp_c'], 'mem_avail': m['mem']['avail'],
                                                'mem_total': m['mem']['total'], 'wifi_dbm': w['signal_dbm']})
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
