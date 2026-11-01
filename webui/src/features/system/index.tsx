/**
 * 系统 /system (02-ux §3.11, 01 §16): host gauges (live via WS `system`), service/build info, network,
 * features, serial ports, service logs, audit, restart.
 */
import {
  ArrowUpRight, BookOpen, Check, ChevronDown, Cpu, HardDrive, MemoryStick, Plug, RefreshCw, RotateCw, Thermometer, Usb, X,
} from 'lucide-react'
import * as React from 'react'
import { useSearchParams } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { Page } from '@/app/page'
import { isJobActive, useLive } from '@/api/store'
import { useAudit, useHealth, useMetrics, usePorts, useSystemInfo, useWifi, type Metrics } from '@/api/system'
import {
  Badge, Button, Card, Segmented, CardHeader, EmptyState, ErrorState, GroupedList, IconButton, ListRow, Skeleton, SkeletonList,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { formatBytes, formatRelative, formatTime } from '@/lib/format'
import { auditActor, auditSentence } from './audit-text'
import { GaugeCard, SignalBars, type GaugeTone } from './gauges'
import { DiagnosticsTab } from './diagnostics'
import { LogsCard } from './logs-card'
import { PresenceCard } from './presence-card'
import { useRestart } from './restart'

const HISTORY = 60

type Sample = { cpu: number | null; temp: number | null; mem: number | null; disk: number | null }

/** Rolling 60-sample history fed by WS `system` events (5 s) and REST metrics polls. */
function useMetricHistory(metrics: Metrics | undefined) {
  const live = useLive((s) => s.system)
  const [hist, setHist] = React.useState<Sample[]>([])
  const push = React.useCallback((s: Sample) => setHist((h) => [...h, s].slice(-HISTORY)), [])
  const diskRef = React.useRef<number | null>(null)
  React.useEffect(() => {
    if (!metrics) return
    const cpu = metrics.cpu_pct.length ? metrics.cpu_pct.reduce((a, b) => a + b, 0) / metrics.cpu_pct.length : null
    const disk = metrics.disk.total ? (100 * (metrics.disk.total - metrics.disk.data_free)) / metrics.disk.total : null
    diskRef.current = disk
    push({ cpu, temp: metrics.temp_c ?? null, mem: metrics.mem.total ? (100 * (metrics.mem.total - metrics.mem.avail)) / metrics.mem.total : null, disk })
  }, [metrics, push])
  React.useEffect(() => {
    if (!live) return
    push({
      cpu: live.cpu ?? null,
      temp: live.temp_c ?? null,
      mem: live.mem_total ? (100 * (live.mem_total - live.mem_avail)) / live.mem_total : null,
      disk: diskRef.current,
    })
  }, [live, push])
  return hist
}

const series = (h: Sample[], k: keyof Sample) => h.map((s) => s[k]).filter((v): v is number => v != null)

function formatUptime(s: number | null | undefined) {
  if (s == null) return '—'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d} 天 ${h} 小时`
  if (h) return `${h} 小时 ${m} 分`
  return `${m} 分钟`
}

export default function SystemPage() {
  const health = useHealth()
  const info = useSystemInfo()
  const metrics = useMetrics()
  const wifi = useWifi()
  const { job, rtt, quality, conn, system } = useLive(useShallow((s) => ({ job: s.job, rtt: s.rtt, quality: s.quality, conn: s.conn, system: s.system })))
  const hist = useMetricHistory(metrics.data)
  const restart = useRestart()
  const compact = useIsCompact()
  const [params, setParams] = useSearchParams()
  const tab: 'overview' | 'diag' = params.get('tab') === 'diag' ? 'diag' : 'overview'
  const jobActive = isJobActive(job) || !!health.data?.job_active

  const m = metrics.data
  const cpu = system?.cpu ?? (m?.cpu_pct.length ? m.cpu_pct.reduce((a, b) => a + b, 0) / m.cpu_pct.length : null)
  const temp = system?.temp_c ?? m?.temp_c ?? null
  const memTotal = system?.mem_total ?? m?.mem.total ?? null
  const memAvail = system?.mem_avail ?? m?.mem.avail ?? null
  const memPct = memTotal && memAvail != null ? (100 * (memTotal - memAvail)) / memTotal : null
  const diskPct = m?.disk.total ? (100 * (m.disk.total - m.disk.data_free)) / m.disk.total : null
  const loading = metrics.isLoading && !system

  const tempTone: GaugeTone = temp == null ? 'gray' : temp >= 80 ? 'red' : temp >= 70 ? 'orange' : 'green'
  const pctTone = (v: number | null, warn = 80, crit = 92): GaugeTone => (v == null ? 'gray' : v >= crit ? 'red' : v >= warn ? 'orange' : 'accent')

  return (
    <Page
      title="系统"
      toolbar={
        <Segmented
          aria-label="系统视图"
          value={tab}
          onValueChange={(v) => setParams(v === 'diag' ? { tab: 'diag' } : {}, { replace: true })}
          options={[
            { value: 'overview', label: '概览' },
            { value: 'diag', label: '诊断' },
          ]}
        />
      }
      actions={
        compact ? (
          <IconButton label="API 文档（新标签页）" onClick={() => window.open('/api/v1/docs', '_blank', 'noopener')}>
            <BookOpen />
          </IconButton>
        ) : (
          <Button variant="gray" asChild>
            <a href="/api/v1/docs" target="_blank" rel="noreferrer">
              <BookOpen />
              API 文档
              <ArrowUpRight className="size-3.5 opacity-60" />
            </a>
          </Button>
        )
      }
    >
      {tab === 'diag' ? (
        <DiagnosticsTab />
      ) : (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          {/* gauges */}
          {metrics.error && !system ? (
            <Card>
              <ErrorState title="无法读取主机状态" error={metrics.error} onRetry={() => metrics.refetch()} className="py-6" />
            </Card>
          ) : (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
              <GaugeCard
                label="CPU"
                icon={Cpu}
                loading={loading}
                value={cpu == null ? '—' : cpu.toFixed(0)}
                unit="%"
                tone={pctTone(cpu, 75, 90)}
                sub={m ? `负载 ${m.load.map((l) => l.toFixed(2)).join(' / ')}` : undefined}
                history={series(hist, 'cpu')}
              />
              <GaugeCard
                label="温度"
                icon={Thermometer}
                loading={loading}
                value={temp == null ? '—' : temp.toFixed(1)}
                unit={temp == null ? undefined : '°C'}
                tone={tempTone}
                badge={temp != null && temp >= 80 ? '过热' : temp != null && temp >= 70 ? '偏高' : undefined}
                sub={temp == null ? '无温度传感器' : temp >= 80 ? '请改善散热，打印可能降速' : '正常'}
                history={series(hist, 'temp')}
                max={100}
              />
              <GaugeCard
                label="内存"
                icon={MemoryStick}
                loading={loading}
                value={memPct == null ? '—' : memPct.toFixed(0)}
                unit="%"
                tone={pctTone(memPct, 80, 92)}
                sub={memTotal && memAvail != null ? `可用 ${formatBytes(memAvail)} / ${formatBytes(memTotal)}` : undefined}
                history={series(hist, 'mem')}
              />
              <GaugeCard
                label="磁盘"
                icon={HardDrive}
                loading={metrics.isLoading}
                value={diskPct == null ? '—' : diskPct.toFixed(0)}
                unit="%"
                tone={pctTone(diskPct, 85, 95)}
                badge={m && m.disk.data_free < 500 * 1024 ** 2 ? '空间不足' : undefined}
                sub={m ? `剩余 ${formatBytes(m.disk.data_free)} / ${formatBytes(m.disk.total)}` : undefined}
                history={series(hist, 'disk')}
              />
            </div>
          )}

          <div className="grid items-start gap-6 lg:grid-cols-2 [&>*]:min-w-0">
            <div className="flex flex-col gap-6">
              {/* service */}
              {info.isLoading ? (
                <SkeletonList rows={6} />
              ) : info.error ? (
                <Card>
                  <ErrorState error={info.error} onRetry={() => info.refetch()} className="py-6" />
                </Card>
              ) : info.data ? (
                <GroupedList header="服务">
                  <ListRow
                    label="PenPlot"
                    value={info.data.version}
                    accessory={
                      <span className="flex gap-1">
                        {info.data.dev ? <Badge tone="orange">开发模式</Badge> : null}
                        <Badge tone={health.data?.status === 'degraded' ? 'orange' : 'green'}>{health.data?.status === 'degraded' ? '降级' : '运行中'}</Badge>
                      </span>
                    }
                  />
                  <ListRow label="构建" value={[info.data.git_sha?.slice(0, 7), info.data.built_at].filter(Boolean).join(' · ') || '本地构建'} />
                  <ListRow label="运行时长" value={formatUptime(health.data?.uptime_s ?? m?.uptime_s)} />
                  <ListRow label="Python" value={info.data.python} />
                  <ListRow label="系统" value={info.data.os} />
                  <ListRow label="后台任务" value={m ? `${m.tasks_running} 个运行中` : '—'} />
                  {m?.sd_writes_mb != null ? <ListRow label="存储写入" value={`${m.sd_writes_mb.toFixed(1)} MB`} subtitle="自启动以来（SD 卡寿命参考）" /> : null}
                </GroupedList>
              ) : null}

              {/* network */}
              <GroupedList header="网络">
                <ListRow label="主机名" value={info.data ? `${info.data.hostname}.local` : '—'} />
                <ListRow label="IP 地址" value={info.data?.ips.length ? <IpList ips={info.data.ips} /> : (wifi.data?.ip ?? '—')} />
                {wifi.isLoading ? (
                  <div className="px-4 py-3">
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                ) : wifi.data?.iface || wifi.data?.ssid ? (
                  <>
                    <ListRow
                      label="WiFi"
                      subtitle={wifi.data.iface ?? undefined}
                      value={wifi.data.ssid ?? '未连接'}
                      accessory={<SignalBars dbm={wifi.data.signal_dbm} />}
                    />
                    <ListRow
                      label="信号"
                      value={[wifi.data.signal_dbm != null ? `${wifi.data.signal_dbm} dBm` : null, wifi.data.quality != null ? `质量 ${wifi.data.quality}%` : null, wifi.data.bitrate].filter(Boolean).join(' · ') || '—'}
                    />
                  </>
                ) : (
                  <ListRow label="WiFi" value="未使用无线网络" />
                )}
                <ListRow
                  label="浏览器 ↔ 设备延迟"
                  value={conn !== 'open' ? '未连接' : rtt == null ? '测量中…' : `${rtt} ms`}
                  accessory={
                    conn === 'open' && quality !== 'unknown' ? (
                      <Badge tone={quality === 'good' ? 'green' : quality === 'fair' ? 'orange' : 'red'}>{quality === 'good' ? '良好' : quality === 'fair' ? '一般' : '较差'}</Badge>
                    ) : null
                  }
                />
              </GroupedList>

              {/* features */}
              <FeaturesList features={info.data?.features} loading={info.isLoading} />
            </div>

            <div className="flex flex-col gap-6">
              <PresenceCard />

              <PortsCard />

              <GroupedList header="数据目录">
                <ListRow label="数据" value={<span className="font-mono text-footnote">{info.data?.data_dir ?? '—'}</span>} />
                <ListRow label="字体" value={<span className="font-mono text-footnote">{info.data?.font_dir ?? '—'}</span>} />
              </GroupedList>

              <AuditList />

              {/* danger zone */}
              <GroupedList
                header="危险区"
                footer={
                  jobActive
                    ? '正在写字，现在重启会中断任务。等任务写完，或先在「任务」里停止它。'
                    : '重启大约需要 30 秒。控制板会跟着复位，重启完成后会引导你抬笔、回到原点。'
                }
              >
                <ListRow
                  label="重启服务…"
                  destructive
                  disabled={jobActive || restart.busy}
                  onClick={restart.start}
                  accessory={<RotateCw className={cn('size-4', jobActive ? 'text-tertiary-label' : 'text-red')} aria-hidden />}
                />
              </GroupedList>
            </div>
          </div>

          <LogsCard />
        </div>
      )}
      {restart.overlay}
    </Page>
  )
}

function IpList({ ips }: { ips: string[] }) {
  const [open, setOpen] = React.useState(false)
  const shown = open ? ips : ips.slice(0, 2)
  return (
    <span className="flex flex-col items-end gap-0.5 py-1 font-mono text-footnote">
      {shown.map((ip) => (
        <span key={ip}>{ip}</span>
      ))}
      {ips.length > 2 ? (
        <button type="button" className="focus-ring rounded-xs font-sans text-accent" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '收起' : `另外 ${ips.length - 2} 个`}
        </button>
      ) : null}
    </span>
  )
}

const FEATURE_LABEL: Record<string, [string, string]> = {
  image: ['图片转路径', 'Pillow / scikit-image'],
  vector: ['SVG 导入', 'svgelements'],
  dxf: ['DXF 导入', 'ezdxf'],
  office: ['XLSX 批量数据', 'openpyxl'],
  ttf: ['TTF → 单线字体', 'fontTools'],
  png: ['PNG 导出', 'cairosvg / Pillow'],
}

function FeaturesList({ features, loading }: { features?: Record<string, boolean>; loading: boolean }) {
  if (loading) return <SkeletonList rows={4} />
  if (!features) return null
  const entries = Object.entries(features)
  return (
    <GroupedList header="可选功能" footer="缺少依赖的功能会在界面中隐藏或提示「尚不可用」。">
      {entries.map(([k, ok]) => (
        <ListRow
          key={k}
          label={FEATURE_LABEL[k]?.[0] ?? k}
          subtitle={FEATURE_LABEL[k]?.[1]}
          accessory={
            ok ? (
              <span className="flex items-center gap-1 text-footnote text-on-tint-green">
                <Check className="size-4 text-green" strokeWidth={2.5} aria-hidden />
                可用
              </span>
            ) : (
              <span className="flex items-center gap-1 text-footnote text-secondary-label">
                <X className="size-4" strokeWidth={2.5} aria-hidden />
                未安装
              </span>
            )
          }
        />
      ))}
    </GroupedList>
  )
}

function PortsCard() {
  const ports = usePorts()
  const machinePort = useLive((s) => (s.machine?.connected ? s.machine.port : null))
  const [showAll, setShowAll] = React.useState(false)
  const list = ports.data ?? []
  const usb = list.filter((p) => p.by_id || p.vid || /USB|ACM/.test(p.path))
  const other = list.filter((p) => !usb.includes(p))
  const shown = showAll ? [...usb, ...other] : usb
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="串口设备"
        subtitle={ports.data ? `${usb.length} 个 USB 串口${other.length ? `，${other.length} 个其他` : ''}` : undefined}
        actions={
          <IconButton label="刷新串口列表" onClick={() => ports.refetch()} loading={ports.isFetching}>
            <RefreshCw />
          </IconButton>
        }
      />
      {ports.isLoading ? (
        <div className="px-4 pb-4">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : ports.error ? (
        <ErrorState error={ports.error} onRetry={() => ports.refetch()} className="py-6" />
      ) : shown.length === 0 && !other.length ? (
        <EmptyState icon={Usb} title="未发现串口设备" description="请检查 USB 线缆与写字机电源。" className="py-6" />
      ) : (
        <div className="hairline-t [&>*+*]:hairline-t">
          {shown.length === 0 ? (
            <p className="px-4 py-3 text-footnote text-secondary-label">未发现 USB 串口设备。请检查 USB 线缆与写字机电源。</p>
          ) : null}
          {shown.map((p) => {
            const inUse = machinePort && (machinePort === p.path || machinePort === p.by_id)
            return (
              <div key={p.path} className="flex items-center gap-3 px-4 py-2">
                <Plug className={cn('size-4 shrink-0', inUse ? 'text-green' : 'text-tertiary-label')} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-footnote text-label" title={p.by_id ?? p.path}>
                    {p.by_id ? p.by_id.replace('/dev/serial/by-id/', '') : p.path}
                  </p>
                  <p className="truncate text-[12px] text-secondary-label">
                    {[p.by_id ? p.path : null, p.description && p.description !== 'n/a' ? p.description : null, p.vid ? `${p.vid}:${p.pid}` : null].filter(Boolean).join(' · ') || '—'}
                  </p>
                </div>
                {inUse ? (
                  <Badge tone="green">使用中</Badge>
                ) : p.busy_pid ? (
                  <Badge tone="orange">被进程 {p.busy_pid} 占用</Badge>
                ) : (
                  <Badge>空闲</Badge>
                )}
              </div>
            )
          })}
          {other.length ? (
            <button
              type="button"
              onClick={() => setShowAll(!showAll)}
              aria-expanded={showAll}
              className="focus-ring flex w-full items-center justify-center gap-1 px-4 py-2 text-footnote text-accent hover:bg-quaternary-fill"
            >
              {showAll ? '隐藏其他串口' : `显示其他 ${other.length} 个串口`}
              <ChevronDown className={cn('size-3.5 transition-transform', showAll && 'rotate-180')} />
            </button>
          ) : null}
        </div>
      )}
    </Card>
  )
}

function AuditList() {
  const audit = useAudit(50)
  const [open, setOpen] = React.useState(false)
  if (audit.isLoading) return <SkeletonList rows={3} />
  if (audit.error || !audit.data) return null
  const rows = open ? audit.data : audit.data.slice(0, 5)
  return (
    <GroupedList header="操作记录" footer={audit.data.length ? '谁在什么时候做了重要操作（登录、写入参数、急停等）。' : '暂无记录'}>
      {rows.map((a, i) => (
        <ListRow
          key={`${a.ts}-${i}`}
          label={auditSentence(a)}
          subtitle={auditActor(a.actor)}
          value={<time title={formatTime(a.ts)}>{formatRelative(a.ts)}</time>}
        />
      ))}
      {audit.data.length > 5 ? <ListRow label={open ? '收起' : `显示全部 ${audit.data.length} 条`} onClick={() => setOpen(!open)} chevron={false} className="[&_span]:text-accent" /> : null}
    </GroupedList>
  )
}
