import { Hand, Lock, LockOpen, ShieldAlert, Users } from 'lucide-react'
import * as React from 'react'
import { errorMessage } from '@/api/client'
import { acquireLease, releaseLease, useLease, useRole } from '@/api/collab'
import { Button, Popover, PopoverContent, PopoverTrigger, StatusPill } from '@/components/ui'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { formatRelative } from '@/lib/format'
import { HelpLink } from '@/features/help/HelpLink'
import { toast } from '@/lib/toast'

async function act(fn: () => Promise<unknown>, title: string, ok?: string) {
  try {
    await fn()
    if (ok) toast.success(ok)
  } catch (e) {
    toast.error(title, { description: errorMessage(e), key: title })
  }
}

export async function takeOver(holder: string | null) {
  const ok = await confirm({
    title: `强制接管 ${holder ?? '对方'} 的控制权？`,
    description: '对方将立即失去控制权（急停仍对所有人可用）。正在进行的任务不受影响。',
    confirmLabel: '强制接管',
    destructive: true,
  })
  if (ok) await act(() => acquireLease(true), '接管失败', '已接管控制权')
}

/** Lease actions (获取 / 释放 / 强制接管). */
export function LeaseActions({ size = 'sm', className }: { size?: 'sm' | 'md'; className?: string }) {
  const lease = useLease()
  const role = useRole()
  const [busy, setBusy] = React.useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    await fn()
    setBusy(false)
  }
  if (!lease.supported) return null
  if (role === 'viewer') return <span className={cn('text-footnote text-secondary-label', className)}>只读账户</span>
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {lease.mine ? (
        <Button size={size} variant="gray" icon={<LockOpen />} loading={busy} onClick={() => run(() => act(releaseLease, '释放失败', '已释放控制权'))}>
          释放控制权
        </Button>
      ) : lease.free ? (
        <Button size={size} variant="tinted" icon={<Hand />} loading={busy} onClick={() => run(() => act(() => acquireLease(), '获取控制权失败', '已获取控制权'))}>
          获取控制权
        </Button>
      ) : role === 'admin' ? (
        <Button size={size} variant="destructive-tinted" icon={<ShieldAlert />} loading={busy} onClick={() => run(() => takeOver(lease.holderName))}>
          强制接管
        </Button>
      ) : null}
    </div>
  )
}

export function leaseText(l: ReturnType<typeof useLease>) {
  if (l.mine) return '你正在控制机器'
  if (l.free) return '目前无人控制机器'
  return `${l.holderName} 正在控制${l.since ? ` · ${formatRelative(l.since)}获得` : ''}`
}

/** In-page strip for /machine and /jobs (also the compact surface, where the toolbar pill is hidden). */
export function LeaseStrip({ className }: { className?: string }) {
  const lease = useLease()
  const role = useRole()
  if (!lease.supported) return null
  const tone = lease.mine ? 'bg-green/10 text-on-tint-green' : lease.free ? 'bg-fill text-secondary-label' : 'bg-orange/10 text-on-tint-orange'
  const Icon = lease.mine ? Lock : lease.free ? Users : Hand
  return (
    <div role="status" aria-live="polite" className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3.5 py-2.5', tone, className)}>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 text-subheadline">
        {leaseText(lease)}
        {!lease.mine && !lease.free ? (
          <span className="opacity-80">{role === 'admin' ? ' · 你是管理员，仍可操作；急停对所有人可用' : ' · 你的手动控制已停用，急停始终可用'}</span>
        ) : null}
        {role === 'viewer' ? <span className="opacity-80"> · 只读账户</span> : null}
      </span>
      <LeaseActions />
    </div>
  )
}

/** Toolbar pill (regular widths). Renders nothing when the backend has no lease support. */
export function ControlLeasePillInner() {
  const lease = useLease()
  if (!lease.supported) return null
  const tone = lease.mine ? 'green' : lease.free ? 'gray' : 'orange'
  const label = lease.mine ? '我在控制' : lease.free ? '无人控制' : `${lease.holderName} 控制中`
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="focus-ring rounded-full" aria-label={`控制权：${leaseText(lease)}`}>
          <StatusPill tone={tone} icon={lease.mine ? Lock : lease.free ? LockOpen : Hand} className="max-w-48 truncate">
            {label}
          </StatusPill>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-4">
        <p className="flex items-center gap-1.5 text-headline text-label">机器控制权 <HelpLink topic="lease" /></p>
        <p className="mt-1 text-footnote text-secondary-label">
          同一时刻只有一个人能点动、设原点或发送命令；其他人只能查看。急停对所有人始终可用。
        </p>
        <p className="mt-3 text-subheadline text-label">{leaseText(lease)}</p>
        <LeaseActions className="mt-3" />
      </PopoverContent>
    </Popover>
  )
}
