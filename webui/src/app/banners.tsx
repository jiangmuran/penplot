import { CirclePause, Siren, WifiOff } from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'
import { describeError } from '@/api/errors'
import { clearHold, runAction, unlockMachine } from '@/api/machine'
import { isStrayHold } from '@/api/status-view'
import { toast } from '@/lib/toast'
import { useNet } from '@/api/net'
import { queryClient } from '@/api/query'
import { useLive } from '@/api/store'
import { ws } from '@/api/ws'
import { Button } from '@/components/ui'
import { cn } from '@/lib/cn'

function useCountdown(at: number | null) {
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    if (!at) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [at])
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : null
}

/** Yellow banner while the WebSocket is down (02-ux §2.6). Shown after the first failed attempt. */
export function ConnectionBanner() {
  const conn = useLive((s) => s.conn)
  const attempts = useLive((s) => s.attempts)
  const everConnected = useLive((s) => s.everConnected)
  const nextRetryAt = useLive((s) => s.nextRetryAt)
  const secs = useCountdown(nextRetryAt)
  // REST requests failing with network errors / 502 / 503 / 504 (WiFi drop) count as a dropped link too
  const restDown = useNet((s) => s.downSince != null)
  const wsDown = !(conn === 'open' || conn === 'idle' || (attempts < 1 && !everConnected))
  if (!wsDown && !restDown) return null
  return (
    <Banner tone="yellow" icon={<WifiOff className="size-4" />}>
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{everConnected || restDown ? '连接中断' : '无法连接到设备'}</span>
        <span className="text-secondary-label">
          {' '}
          · {wsDown && secs ? `${secs} 秒后重连…` : '正在重连…'}
          <span className="hidden sm:inline"> 写字机会继续写当前任务，不受网页断线影响；机器控件暂时禁用，急停仍会尝试发送。</span>
        </span>
      </span>
      <Button size="sm" variant="plain" className="text-label" onClick={() => {
          ws.restart()
          void queryClient.refetchQueries({ type: 'active' })
        }}>
        立即重试
      </Button>
    </Banner>
  )
}

/** Red banner while GRBL is in Alarm (02-ux §2.6: Alarm is a banner, not a toast). */
export function AlarmBanner() {
  const alarm = useLive((s) => s.alarm)
  const inAlarm = useLive((s) => !!s.machine?.grbl_state?.startsWith('Alarm'))
  const [busy, setBusy] = React.useState(false)
  if (!inAlarm) return null
  return (
    <Banner tone="red" icon={<Siren className="size-4" />} live="assertive">
      <span className="min-w-0 flex-1">
        <span className="font-semibold">报警{alarm?.code != null ? ` ${alarm.code}` : ''}</span>
        <span className="text-secondary-label"> · {alarm?.hint || alarm?.text || '机器处于报警锁定状态，需要解锁'}</span>
      </span>
      <Button
        size="sm"
        variant="destructive"
        loading={busy}
        onClick={async () => {
          setBusy(true)
          await runAction('解锁失败', unlockMachine)
          setBusy(false)
        }}
      >
        解锁 $X
      </Button>
      <Button size="sm" variant="plain" className="text-label" asChild>
        <Link to="/machine">打开控制</Link>
      </Button>
    </Banner>
  )
}

export const STRAY_HOLD_TEXT = '写字机处于暂停状态（可能按了机器上的暂停键，或断线重连后保留了暂停）'

/** True while GRBL is held but no job / teletype session owns the pause. */
export function useStrayHold() {
  return useLive((s) => isStrayHold(s.machine, s.job))
}

export function useClearHold() {
  const [busy, setBusy] = React.useState(false)
  const run = async () => {
    setBusy(true)
    try {
      await clearHold()
      toast.success('已解除暂停')
    } catch (e) {
      const d = describeError(e)
      toast.error('解除暂停失败', { description: d.hint ? `${d.title}。${d.hint}` : d.title, key: 'clear-hold' })
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

/** Orange banner: feed hold without a job (machine pause button / hold kept over a reconnect). */
export function HoldBanner() {
  const held = useStrayHold()
  const { busy, run } = useClearHold()
  if (!held) return null
  return (
    <Banner tone="yellow" icon={<CirclePause className="size-4" />}>
      <span className="min-w-0 flex-1">
        <span className="font-semibold">机器暂停</span>
        <span className="text-secondary-label"> · {STRAY_HOLD_TEXT}</span>
      </span>
      <Button size="sm" variant="filled" loading={busy} onClick={run}>
        解除暂停
      </Button>
    </Banner>
  )
}

function Banner({ tone, icon, children, live = 'polite' }: { tone: 'yellow' | 'red'; icon: React.ReactNode; children: React.ReactNode; live?: 'polite' | 'assertive' }) {
  return (
    <div
      role="status"
      aria-live={live}
      className={cn(
        'flex min-h-9 shrink-0 items-center gap-2.5 px-4 py-1.5 text-footnote text-label hairline-b animate-fade-in md:px-6',
        tone === 'yellow' ? 'bg-yellow/20' : 'bg-red/12',
      )}
    >
      <span className={tone === 'yellow' ? 'text-on-tint-orange' : 'text-red'}>{icon}</span>
      {children}
    </div>
  )
}
