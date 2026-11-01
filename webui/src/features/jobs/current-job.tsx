import { ChevronDown, CirclePlay, Hand, Pause, Play, Square, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { useRole } from '@/api/collab'
import { useJobActions, useJobs } from '@/api/jobs'
import { pauseJob, resumeJob } from '@/api/machine'
import { runAction } from '@/features/machine/errors'
import { isJobActive, useLive } from '@/api/store'
import type { Job } from '@/api/types'
import { useWsEvent } from '@/api/ws'
import { confirmStopJob } from '@/app/job-actions'
import {
  Badge, Button, Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, EmptyState, ProgressRing,
} from '@/components/ui'
import { explainGrblLine } from '@/features/console/grbl-codes'
import { cn } from '@/lib/cn'
import { formatDuration, formatDurationSpoken, formatNumber } from '@/lib/format'
import { useMachineGate } from '@/features/machine/gate'
import { confirmStart } from './queue-card'
import { JobStatusBadge } from './shared'
import { PaperSlipped } from './paper-slipped'

/** Live pen trail from `progress.wpos` (machine space), drawn inside the job bbox. */
function useTrail(jobId: string | null) {
  const [trail, setTrail] = React.useState<{ id: string | null; pts: [number, number, boolean][] }>({ id: null, pts: [] })
  React.useEffect(() => setTrail({ id: jobId, pts: [] }), [jobId])
  useWsEvent('progress', (p) => {
    if (!jobId || p.job_id !== jobId || !p.wpos) return
    const [x, y, z] = p.wpos
    setTrail((t) => (t.id !== jobId ? t : { id: jobId, pts: [...t.pts.slice(-3000), [x, y, (z ?? 0) > 0.5]] }))
  })
  return trail.pts
}

function LiveTrack({ job }: { job: Job }) {
  const pts = useTrail(job.id)
  const wpos = useLive((s) => s.progress?.wpos ?? s.machine?.wpos ?? null)
  const bb = job.bbox && job.bbox.length === 4 ? job.bbox : null
  if (!bb) return null
  const [x0, y0, x1, y1] = bb
  const w = Math.max(1, x1 - x0)
  const h = Math.max(1, y1 - y0)
  const pad = Math.max(w, h) * 0.05
  // machine space is y-up → flip
  const segs: string[] = []
  let cur = ''
  for (const [x, y, down] of pts) {
    if (down) cur += `${cur ? 'L' : 'M'}${(x - x0).toFixed(2)} ${(y1 - y).toFixed(2)}`
    else if (cur) {
      segs.push(cur)
      cur = ''
    }
  }
  if (cur) segs.push(cur)
  return (
    <svg viewBox={`${-pad} ${-pad} ${w + 2 * pad} ${h + 2 * pad}`} className="h-full max-h-56 w-full" role="img" aria-label="实时笔迹">
      <rect x={0} y={0} width={w} height={h} rx={1} className="fill-canvas-paper stroke-separator" strokeWidth={Math.max(w, h) / 300} />
      {segs.map((d, i) => (
        <path key={i} d={d} fill="none" className="stroke-ink" strokeWidth={Math.max(w, h) / 220} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {wpos ? (
        <circle cx={wpos[0] - x0} cy={y1 - wpos[1]} r={Math.max(w, h) / 70} className="fill-accent stroke-bg-elevated" strokeWidth={Math.max(w, h) / 300} />
      ) : null}
    </svg>
  )
}

function Stat({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-footnote text-secondary-label">{label}</span>
      <span className={cn('truncate text-body font-semibold tabular-nums text-label', mono && 'font-mono')}>{value}</span>
    </div>
  )
}

export function CurrentJobCard({ compact }: { compact?: boolean }) {
  const { job, progress, machine, firmwareErrors, finished } = useLive(
    useShallow((s) => ({ job: s.job, progress: s.progress, machine: s.machine, firmwareErrors: s.firmwareErrors, finished: s.finished })),
  )
  const active = isJobActive(job)
  const blocked = useMachineGate().leaseBlocked
  if (!job || !active) return <IdleHero finished={finished?.job ?? null} />

  const pct = progress?.percent ?? job.percent ?? (job.total_lines ? (100 * (job.acked_line ?? 0)) / job.total_lines : 0)
  const acked = progress?.line_acked ?? job.acked_line ?? 0
  const total = progress?.total ?? job.total_lines
  const elapsed = progress?.elapsed_s ?? job.elapsed_s ?? 0
  const eta = progress?.eta_s ?? job.eta_s ?? null
  const wpos = progress?.wpos ?? machine?.wpos ?? null
  const paused = job.status === 'paused'
  const errors = [
    ...(job.errors ?? []).map((e) => ({ line: e.line, reply: e.reply, cmd: e.cmd })),
    ...firmwareErrors.filter((e) => e.job_id === job.id && !(job.errors ?? []).some((x) => x.line === e.line)).map((e) => ({ line: e.line, reply: e.reply, cmd: e.cmd })),
  ]
  const tone = paused ? 'orange' : 'accent'
  const finishAt = eta != null && !paused ? new Date(Date.now() + eta * 1000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : null

  const ring = (
    <ProgressRing value={pct} size={compact ? 120 : 132} stroke={compact ? 10 : 10} tone={tone} label="任务进度" valueText={`${Math.floor(pct)}%，剩余${formatDurationSpoken(eta)}`}>
      <div className="flex flex-col items-center">
        <span className={cn('font-semibold tabular-nums text-label', compact ? 'text-title1' : 'text-title1')}>{Math.floor(pct)}%</span>
        <span className="text-footnote text-secondary-label">{paused ? '已暂停' : finishAt ? `${finishAt} 写完` : '进行中'}</span>
      </div>
    </ProgressRing>
  )
  const size = compact ? 'xl' : 'lg'

  return (
    <Card className="overflow-hidden">
      <ProgressAnnouncer pct={pct} paused={paused} />
      <div className={cn('flex gap-5 p-4 md:p-5', compact ? 'flex-col' : 'flex-row items-start')}>
        {compact ? (
          <div className="flex w-full items-center gap-4">
            {ring}
            {job.bbox ? (
              <div className="min-w-0 flex-1 rounded-md bg-quaternary-fill p-1.5">
                <LiveTrack job={job} />
              </div>
            ) : null}
          </div>
        ) : (
          ring
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Link to={`/jobs/${job.id}`} className="min-w-0 truncate text-title3 text-label hover:underline">
              {job.name}
            </Link>
            <JobStatusBadge job={job} />
            {paused && job.pause_mode === 'hold' ? <Badge tone="orange">马上停住 · 笔可能还在纸上</Badge> : null}
          </div>
          <div className={cn('grid grid-cols-2 gap-x-4 gap-y-2.5', !compact && '2xl:grid-cols-4')}>
            <Stat label="行" value={`${acked.toLocaleString()} / ${total.toLocaleString()}`} />
            <Stat label="已用" value={formatDuration(elapsed)} />
            <Stat label="还要" value={paused ? '—' : formatDuration(eta)} />
            <Stat label="笔位置" mono value={wpos ? `${formatNumber(wpos[0], 1)}, ${formatNumber(wpos[1], 1)}` : '—'} />
          </div>
          <div className={cn('flex flex-wrap gap-2', compact && 'grid grid-cols-2')}>
            {paused ? (
              <Button size={size} variant="filled" icon={<Play />} disabled={blocked} onClick={() => runAction('继续任务失败', () => resumeJob(job))}>
                继续
              </Button>
            ) : (
              <div className="flex">
                <Button
                  size={size}
                  variant="filled"
                  icon={<Pause />}
                  className="flex-1 rounded-r-none"
                  disabled={blocked || job.status !== 'running'}
                  onClick={() => runAction('暂停任务失败', () => pauseJob(job, 'soft'))}
                >
                  暂停
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size={size} variant="filled" className="rounded-l-none border-l border-white/25 px-2" aria-label="暂停方式" disabled={blocked || job.status !== 'running'}>
                      <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-w-80">
                    <DropdownMenuItem icon={<Pause />} onSelect={() => runAction('暂停任务失败', () => pauseJob(job, 'soft'))}>
                      <div className="flex flex-col">
                        <span>写完这一笔再停（推荐）</span>
                        <span className="text-footnote opacity-80">几秒后停下并抬笔</span>
                      </div>
                    </DropdownMenuItem>
                    <DropdownMenuItem icon={<Hand />} onSelect={() => runAction('暂停任务失败', () => pauseJob(job, 'hold'))}>
                      <div className="flex flex-col">
                        <span>马上停住</span>
                        <span className="text-footnote opacity-80">笔可能停在纸上洇墨</span>
                      </div>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
            <Button size={size} variant="gray" icon={<Square />} disabled={blocked || job.status === 'stopping'} onClick={() => confirmStopJob(job)}>
              停止…
            </Button>
          </div>
          {paused ? <PaperSlipped job={job} disabled={blocked} /> : null}
        </div>
        {!compact && job.bbox ? (
          <div className="hidden w-64 shrink-0 items-center self-stretch rounded-md bg-quaternary-fill p-2 lg:flex">
            <LiveTrack job={job} />
          </div>
        ) : null}
      </div>
      {errors.length ? (
        <div className="hairline-t flex flex-col gap-1 bg-red/5 px-4 py-3 md:px-5" role="alert">
          <p className="flex items-center gap-1.5 text-footnote font-semibold text-on-tint-red">
            <TriangleAlert className="size-3.5" /> 控制板报错 {errors.length} 次
          </p>
          {errors.slice(0, 3).map((e, i) => {
            const x = explainGrblLine(e.reply)
            return (
              <p key={i} className="truncate text-footnote text-secondary-label">
                第 {e.line ?? '?'} 行的命令没有被执行{x ? `：${x.title}` : ''}
              </p>
            )
          })}
        </div>
      ) : null}
    </Card>
  )
}

/** Screen-reader progress every 10 % (review §4). */
function ProgressAnnouncer({ pct, paused }: { pct: number; paused: boolean }) {
  const step = Math.floor(pct / 10) * 10
  return (
    <span className="sr-only" aria-live={paused ? 'assertive' : 'polite'}>
      {paused ? '任务已暂停' : `已完成 ${step}%`}
    </span>
  )
}

function recipientOf(j: Job): string | null {
  const v = j.source?.variables
  if (!v || typeof v !== 'object') return null
  const vals = Object.values(v as Record<string, unknown>).filter((x) => typeof x === 'string' && x.trim()) as string[]
  return vals[0] ?? null
}

function IdleHero({ finished }: { finished: Job | null }) {
  const queued = useJobs({ status: 'queued' })
  const all = useJobs()
  const { start, startNext } = useJobActions()
  const machine = useLive((s) => s.machine)
  const blocked = useMachineGate().leaseBlocked
  const list = queued.data ?? []
  const next = list.slice().sort((a, b) => (a.batch_id === b.batch_id ? (a.seq ?? 0) - (b.seq ?? 0) : a.created_at - b.created_at))[0]
  const recent = finished && Date.now() / 1000 - (finished.finished_at ?? 0) < 600 ? finished : null
  const disabled = !machine?.connected || blocked
  const admin = useRole() === 'admin'

  // Batch: 「已放好第 4/120 张 → 继续」 (review §1.4)
  if (next?.batch_id) {
    const batch = (all.data ?? []).filter((j) => j.batch_id === next.batch_id)
    const total = batch.length
    const done = batch.filter((j) => j.status === 'done').length
    const n = next.seq ?? done + 1
    const who = recipientOf(next)
    return (
      <Card className="flex flex-col items-center gap-4 px-5 py-8 text-center">
        <p className="text-subheadline text-secondary-label">
          批量任务 · 已完成 {done}/{total}
        </p>
        <h2 className="text-title2 text-label">换上第 {n} 张纸</h2>
        <p className="text-callout text-secondary-label">
          {who ? <>下一张写给 <b className="text-label">{who}</b>。</> : `下一张：${next.name}。`}放好纸、确认笔在原点上方后继续。
        </p>
        <Button
          variant="filled"
          size="xl"
          icon={<Play />}
          className="w-full max-w-sm"
          loading={startNext.isPending || start.isPending}
          disabled={disabled}
          onClick={() => start.mutate({ id: next.id })}
        >
          已放好第 {n}/{total} 张，继续
        </Button>
        {disabled ? <p className="text-footnote text-secondary-label">{!machine?.connected ? '写字机没有连接，先到「控制」页连接。' : '控制权在别人手里。'}</p> : null}
      </Card>
    )
  }

  return (
    <Card>
      <EmptyState
        className="py-10"
        icon={CirclePlay}
        title={recent ? `「${recent.name}」${recent.status === 'done' ? '写完了' : '已结束'}` : '没有进行中的任务'}
        description={
          recent?.status === 'done' && recent.est_s && recent.started_at && recent.finished_at
            ? doneText(recent)
            : next
              ? `队列里还有 ${list.length} 个任务。`
              : '还没开始写。把纸放好、笔（抬起）停在要写内容的左上角，然后在创作台点「打印」。'
        }
        action={
          next ? (
            next.out_of_work_area && !admin ? (
              <Button asChild variant="gray" size="lg">
                <Link to={`/jobs/${next.id}`}>「{next.name}」超出行程 · 查看原因</Link>
              </Button>
            ) : (
              <Button
                variant="filled"
                size="lg"
                icon={<Play />}
                loading={start.isPending}
                disabled={disabled}
                onClick={async () => {
                  if (await confirmStart(next, machine?.origin_valid)) start.mutate({ id: next.id })
                }}
              >
                开始「{next.name}」
              </Button>
            )
          ) : (
            <Button asChild variant="filled" size="lg">
              <Link to="/studio">去创作台</Link>
            </Button>
          )
        }
      >
        {next && !machine?.connected ? <p className="mt-2 text-footnote text-secondary-label">写字机没有连接，先到「控制」页连接。</p> : null}
      </EmptyState>
    </Card>
  )
}

function doneText(j: Job) {
  const real = (j.finished_at ?? 0) - (j.started_at ?? 0)
  const diff = Math.round((real - (j.est_s ?? real)) / 60)
  const mins = Math.max(1, Math.round(real / 60))
  return diff === 0 ? `这次用了 ${mins} 分钟，和预计一样。` : `这次用了 ${mins} 分钟，比预计${diff < 0 ? '快' : '慢'} ${Math.abs(diff)} 分钟。`
}
