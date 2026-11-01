import { CircleCheck, CircleDashed, CirclePause, CircleStop, CircleX, Clock, FileCode2, Layers, Loader, PenLine, Siren } from 'lucide-react'
import { create } from 'zustand'
import { JOB_STATUS_LABEL, jobTone } from '@/api/jobs'
import type { Job, JobStatus } from '@/api/types'
import { ws } from '@/api/ws'
import { reasonText } from '@/app/live-effects'
import { Badge } from '@/components/ui'

const ICON: Record<JobStatus, typeof CircleCheck> = {
  queued: Clock,
  preparing: Loader,
  running: Loader,
  paused: CirclePause,
  stopping: CircleDashed,
  done: CircleCheck,
  failed: CircleX,
  aborted: CircleStop,
}

export function JobStatusBadge({ job, size = 'md' }: { job: Pick<Job, 'status' | 'reason'>; size?: 'sm' | 'md' }) {
  const alarm = job.reason?.startsWith('alarm') || job.reason === 'estop'
  const Icon = alarm ? Siren : ICON[job.status]
  const label = job.status === 'aborted' && job.reason === 'estop' ? '已急停' : JOB_STATUS_LABEL[job.status]
  return (
    <Badge tone={jobTone(job)} icon={Icon} size={size}>
      {label}
    </Badge>
  )
}

export function jobOutcome(job: Job): string {
  if (job.status === 'done') return '已完成'
  const r = reasonText(job.reason)
  return r ? `${JOB_STATUS_LABEL[job.status]} · ${r}` : JOB_STATUS_LABEL[job.status]
}

export function sourceInfo(job: Pick<Job, 'source' | 'seq' | 'batch_id'>): { icon: typeof Layers; label: string } {
  const s = job.source ?? {}
  if (s.batch_row != null) return { icon: Layers, label: `批量 第 ${s.batch_row + 1} 行` }
  if (s.project_id) return { icon: PenLine, label: `项目${s.page != null ? ` · 第 ${s.page + 1} 页` : ''}` }
  if (s.file_id) return { icon: FileCode2, label: 'G 代码文件' }
  if (s.render_id) return { icon: PenLine, label: '快速渲染' }
  return { icon: FileCode2, label: '—' }
}

export function formatDateTime(t: number | null | undefined) {
  if (!t) return '—'
  const d = new Date(t * 1000)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `今天 ${time}`
  const y = new Date(today)
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return `昨天 ${time}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`
}

export function jobDuration(job: Job): number | null {
  if (job.started_at && job.finished_at) return job.finished_at - job.started_at
  if (job.elapsed_s) return job.elapsed_s
  return null
}

// ---- state-transition timeline captured from WS `job` events during this page session ----

export interface TimelineEvent {
  ts: number
  from: string
  to: string
  reason?: string | null
}

export const useTimeline = create<{ events: Record<string, TimelineEvent[]> }>(() => ({ events: {} }))

ws.on('job', (e, raw) => {
  if (!e?.job_id || e.from === e.to) return
  const ts = typeof raw.ts === 'number' ? raw.ts : Date.now() / 1000
  const list = useTimeline.getState().events[e.job_id] ?? []
  useTimeline.setState((s) => ({ events: { ...s.events, [e.job_id]: [...list, { ts, from: e.from ?? '', to: e.to ?? '', reason: e.reason }].slice(-50) } }))
})
