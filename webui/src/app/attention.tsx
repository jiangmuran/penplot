/**
 * Shell attention layer (05-review §0-3, §3.6): turns WS events into sound / notification / banner,
 * keeps document.title informative ("68% · 通知函 — PenPlot"), holds a screen wake lock while
 * writing, re-syncs when the tab comes back, and announces control-lease changes.
 */
import { BellRing, CirclePause, ListChecks, Play, X } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthState } from '@/api/auth'
import { api } from '@/api/client'
import { refreshLive, runAction } from '@/api/machine'
import { isJobActive, useLive } from '@/api/store'
import { startJobGuarded } from '@/api/job-guard'
import type { components } from '@/api/schema'
import type { Job } from '@/api/types'
import { ws } from '@/api/ws'
import { Button } from '@/components/ui'
import {
  acknowledgeAttention, alertUser, type AttentionKind, installAudioUnlock, markNotificationsAsked, notificationState, notificationsAsked,
  requestNotifications, useAttention,
} from '@/lib/attention'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { useChrome } from './chrome'

/** Mounted once by the shell. */
export function AttentionEffects() {
  const auth = useAuthState()
  const me = auth.data?.user ?? null
  const meRef = React.useRef(me)
  meRef.current = me

  React.useEffect(() => {
    installAudioUnlock()
    let lastLeaseHolder: string | null | undefined
    const offs = [
      ws.on('job', (e) => {
        const job = e.job as Job | null
        if (!job || e.from === e.to) return
        const att = useAttention.getState()
        // Any progress resolves a pending attention item for this job.
        if (e.to === 'running' || e.to === 'preparing') {
          if (att.item && (!att.item.jobId || att.item.jobId === job.id || att.item.batchId === job.batch_id)) att.dismiss()
        }
        if (e.to === 'running' && e.from === 'preparing') maybeOfferNotifications()
      }),
      // Server-side attention events (04 §11) drive sound / notification / banner.
      ws.on('attention', (a) => onAttention(a)),
      ws.on('lease' as never, (raw: unknown) => {
        const l = raw as { held?: boolean; holder?: { username?: string; display_name?: string } | null; reason?: string }
        const holder = l.held ? (l.holder?.username ?? null) : null
        if (lastLeaseHolder === undefined) {
          lastLeaseHolder = holder
          return
        }
        if (holder === lastLeaseHolder) return
        const prev = lastLeaseHolder
        lastLeaseHolder = holder
        const mine = meRef.current
        const name = l.holder?.display_name || l.holder?.username
        if (holder && holder !== mine) toast.info(`${name} 正在控制写字机`, { key: 'lease', description: prev === mine ? '你的控制权已被接管，手动操作暂不可用。' : undefined })
        else if (holder && holder === mine && prev) toast.success('你已获得写字机控制权', { key: 'lease' })
        else if (!holder && prev && prev !== mine) toast.info('写字机控制权已释放', { key: 'lease', description: '现在可以操作写字机了。' })
      }),
      ws.on('hello', (h) => {
        const lease = (h.snapshot as { lease?: { held?: boolean; holder?: { username?: string } } }).lease
        if (lease) lastLeaseHolder = lease.held ? (lease.holder?.username ?? null) : null
      }),
    ]
    return () => offs.forEach((o) => o())
  }, [])

  // Back in front: stop flashing, re-sync immediately (WS may have been suspended by iOS).
  React.useEffect(() => {
    let hiddenAt = 0
    const onVis = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now()
      else {
        acknowledgeAttention()
        if (hiddenAt && Date.now() - hiddenAt > 3000) void refreshLive()
      }
    }
    const onFocus = () => acknowledgeAttention()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useReconnectToast()
  useWakeLock()
  useDocumentTitle()
  return null
}

/** After a dropped connection: "已重新连接 · 刚才写完了 12%". */
function useReconnectToast() {
  React.useEffect(() => {
    let lostAt: number | null = null
    let pctAtLoss: number | null = null
    return useLive.subscribe((s, prev) => {
      if (prev.conn === 'open' && s.conn !== 'open') {
        lostAt = Date.now()
        pctAtLoss = s.job && isJobActive(s.job) ? (s.progress?.percent ?? s.job.percent ?? null) : null
      } else if (s.conn === 'open' && prev.conn !== 'open' && lostAt) {
        const away = Date.now() - lostAt
        lostAt = null
        if (away < 4000) return
        const now = s.job && isJobActive(s.job) ? (s.progress?.percent ?? s.job.percent ?? null) : null
        const delta = pctAtLoss != null && now != null ? Math.max(0, Math.floor(now - pctAtLoss)) : null
        toast.success('已重新连接', { key: 'ws', description: delta ? `断线期间写完了 ${delta}%` : '状态已同步' })
      }
    })
  }, [])
}

type AttentionData = components['schemas']['AttentionData']

const BANNER_CODES = new Set(['paper_change', 'job_failed', 'gcode_error', 'serial_lost', 'client_loss_pause'])
const TITLES: Record<string, string> = {
  job_done: '写完了',
  paper_change: '请换纸后继续',
  job_failed: '任务失败',
  estop: '已急停',
  alarm: '写字机报警',
  gcode_error: '写字机返回错误',
  serial_lost: '与写字机的串口连接断开',
  client_loss_pause: '没有人在看，任务已自动暂停',
  lease_taken: '控制权变更',
  lease_released: '控制权已释放',
}

function onAttention(a: AttentionData) {
  if (!a || typeof a !== 'object') return
  const lease = a.code === 'lease_taken' || a.code === 'lease_released'
  const kind: AttentionKind =
    a.code === 'alarm' ? 'alarm' : a.sound === 'done' ? 'done' : a.sound === 'paper' ? 'paper' : a.sound === 'error' ? 'error' : 'info'
  alertUser({
    kind,
    title: TITLES[a.code] ?? a.message,
    body: TITLES[a.code] ? a.message : undefined,
    tag: `penplot-${a.code}-${a.job_id ?? a.session_id ?? ''}`,
    // lease changes are announced by the lease toast; E-stop has its own card; alarm has its banner
    banner: BANNER_CODES.has(a.code) ? { jobId: a.job_id ?? undefined, batchId: a.batch_id, nextJobId: a.next_job_id, sessionId: a.session_id, code: a.code } : undefined,
    quiet: lease,
  })
}

/** Ask (politely, once) whether to notify — via a toast whose button is the required user gesture. */
function maybeOfferNotifications() {
  if (notificationsAsked() || notificationState() !== 'default' || !window.isSecureContext) return
  markNotificationsAsked()
  toast.info('写完或需要换纸时提醒你？', {
    key: 'notify-offer',
    duration: 12_000,
    description: '开启后，即使切到其他标签页也能收到通知。可在 设置 › 通用 中修改。',
    action: {
      label: '开启提醒',
      onClick: async () => {
        const r = await requestNotifications()
        if (r === 'granted') toast.success('已开启提醒')
      },
    },
  })
}

/** Keep the screen on while a job runs and the page is visible (setting: 写字时保持屏幕常亮). */
function useWakeLock() {
  const active = useLive((s) => isJobActive(s.job))
  const enabled = useAttention((s) => s.prefs.wakeLock)
  React.useEffect(() => {
    const wl = (navigator as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock
    if (!active || !enabled || !wl) return
    let sentinel: { release: () => Promise<void> } | null = null
    let cancelled = false
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || sentinel) return
      try {
        sentinel = await wl.request('screen')
        if (cancelled) void sentinel.release()
        ;(sentinel as unknown as EventTarget).addEventListener?.('release', () => (sentinel = null))
      } catch {
        sentinel = null
      }
    }
    void acquire()
    const onVis = () => void acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
      void sentinel?.release().catch(() => {})
    }
  }, [active, enabled])
}

