"""Self-test (POST /system/diagnostics) and recovery guidance (GET /machine/recovery)."""
import asyncio
import os
import shutil
import subprocess
import time

from .db import jload
from .errors import ApiError


def _chk(cid, name, status, detail='', hint=''):
    return {'id': cid, 'name': name, 'status': status, 'detail': detail, 'hint': hint}


def _num(params, n):
    try:
        return float(params.get(n))
    except (TypeError, ValueError):
        return None


def grbl_sanity(params, mc, work_area):
    """$$ vs profile. params: {n: 'value'}."""
    out = []
    g = mc.grbl
    v13 = _num(params, 13)
    out.append(_chk('grbl_13', '$13 报告单位', 'ok' if v13 in (None, 0.0) else 'fail',
                    '$13=%s' % params.get(13),
                    '' if v13 in (None, 0.0) else '$13=1 表示报告英寸，坐标会全错：在 GRBL 设置里改成 $13=0'))
    v20, v22, v21 = _num(params, 20), _num(params, 22), _num(params, 21)
    if v22 == 1.0:
        out.append(_chk('grbl_22', '$22 回零', 'warn', '$22=1',
                        '本机没有限位开关，开着回零容易报 ALARM:9：把 $22 改成 0'))
    if v20 == 1.0 and v22 != 1.0:
        out.append(_chk('grbl_20', '$20 软限位', 'warn', '$20=1, $22=0',
                        '没有回零时软限位以开机位置为准，容易 ALARM:2：建议 $20=0'))
    if v21 == 1.0:
        out.append(_chk('grbl_21', '$21 硬限位', 'warn', '$21=1', '没有限位开关时打开硬限位，噪声可能触发 ALARM:1：建议 $21=0'))
    t130, t131 = _num(params, 130), _num(params, 131)
    w, h = float(work_area.get('w_mm', 0)), float(work_area.get('h_mm', 0))
    if w > 0 and h > 0 and t130 and t131 and (w > t130 + 0.5 or h > t131 + 0.5):
        out.append(_chk('travel', '工作区 vs 行程', 'warn', '工作区 %g×%g，$130/$131=%g/%g' % (w, h, t130, t131),
                        '机器配置里的工作区比 GRBL 最大行程大：改小工作区或修正 $130/$131'))
    else:
        out.append(_chk('travel', '工作区 vs 行程', 'ok', '工作区 %g×%g mm' % (w, h)))
    m110, m111 = _num(params, 110), _num(params, 111)
    fr = float(mc.settings.feedRate or 0)
    if m110 and m111 and fr > min(m110, m111):
        out.append(_chk('feed', '写字速度', 'warn', 'feedRate %g > $110/$111 %g/%g' % (fr, m110, m111),
                        'GRBL 会按最大速度限速，预计时间会偏短'))
    if g.type == 'Stepper':
        m112 = _num(params, 112)
        if m112 and g.zSpeed > m112:
            out.append(_chk('zspeed', '抬落笔速度', 'warn', 'zSpeed %g > $112 %g' % (g.zSpeed, m112),
                            'Z 轴会被限速，抬落笔比预计慢'))
        if _num(params, 32) == 1.0:
            out.append(_chk('laser', '$32 激光模式', 'warn', '$32=1', 'Z 笔机器不需要激光模式：建议 $32=0'))
    if params.get(3) not in (None, '0'):
        out.append(_chk('dir', '$3 方向反转', 'ok', '$3=%s' % params.get(3), '如果点动方向反了，在这里改'))
    return out


