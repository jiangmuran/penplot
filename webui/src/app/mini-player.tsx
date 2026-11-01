import { CircleCheck, CircleX, OctagonX, Pause, Play, Square, type LucideIcon } from 'lucide-react'
import * as React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { isJobActive, useLive } from '@/api/store'
import type { Job } from '@/api/types'
import { IconButton, ProgressBar } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDuration, formatDurationSpoken } from '@/lib/format'
import { confirmStopJob, togglePause } from './job-actions'
import { useUi } from './ui-store'

/** Routes that show the current job themselves; the global mini-player hides there. */
const SELF_SHOWING = ['/jobs']

/**
 * Hide the global mini-player (sidebar card / compact machine bar) while the calling component is
 * mounted — for pages that already show the current job prominently.
 *   useHideMiniPlayer()            // in a page component
 */
export function useHideMiniPlayer(active = true) {
  React.useEffect(() => {
    if (!active) return
    useUi.setState((s) => ({ miniPlayerHidden: s.miniPlayerHidden + 1 }))
    return () => useUi.setState((s) => ({ miniPlayerHidden: Math.max(0, s.miniPlayerHidden - 1) }))
  }, [active])
}

/** True when the mini-player should not render on the current route. */
export function useMiniPlayerSuppressed() {
  const { pathname } = useLocation()
  const hidden = useUi((s) => s.miniPlayerHidden > 0)
  return hidden || SELF_SHOWING.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

/** Job currently shown by the mini-player: the active job, or a just-finished one for 5 s. */
export function useMiniPlayerJob(): { job: Job | null; finished: boolean } {
  const job = useLive((s) => s.job)
  const finished = useLive((s) => s.finished)
  const clear = useLive((s) => s.clearFinished)
  const [, force] = React.useReducer((x: number) => x + 1, 0)
  React.useEffect(() => {
    if (!finished) return
    const left = 5000 - (Date.now() - finished.at)
    if (left <= 0) {
      clear()
      return
    }
    const t = setTimeout(() => {
      clear()
      force()
    }, left)
    return () => clearTimeout(t)
  }, [finished, clear])
  if (job && isJobActive(job)) return { job, finished: false }
  if (finished && Date.now() - finished.at < 5000) return { job: finished.job, finished: true }
  return { job: null, finished: false }
}

function useJobNumbers(job: Job) {
  const progress = useLive((s) => (s.progress?.job_id === job.id ? s.progress : null))
  const pct = progress?.percent ?? job.percent ?? (job.total_lines ? (100 * job.acked_line) / job.total_lines : 0)
  const eta = progress?.eta_s ?? job.eta_s ?? null
  return { pct, eta }
}

const FINISHED: Record<string, { label: string; icon: LucideIcon; cls: string }> = {
  done: { label: '已完成', icon: CircleCheck, cls: 'text-green' },
  failed: { label: '失败', icon: CircleX, cls: 'text-red' },
  aborted: { label: '已停止', icon: OctagonX, cls: 'text-secondary-label' },
  estop: { label: '已急停', icon: OctagonX, cls: 'text-red' },
}

function jobTitle(job: Job) {
  return job.batch_id && job.seq ? `${job.name} · 第 ${job.seq} 条` : job.name
}

/** Name + progress + controls; used inside the popover, sidebar card and compact bar. */
export function MiniPlayerBody({ job, finished, dense, allowStop = true }: { job: Job; finished?: boolean; dense?: boolean; allowStop?: boolean }) {
  const { pct, eta } = useJobNumbers(job)
  const estopAt = useLive((s) => (s.estop && s.estop.phase !== 'failed' ? s.estop.at : null))
  // Right after an E-stop the progress is meaningless: show a red 已急停 until the job event arrives.
  const estopped = (estopAt != null && Date.now() - estopAt < 15_000) || job.reason === 'estop'
  const fin = estopped ? FINISHED.estop : finished ? (FINISHED[job.status] ?? FINISHED.done) : null
  const statusText = fin
    ? fin.label
    : job.status === 'paused'
      ? `已暂停 · ${Math.floor(pct)}%`
      : job.status === 'preparing'
        ? '准备中…'
        : job.status === 'stopping'
          ? '正在停止…'
          : `${Math.floor(pct)}% · 剩余 ${formatDuration(eta)}`
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {fin ? <fin.icon className={cn('size-3.5 shrink-0', fin.cls)} /> : null}
          <span className={cn('truncate text-label', dense ? 'text-footnote font-semibold' : 'text-headline')}>{jobTitle(job)}</span>
        </div>
        {!fin ? (
          <ProgressBar
            value={job.status === 'preparing' ? null : pct}
            tone={job.status === 'paused' ? 'orange' : 'accent'}
            label="任务进度"
            valueText={`${Math.floor(pct)}%，剩余${formatDurationSpoken(eta)}`}
            className="my-1 h-0.5"
          />
        ) : null}
        <div className={cn('truncate text-footnote tabular-nums', fin ? fin.cls : 'text-secondary-label')}>{statusText}</div>
      </div>
      {!fin ? <MiniPlayerControls job={job} allowStop={allowStop} /> : null}
    </div>
  )
}

export function MiniPlayerControls({ job, size = 'md', allowStop = true }: { job: Job; size?: 'md' | 'lg'; allowStop?: boolean }) {
  const [busy, setBusy] = React.useState(false)
  const canToggle = job.status === 'running' || job.status === 'paused'
  return (
    <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
      <IconButton
        label={job.status === 'paused' ? '继续' : '暂停'}
        shortcut="space"
        size={size}
        disabled={!canToggle}
        loading={busy}
        onClick={async () => {
          setBusy(true)
          await togglePause(job)
          setBusy(false)
        }}
        className="text-label"
      >
        {job.status === 'paused' ? <Play fill="currentColor" /> : <Pause fill="currentColor" />}
      </IconButton>
      {allowStop ? (
        <IconButton label="停止…" size={size} disabled={job.status === 'stopping'} onClick={() => confirmStopJob(job)} className="text-label">
          <Square fill="currentColor" className="!size-[14px] pointer-coarse:!size-[18px]" />
        </IconButton>
      ) : null}
    </div>
  )
}

/** Sidebar-bottom card (regular). Hidden on /jobs. */
export function SidebarMiniPlayer() {
  const { job, finished } = useMiniPlayerJob()
  const navigate = useNavigate()
  const suppressed = useMiniPlayerSuppressed()
  if (!job || suppressed) return null
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`当前任务：${job.name}，打开任务页`}
      onClick={() => navigate('/jobs')}
      onKeyDown={(e) => e.key === 'Enter' && navigate('/jobs')}
      className="focus-ring mx-2 mb-2 cursor-default rounded-lg bg-bg-elevated/80 p-2.5 shadow-sm animate-pop-in hover:bg-bg-elevated"
    >
      <MiniPlayerBody job={job} finished={finished} dense />
    </div>
  )
}