/** "68% · 通知函 — PenPlot" while writing, "⏸ 已暂停 — …", flashing "⏸ 请换纸" in the background. */
function useDocumentTitle() {
  const title = useChrome((c) => c.title)
  const job = useLive((s) => s.job)
  const pct = useLive((s) => s.progress?.percent ?? null)
  const flash = useAttention((s) => s.flash)
  const [tick, setTick] = React.useState(false)
  React.useEffect(() => {
    if (!flash) return
    const t = setInterval(() => setTick((x) => !x), 1000)
    return () => clearInterval(t)
  }, [flash])
  React.useEffect(() => {
    const base = title ? `${title} — PenPlot` : 'PenPlot'
    let t = base
    if (job && isJobActive(job)) {
      const p = Math.floor(pct ?? job.percent ?? 0)
      t = job.status === 'paused' ? `⏸ 已暂停 · ${job.name} — PenPlot` : `${p}% · ${job.name} — PenPlot`
    }
    if (flash && tick) t = `${flash} · PenPlot`
    document.title = t
  }, [title, job, pct, flash, tick])
}

/** Banner for things that need the user's hands: change paper, paused on error, failed. */
export function AttentionBanner() {
  const item = useAttention((s) => s.item)
  const dismiss = useAttention((s) => s.dismiss)
  const job = useLive((s) => s.job)
  const navigate = useNavigate()
  const [busy, setBusy] = React.useState(false)
  if (!item || item.kind === 'done' || item.kind === 'alarm' || item.kind === 'info') return null
  const paper = item.kind === 'paper'
  const pausedHere = job && job.id === item.jobId && job.status === 'paused'
  return (
    <div
      role="alert"
      className={cn(
        'flex min-h-11 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2 text-footnote text-label hairline-b animate-fade-in md:px-6',
        paper ? 'bg-blue/12' : 'bg-orange/15',
      )}
    >
      {paper ? <BellRing className="size-4 text-accent" /> : <CirclePause className="size-4 text-on-tint-orange" />}
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{item.title}</span>
        {item.body ? <span className="text-secondary-label"> · {item.body}</span> : null}
      </span>
      {paper && item.sessionId ? (
        <Button size="sm" variant="filled" icon={<Play />} onClick={() => navigate('/teletype')}>
          去换纸
        </Button>
      ) : paper && (item.nextJobId || item.batchId) ? (
        <Button
          size="sm"
          variant="filled"
          icon={<Play />}
          loading={busy}
          onClick={async () => {
            setBusy(true)
            let done = false
            const ok = await runAction('无法开始下一页', async () => {
              if (item.nextJobId) done = !!(await startJobGuarded(item.nextJobId))
              else done = !!(await api.post(`/batches/${item.batchId}/start-next`, {}))
            })
            setBusy(false)
            if (ok && done) dismiss(item.id)
          }}
        >
          已换纸，继续下一页
        </Button>
      ) : pausedHere ? (
        <Button size="sm" variant="filled" icon={<Play />} onClick={() => navigate('/jobs')}>
          查看并继续
        </Button>
      ) : null}
      <Button size="sm" variant="plain" className="text-label" icon={<ListChecks />} onClick={() => navigate('/jobs')}>
        任务
      </Button>
      <button type="button" aria-label="关闭提醒" onClick={() => dismiss(item.id)} className="focus-ring flex size-8 items-center justify-center rounded-full text-secondary-label hover:bg-quaternary-fill">
        <X className="size-4" />
      </button>
    </div>
  )
}