class Diagnostics:
    def __init__(self, ctx):
        self.ctx = ctx
        self.last = None

    async def run(self, pen_test=False, confirm=False):
        c = self.ctx
        m = c.machine
        checks = []
        t0 = time.time()
        port = m.port or m._resolve_port(None)
        if port == 'fake':
            checks.append(_chk('serial_present', '串口设备', 'ok', 'FakeGrbl 模拟器'))
        elif os.path.exists(port):
            checks.append(_chk('serial_present', '串口设备', 'ok', port))
        else:
            checks.append(_chk('serial_present', '串口设备', 'fail', '%s 不存在' % port,
                               '检查 USB 线和写字机电源；ls /dev/serial/by-id/ 看看设备名'))
        if m.connected:
            checks.append(_chk('serial_open', '串口独占', 'ok', '本服务已独占打开 %s' % m.port))
        else:
            from .machine.service import _fuser
            pid = _fuser(port) if port != 'fake' and os.path.exists(port) else None
            checks.append(_chk('serial_open', '串口独占', 'fail', '未连接' + ('，被 PID %d 占用' % pid if pid else ''),
                               '关掉占用串口的程序（命令行 penplot print/tool？），然后点「连接」' if pid else
                               '点「连接」；如果失败看错误信息'))
        if m.connected:
            fw = m.ctrl.firmware_version or ''
            ok = fw.startswith('1.1') or m.mc.type != 'Grbl'
            checks.append(_chk('banner', '固件', 'ok' if ok else 'warn', fw or '没有收到启动横幅',
                               '' if ok else '没收到 "Grbl 1.1" 横幅：检查波特率（115200）或固件版本'))
            if hasattr(m.ctrl, 'query_status'):
                lat = await asyncio.get_running_loop().run_in_executor(None, self._latency)
                st = 'ok' if lat['max_ms'] < 100 else ('warn' if lat['max_ms'] < 500 else 'fail')
                checks.append(_chk('status_latency', '状态查询延迟', st,
                                   '平均 %.0f ms，最大 %.0f ms（%d/5 有回应）' % (lat['avg_ms'], lat['max_ms'], lat['n']),
                                   '' if st == 'ok' else '串口回应慢：换一根短 USB 线，或检查板子负载'))
                if not m.busy_reason():
                    try:
                        rows = await m.grbl_settings(True)
                        params = {r['n']: r['value'] for r in rows}
                        checks += grbl_sanity(params, m.mc, (m.profile or {}).get('doc', {}).get('work_area') or {})
                    except ApiError as e:
                        checks.append(_chk('grbl_settings', '$$ 设置', 'warn', e.message, '机器忙或无回应，稍后再试'))
                else:
                    checks.append(_chk('grbl_settings', '$$ 设置', 'skip', '机器正忙，跳过'))
            if pen_test:
                checks.append(await self._pen_test(confirm))
        else:
            checks.append(_chk('banner', '固件', 'skip', '未连接'))
        checks += await asyncio.get_running_loop().run_in_executor(None, self._host_checks)
        order = {'fail': 0, 'warn': 1, 'ok': 2, 'skip': 3}
        worst = min((order[x['status']] for x in checks), default=2)
        summary = {0: 'fail', 1: 'warn', 2: 'ok', 3: 'ok'}[worst]
        for x in checks:
            x['message'] = x['detail']
        self.last = {'status': summary, 'ran_at': t0, 'elapsed_ms': round((time.time() - t0) * 1000, 1),
                'checks': checks, 'counts': {k: sum(1 for x in checks if x['status'] == k)
                                             for k in ('ok', 'warn', 'fail', 'skip')}}
        return self.last

    def _latency(self):
        c = self.ctx.machine.ctrl
        ts = []
        for _ in range(5):
            t = time.time()
            if c.query_status(1.0) is not None:
                ts.append((time.time() - t) * 1000)
        return {'n': len(ts), 'avg_ms': sum(ts) / len(ts) if ts else 1000.0, 'max_ms': max(ts) if ts else 1000.0}

    async def _pen_test(self, confirm):
        m = self.ctx.machine
        if not confirm:
            return _chk('pen', '抬落笔测试', 'skip', '需要 confirm=true（笔会落下再抬起）',
                        '先把纸拿开或确认笔下面是废纸')
        if m.busy_reason():
            return _chk('pen', '抬落笔测试', 'skip', '机器正忙')
        if not m.z_valid or m.mc.grbl.type != 'Stepper':
            return _chk('pen', '抬落笔测试', 'skip', 'Z 基准未知（没有设零）或不是 Z 笔机器',
                        '先把笔停在抬起位置并「设为原点」')
        g = m.mc.grbl

        def run():
            c = m.ctrl
            c.set_pen(False)
            c.wait_idle(10)
            down = (c.wpos or (0, 0, 0))[2]
            c.set_pen(True)
            c.wait_idle(10)
            up = (c.wpos or (0, 0, 0))[2]
            return down, up
        down, up = await m.call(run)
        ok = abs(down - g.zOn) < 0.05 and abs(up - g.zOff) < 0.05
        return _chk('pen', '抬落笔测试', 'ok' if ok else 'fail', '落笔 Z=%.2f 抬笔 Z=%.2f（应为 %g / %g）'
                    % (down, up, g.zOn, g.zOff), '' if ok else 'Z 没走到位：检查 $102 步数和 Z 轴接线')

    def _host_checks(self):
        c = self.ctx
        out = []
        w = c.system.wifi()
        if w['signal_dbm'] is None:
            out.append(_chk('wifi', 'WiFi 信号', 'skip', '没有无线网卡信息（有线连接？）'))
        else:
            s = w['signal_dbm']
            st = 'ok' if s > -67 else ('warn' if s > -80 else 'fail')
            out.append(_chk('wifi', 'WiFi 信号', st, '%s %.0f dBm' % (w.get('ssid') or '', s),
                            '' if st == 'ok' else '信号弱：把板子靠近路由器，或用 USB 延长线把网卡挪出金属外壳'))
        du = shutil.disk_usage(c.cfg.data_dir)
        st = 'ok' if du.free > 1 << 30 else ('warn' if du.free > 500 << 20 else 'fail')
        out.append(_chk('disk', '存储空间', st, '剩余 %.1f GB' % (du.free / 2 ** 30),
                        '' if st == 'ok' else '清理文件库或旧任务'))
        mem = {}
        try:
            for line in open('/proc/meminfo'):
                k, _, v = line.partition(':')
                mem[k] = int(v.split()[0]) * 1024
        except OSError:
            pass
        avail = mem.get('MemAvailable')
        if avail is not None:
            st = 'ok' if avail > 300 << 20 else ('warn' if avail > 120 << 20 else 'fail')
            out.append(_chk('memory', '可用内存', st, '%.0f MB' % (avail / 2 ** 20),
                            '' if st == 'ok' else '内存紧张：关闭其它服务，避免同时转换大字体'))
        met = c.system.metrics()
        t = met.get('temp_c')
        if t is not None:
            st = 'ok' if t < 70 else ('warn' if t < 85 else 'fail')
            out.append(_chk('temp', 'CPU 温度', st, '%.1f °C' % t, '' if st == 'ok' else '加散热片或风扇'))
        n = len(c.fonts._rows)
        out.append(_chk('fonts', '字体目录', 'ok' if n > 1 else 'warn', '%d 个字体（%s）' % (n, c.cfg.font_dir),
                        '' if n > 1 else '把 .gfont/.psf 放进字体目录，或在字库页上传'))
        year = time.localtime().tm_year
        ntp = None
        if shutil.which('timedatectl'):
            try:
                ntp = subprocess.run(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value'], capture_output=True,
                                     text=True, timeout=2).stdout.strip()
            except Exception:
                ntp = None
        if year < 2024:
            out.append(_chk('clock', '系统时钟', 'fail', time.strftime('%Y-%m-%d %H:%M'),
                            '时钟不对（板子没有电池，没联网同步）：任务时间和会话过期会错乱'))
        else:
            out.append(_chk('clock', '系统时钟', 'ok' if ntp in (None, 'yes') else 'warn',
                            time.strftime('%Y-%m-%d %H:%M') + ('，NTP 已同步' if ntp == 'yes' else ''),
                            '' if ntp in (None, 'yes') else 'NTP 未同步：检查网络或 systemd-timesyncd'))
        ok = os.access(c.cfg.data_dir, os.W_OK)
        out.append(_chk('data_dir', '数据目录', 'ok' if ok else 'fail', c.cfg.data_dir,
                        '' if ok else '服务用户没有写权限：chown -R penplot /var/lib/penplot'))
        return out

    # ------------------------------------------------------------ recovery
    def recovery(self):
        c = self.ctx
        m = c.machine
        st = m.status()
        reasons = []
        steps = []
        last = c.db.one("SELECT * FROM jobs WHERE status IN ('failed','aborted') ORDER BY COALESCE(finished_at, created_at) "
                        "DESC LIMIT 1")
        lj = c.jobs.to_api(last) if last else None
        recent_job = lj if lj and (time.time() - (lj['finished_at'] or 0) < 6 * 3600) else None

        def step(sid, title, detail='', action=None, done=False):
            steps.append({'id': sid, 'title': title, 'detail': detail, 'action': action, 'done': done})

        if not st['connected']:
            reasons.append('disconnected')
            step('power', '检查写字机', '确认 USB 线插好、写字机通电；如果刚拔插过，等两秒', None, False)
            step('connect', '重新连接', st.get('error') or '', {'method': 'POST', 'path': '/api/v1/machine/connect',
                                                                'body': {}})
        if st['connected'] and (st['grbl_state'] or '').startswith('Alarm'):
            reasons.append('alarm')
            a = st.get('last_alarm') or {}
            step('alarm', '看清报警原因', '%s %s' % (a.get('text', 'ALARM'), a.get('hint', '')))
            step('unlock', '解锁', '解锁后坐标可能已经失效', {'method': 'POST', 'path': '/api/v1/machine/unlock',
                                                         'body': {}})
        if st['connected'] and (st['grbl_state'] or '').startswith('Hold') and c.jobs.active is None:
            reasons.append('hold')
            step('hold', '解除机器暂停', '写字机处于暂停（进给保持）状态，可能按了机器上的暂停键，或断线重连后保留了暂停；'
                 '清除后缓冲里剩下的动作会被丢弃',
                 {'method': 'POST', 'path': '/api/v1/machine/clear-hold', 'body': {}})
        if not st['origin_valid']:
            reasons.append('origin_invalid')
            step('lift', '抬起笔', '笔的高度未知：用 Z 点动把笔抬离纸面（每次 1 mm）',
                 {'method': 'POST', 'path': '/api/v1/machine/jog', 'body': {'dz': -1}})
            step('position', '把笔移到原点', '用 XY 点动把笔停到要写内容的左上角（或你在创作台设定的原点）；纸滑了的话先把纸放正')
            step('zero', '设为原点', '当前位置变成原点（笔在抬起位置时 Z 一并设零）',
                 {'method': 'POST', 'path': '/api/v1/machine/zero', 'body': {'axes': 'xyz'}})
        if recent_job:
            reasons.append('job_%s' % recent_job['status'])
            frm = recent_job.get('can_retry_from')
            if frm and st['origin_valid'] and recent_job['reason'] not in ('process_crash', 'serial_lost'):
                step('retry', '从第 %d 行续写' % frm, '原点没变，可以接着写（会重画几笔，笔迹叠在一起看不出来）',
                     {'method': 'POST', 'path': '/api/v1/jobs/%s/retry' % recent_job['id'], 'body': {'from_line': frm}})
            else:
                step('retry', '重新开始这个任务', '原点已经变了，只能从头写：换一张纸',
                     {'method': 'POST', 'path': '/api/v1/jobs/%s/retry' % recent_job['id'], 'body': {}})
        a = c.jobs.active
        if a is not None and a.status == 'paused':
            reasons.append('job_paused')
            step('resume', '继续写', '', {'method': 'POST', 'path': '/api/v1/jobs/%s/resume' % a.id, 'body': {}})
        situation = reasons[0] if reasons else 'ok'
        return {'ok': not reasons, 'situation': situation, 'reasons': reasons, 'machine': st,
                'last_job': recent_job, 'steps': steps}


__all__ = ['Diagnostics', 'grbl_sanity', 'jload']
