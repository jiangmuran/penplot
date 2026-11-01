import { CircleAlert, Cpu, PlugZap, RefreshCw, Wifi, WifiOff } from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { errorMessage } from '@/api/client'
import { connectMachine } from '@/api/machine'
import { usePorts, type Profile } from '@/api/machine-control'
import { useLive } from '@/api/store'
import { Badge, Button, Card, CardHeader, IconButton, Select, Skeleton, StatusPill } from '@/components/ui'
import { useLiveStatus } from '@/app/use-live-status'
import { toast } from '@/lib/toast'
import { useMachineGate } from './gate'

const BAUDS = [9600, 19200, 38400, 57600, 115200, 250000]

const QUALITY: Record<string, { label: string; tone: 'green' | 'orange' | 'red' | 'gray' }> = {
  good: { label: '良好', tone: 'green' },
  fair: { label: '一般', tone: 'orange' },
  poor: { label: '较差', tone: 'red' },
  unknown: { label: '未知', tone: 'gray' },
}

function shortPort(p: string) {
  return p.replace('/dev/serial/by-id/', '').replace(/^usb-/, '')
}

export function LinkQualityBadge() {
  const { conn, rtt, quality } = useLive(useShallow((s) => ({ conn: s.conn, rtt: s.rtt, quality: s.quality })))
  if (conn !== 'open') return <Badge tone="gray" icon={WifiOff}>离线</Badge>
  const q = QUALITY[quality] ?? QUALITY.unknown
  return (
    <Badge tone={q.tone} icon={Wifi} title="浏览器到设备的往返延迟">
      {q.label}
      {rtt != null ? ` · ${rtt} ms` : ''}
    </Badge>
  )
}

export function ConnectionCard({ profile }: { profile: Profile | null }) {
  const { machine, view } = useLiveStatus()
  const blocked = useMachineGate().leaseBlocked
  const connected = !!machine?.connected
  const ports = usePorts()
  const profPort = profile?.doc.connection?.port
  const [port, setPort] = React.useState<string | undefined>(undefined)
  const [baud, setBaud] = React.useState<number>(profile?.doc.connection?.baud ?? 115200)
  const [busy, setBusy] = React.useState<'connect' | 'disconnect' | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const options = React.useMemo(() => {
    const list = (ports.data ?? []).map((p) => ({
      value: p.by_id ?? p.path,
      label: `${shortPort(p.by_id ?? p.path)}${p.busy_pid ? `（被进程 ${p.busy_pid} 占用）` : ''}`,
    }))
    // real devices first; hide the dozens of legacy ttyS* when something better exists
    const real = list.filter((o) => !/\/ttyS\d+$/.test(o.value))
    const shown = real.length ? real : list.slice(0, 8)
    for (const extra of [profPort, machine?.port, 'fake']) {
      if (extra && !shown.some((o) => o.value === extra)) shown.unshift({ value: extra, label: extra === 'fake' ? '模拟器（FakeGrbl）' : shortPort(extra) })
    }
    return shown
  }, [ports.data, profPort, machine?.port])

  const selected = port ?? machine?.port ?? profPort ?? options[0]?.value

  const connect = async () => {
    setBusy('connect')
    setError(null)
    try {
      const s = await connectMachine({ port: selected, baud })
      if (s && !s.connected && s.error) setError(s.error)
      else toast.success('已连接机器')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const machineError = error ?? (!connected && machine?.error ? machine.error : null)
  const noPorts = ports.isSuccess && options.length === 0

  return (
    <Card>
      <CardHeader
        title="连接"
        subtitle={profile ? `配置：${profile.name}` : undefined}
        actions={connected ? <LinkQualityBadge /> : <StatusPill tone={view.tone} icon={view.icon} spin={view.spin}>{view.label}</StatusPill>}
      />
      <div className="flex flex-col gap-2.5 px-4 pb-4">
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-subheadline text-secondary-label">端口</span>
          {ports.isLoading ? (
            <Skeleton className="h-7 flex-1" />
          ) : (
            <Select
              aria-label="串口"
              className="min-w-0 flex-1"
              value={selected}
              onValueChange={setPort}
              disabled={connected}
              options={options}
              placeholder="选择串口"
            />
          )}
          <IconButton label="刷新串口列表" onClick={() => ports.refetch()} loading={ports.isFetching} disabled={connected}>
            <RefreshCw />
          </IconButton>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-subheadline text-secondary-label">波特率</span>
          <Select
            aria-label="波特率"
            className="w-32"
            value={String(machine?.connected ? machine.baud : baud)}
            onValueChange={(v) => setBaud(Number(v))}
            disabled={connected}
            options={BAUDS.map((b) => ({ value: String(b), label: String(b) }))}
          />
        </div>
        {noPorts ? (
          <div className="flex items-start gap-2 rounded-md bg-orange/10 p-2.5 text-footnote text-on-tint-orange">
            <CircleAlert className="mt-px size-4 shrink-0" />
            <span>
              未发现串口设备。请检查 USB 线缆与驱动（CH340），或在 <Link to="/system" className="underline">系统</Link> 页查看设备。
            </span>
          </div>
        ) : null}
        {machineError ? (
          <div role="alert" className="flex items-start gap-2 rounded-md bg-red/10 p-2.5 text-footnote text-on-tint-red">
            <CircleAlert className="mt-px size-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{humanError(machineError)}</span>
            {!connected ? (
              <Button size="sm" variant="plain" className="-my-1 text-red" onClick={connect}>
                重试
              </Button>
            ) : null}
          </div>
        ) : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-quaternary-fill px-3 py-2 text-footnote">
          <dt className="text-secondary-label">固件</dt>
          <dd className="flex items-center gap-1.5 text-label">
            <Cpu className="size-3.5 text-tertiary-label" />
            {connected ? `Grbl ${machine?.firmware || '?'}` : '—'}
            {machine?.fake ? <Badge size="sm" tone="orange">模拟器</Badge> : null}
          </dd>
          <dt className="text-secondary-label">设备</dt>
          <dd className="truncate font-mono text-caption text-label" title={machine?.port ?? undefined}>
            {machine?.port ? shortPort(machine.port) : '—'}
          </dd>
          <dt className="text-secondary-label">缓冲</dt>
          <dd className="tabular-nums text-label">
            {connected && machine?.buf ? `规划 ${machine.buf.planner ?? '—'} · 接收 ${machine.buf.rx ?? '—'} B` : '—'}
          </dd>
        </dl>
        {!connected ? (
          <Button variant="filled" block icon={<PlugZap />} loading={busy === 'connect' || !!machine?.connecting} onClick={connect} disabled={!selected || blocked}>
            {machine?.connecting ? '连接中…' : '连接'}
          </Button>
        ) : null}
        <p className="text-footnote text-secondary-label">{connected ? '断开连接在「位置」卡片的「更多」里。' : '连接时控制板会复位，之后需要重新设原点。'}</p>
      </div>
    </Card>
  )
}

function humanError(e: string) {
  if (e.startsWith('port_busy')) return `串口被占用（${e.replace('port_busy:', '').trim()}）。请关闭其他使用该串口的程序。`
  if (/permission/i.test(e)) return '没有串口访问权限：请把服务用户加入 dialout 组。'
  return e
}
