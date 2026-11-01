import { ArrowUpRight, Plug, Unplug, Wifi, WifiOff } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { connectMachine, disconnectMachine, runAction } from '@/api/machine'
import { isJobActive, useLive } from '@/api/store'
import { toneClasses } from '@/api/status-view'
import { Button, Popover, PopoverContent, PopoverTrigger, StatusPill } from '@/components/ui'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { formatNumber, formatRelative } from '@/lib/format'
import { MiniPlayerBody } from './mini-player'
import { useLiveStatus } from './use-live-status'

/**
 * Global machine status capsule (02-ux §2.3). Click → popover with port/firmware/position/errors and
 * [连接/断开] [打开控制]. `showProgressRing` renders job progress in the pill (sidebar hidden).
 */
export function MachineStatusPill({ showProgressRing, className, align = 'end' }: { showProgressRing?: boolean; className?: string; align?: 'start' | 'center' | 'end' }) {
  const { view, machine, job, conn } = useLiveStatus()
  const rtt = useLive((s) => s.rtt)
  const quality = useLive((s) => s.quality)
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const active = isJobActive(job)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn('focus-ring press shrink-0 rounded-full', className)}
          aria-label={`机器状态：${view.label}`}
          aria-haspopup="dialog"
        >
          <span aria-live={view.live} className="contents">
            <StatusPill tone={view.tone} icon={view.icon} spin={view.spin} progress={showProgressRing && active ? (view.percent ?? 0) : null}>
              {view.label}
            </StatusPill>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-80 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="flex items-center gap-2 px-4 pb-2 pt-3.5">
          <span className={cn('size-2 rounded-full', toneClasses[view.tone].dot)} aria-hidden />
          <span className="flex-1 text-headline">{view.label}</span>
          <span className="flex items-center gap-1 text-footnote text-secondary-label tabular-nums" title="与设备的网络往返延迟">
            {conn === 'open' ? <Wifi className={cn('size-3.5', quality === 'poor' ? 'text-red' : quality === 'fair' ? 'text-orange' : 'text-green')} /> : <WifiOff className="size-3.5" />}
            {rtt != null ? `${rtt} ms` : '—'}
          </span>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-4 pb-3 text-footnote">
          <Row k="端口" v={machine?.port ? <span className="font-mono">{shortPort(machine.port)}</span> : '—'} />
          <Row k="波特率" v={machine?.baud ? String(machine.baud) : '—'} />
          <Row k="固件" v={machine?.firmware ? `Grbl ${machine.firmware}` : '—'} />
          <Row
            k="坐标"
            v={
              machine?.wpos ? (
                <span className="font-mono tabular-nums">
                  X {formatNumber(machine.wpos[0])} · Y {formatNumber(machine.wpos[1])} · Z {formatNumber(machine.wpos[2])}
                </span>
              ) : (
                '—'
              )
            }
          />
          <Row k="笔" v={machine ? ({ up: '抬起', down: '落下', unknown: '未知' } as const)[machine.pen] : '—'} />
          {machine && machine.connected && !machine.origin_valid ? <Row k="零点" v={<span className="text-on-tint-orange">未设定 · 请抬笔并重新设零</span>} /> : null}
          {machine?.last_alarm ? (
            <Row k="最近报警" v={<span className="text-on-tint-red">{machine.last_alarm.text} · {formatRelative(machine.last_alarm.ts)}</span>} />
          ) : null}
          {machine?.error ? <Row k="错误" v={<span className="text-on-tint-red">{machine.error}</span>} /> : null}
        </dl>
        {active && job ? (
          <div className="hairline-t px-4 py-3">
            <MiniPlayerBody job={job} />
          </div>
        ) : null}
        <div className="hairline-t flex items-center gap-2 px-4 py-3">
          {!machine?.connected ? (
            <Button
              size="md"
              variant="tinted"
              icon={<Plug />}
              loading={busy}
              disabled={conn !== 'open'}
              onClick={async () => {
                setBusy(true)
                await runAction('连接失败', () => connectMachine())
                setBusy(false)
              }}
            >
              连接
            </Button>
          ) : null}
          <Button
            size="md"
            variant={machine?.connected ? 'tinted' : 'plain'}
            className="ml-auto"
            onClick={() => {
              setOpen(false)
              navigate('/machine')
            }}
          >
            打开控制 <ArrowUpRight />
          </Button>
        </div>
        {machine?.connected ? (
          // Disconnect is rare and disruptive: keep it away from pause/stop, red text + confirmation.
          <div className="hairline-t px-2 py-1.5">
            <Button
              size="md"
              variant="destructive-plain"
              block
              icon={<Unplug />}
              loading={busy}
              disabled={active || conn !== 'open'}
              title={active ? '任务进行中不能断开' : undefined}
              onClick={async () => {
                const ok = await confirm({
                  title: '断开写字机？',
                  description: '断开后需要重新连接；写字机复位后原点可能失效。',
                  confirmLabel: '断开',
                  destructive: true,
                })
                if (!ok) return
                setBusy(true)
                await runAction('断开失败', disconnectMachine)
                setBusy(false)
              }}
            >
              断开连接
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <>
      <dt className="text-secondary-label">{k}</dt>
      <dd className="min-w-0 truncate text-right text-label">{v}</dd>
    </>
  )
}

function shortPort(p: string) {
  return p.replace('/dev/serial/by-id/', '…/').replace(/^(.{28}).+$/, '$1…')
}
