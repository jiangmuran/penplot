import { Download, FolderOpen, Play, RotateCcw, Square, Trash2, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { isApiError } from '@/api/client'
import { downloadFrom } from '@/api/download'
import { useJob, useJobActions, useJobLog } from '@/api/jobs'
import { pauseJob, resumeJob } from '@/api/machine'
import { runAction } from '@/features/machine/errors'
import { isJobActive, useLive } from '@/api/store'
import type { Job } from '@/api/types'
import { TERMINAL_JOB_STATUSES } from '@/api/types'
import { confirmStopJob } from '@/app/job-actions'
import { reasonText } from '@/app/live-effects'
import {
  Button, ErrorState, GroupedList, ListRow, ProgressBar, Sheet, SheetContent, Skeleton,
} from '@/components/ui'
import { VirtualList } from '@/features/console/virtual-list'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { formatDuration, formatNumber, formatTime } from '@/lib/format'
import { toast } from '@/lib/toast'
import { confirmStart } from './queue-card'
import { OutcomeCard } from './outcome-card'
import { RecoveryWizard, isRecoverable } from './recovery-wizard'
import { useMachineGate } from '@/features/machine/gate'
import { JobStatusBadge, formatDateTime, jobDuration, sourceInfo, useTimeline, type TimelineEvent } from './shared'

const OVERRIDE_LABEL: Record<string, [string, string]> = {
  feed_rate: ['进给', 'mm/min'],
  jog_speed: ['空走速度', 'mm/min'],
  pen_down_z: ['落笔 Z', 'mm'],
  pen_up_z: ['抬笔 Z', 'mm'],
  z_speed: ['Z 速度', 'mm/min'],
  copies: ['份数', ''],
  optimize: ['路径优化', ''],
}

export function JobDetailSheet({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent width={480} title="任务详情" defaultDetent="large">
        {id ? <JobDetail id={id} onClose={onClose} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function JobDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useJob(id)
  const live = useLive((s) => (s.job?.id === id ? s.job : null))
  const job = live ?? (q.data && typeof q.data === 'object' && 'id' in q.data && 'status' in q.data ? q.data : undefined)
  if (q.isLoading && !job)
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  if (!job)
    return (
      <ErrorState
        title={isApiError(q.error) && q.error.status === 404 ? '任务不存在或已删除' : '加载失败'}
        error={isApiError(q.error) && q.error.status === 404 ? undefined : q.error}
        onRetry={() => q.refetch()}
      />
    )
  return <JobDetailBody job={job} onClose={onClose} />
}

function buildTimeline(job: Job, events: TimelineEvent[]) {
  const items: { ts: number; label: string; tone: string; detail?: string }[] = [{ ts: job.created_at, label: '创建', tone: 'bg-gray' }]
  if (job.started_at) items.push({ ts: job.started_at, label: '开始打印', tone: 'bg-blue' })
  for (const e of events) {
    if (e.to === 'paused') items.push({ ts: e.ts, label: '暂停', tone: 'bg-orange' })
    else if (e.to === 'running' && e.from === 'paused') items.push({ ts: e.ts, label: '继续', tone: 'bg-blue' })
    else if (e.to === 'stopping') items.push({ ts: e.ts, label: '正在停止', tone: 'bg-gray' })
  }
  for (const err of job.errors ?? []) items.push({ ts: err.ts, label: '控制板报错', tone: 'bg-red', detail: err.line ? `第 ${err.line} 行的命令没有被执行` : undefined })
  if (job.finished_at) {
    const tone = job.status === 'done' ? 'bg-green' : job.status === 'failed' ? 'bg-red' : 'bg-gray'
    items.push({ ts: job.finished_at, label: job.status === 'done' ? '完成' : job.status === 'failed' ? '失败' : '已停止', tone, detail: reasonText(job.reason) || undefined })
  }
  return items.sort((a, b) => a.ts - b.ts)
}

function JobDetailBody({ job, onClose }: { job: Job; onClose: () => void }) {
  const navigate = useNavigate()
  const { start, retry, remove } = useJobActions()
  const progress = useLive((s) => (s.progress?.job_id === job.id ? s.progress : null))
  const machine = useLive((s) => s.machine)
  const events = useTimeline((s) => s.events[job.id]) ?? []
  const active = isJobActive(job)
  const blocked = useMachineGate().leaseBlocked
  const [wizard, setWizard] = React.useState(false)
  const terminal = TERMINAL_JOB_STATUSES.includes(job.status)
  const pct = progress?.percent ?? job.percent ?? (job.total_lines ? (100 * (job.acked_line ?? 0)) / job.total_lines : 0)
  const acked = progress?.line_acked ?? job.acked_line ?? 0
  const src = sourceInfo(job)
  const timeline = buildTimeline(job, events)
  const bb = job.bbox && job.bbox.length === 4 ? job.bbox : null
  const overrides = Object.entries(job.overrides ?? {}).filter(([, v]) => v != null && typeof v !== 'object')

  const doRetry = (from?: number) =>
    retry.mutate(
      { id: job.id, from_line: from },
      { onSuccess: (j) => (toast.success(from ? `已创建续写任务（从第 ${from} 行）` : '已加入队列', { description: j?.name }), navigate(`/jobs/${j.id}`)) },
    )

  return (
    <div className="flex flex-col gap-5 px-4 pb-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 break-words text-title3 text-label">{job.name}</h2>
          <JobStatusBadge job={job} />
        </div>
        {job.reason ? <p className="text-subheadline text-secondary-label">{reasonText(job.reason)}</p> : null}
        {active || job.status === 'queued' ? (
          <div className="flex flex-col gap-1.5">
            <ProgressBar value={pct} tone={job.status === 'paused' ? 'orange' : 'accent'} label="进度" valueText={`${Math.floor(pct)}%`} />
            <p className="text-footnote text-secondary-label tabular-nums">
              {Math.floor(pct)}% · 行 {acked.toLocaleString()} / {job.total_lines.toLocaleString()}
              {active ? ` · 剩余约 ${formatDuration(progress?.eta_s ?? job.eta_s)}` : ''}
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-1">
          {job.status === 'queued' ? (
            <Button
              variant="filled"
              icon={<Play />}
              disabled={blocked || !machine?.connected || !!useLive.getState().job}
              loading={start.isPending}
              onClick={async () => {
                if (await confirmStart(job, machine?.origin_valid)) start.mutate({ id: job.id })
              }}
            >
              开始
            </Button>
          ) : null}
          {job.status === 'running' ? (
            <Button variant="filled" disabled={blocked} onClick={() => runAction('暂停失败', () => pauseJob(job))}>暂停</Button>
          ) : null}
          {job.status === 'paused' ? (
            <Button variant="filled" icon={<Play />} disabled={blocked} onClick={() => runAction('继续失败', () => resumeJob(job))}>继续</Button>
          ) : null}
          {active ? (
            <Button variant="gray" icon={<Square />} disabled={blocked} onClick={() => confirmStopJob(job)}>停止…</Button>
          ) : null}
          {job.status === 'done' ? (
            <Button variant="tinted" icon={<RotateCcw />} loading={retry.isPending} onClick={() => doRetry()}>
              再写一份
            </Button>
          ) : null}
          <Button variant="gray" icon={<Download />} onClick={() => runAction('下载失败', () => downloadFrom(`/jobs/${job.id}/gcode`, `${job.name}.gcode`))}>
            G 代码
          </Button>
          {job.source?.project_id ? (
            <Button variant="gray" icon={<FolderOpen />} onClick={() => navigate(`/studio/${job.source.project_id}`)}>
              打开项目
            </Button>
          ) : null}
        </div>
      </div>

      {terminal && job.status !== 'done' ? <OutcomeCard job={job} onWizard={() => setWizard(true)} /> : null}

      <GroupedList header="信息">
        <ListRow label="来源" value={src.label} />
        <ListRow label="G 代码" value={`${job.total_lines.toLocaleString()} 行`} />
        <ListRow label="用时" value={durationText(job)} />
        <ListRow label="创建" value={formatDateTime(job.created_at)} />
        {job.started_at ? <ListRow label="开始" value={formatDateTime(job.started_at)} /> : null}
        {job.finished_at ? <ListRow label="结束" value={formatDateTime(job.finished_at)} /> : null}
        {bb ? <ListRow label="作品范围" value={`${formatNumber(bb[2] - bb[0], 1)} × ${formatNumber(bb[3] - bb[1], 1)} mm`} /> : null}
        {job.out_of_work_area || job.issues?.length ? (
          <ListRow
            label={<span className="flex items-center gap-1.5 text-on-tint-orange"><TriangleAlert className="size-4" />{job.issues?.length ? '安全检查未通过' : '超出机器行程'}</span>}
            subtitle={job.issues?.length ? job.issues.join('；') : undefined}
          />
        ) : null}
        {job.profile_id ? <ListRow label="机器配置" value={job.profile_id} /> : null}
        {overrides.map(([k, v]) => (
          <ListRow key={k} label={OVERRIDE_LABEL[k]?.[0] ?? k} value={typeof v === 'boolean' ? (v ? '开' : '关') : `${v}${OVERRIDE_LABEL[k]?.[1] ? ` ${OVERRIDE_LABEL[k][1]}` : ''}`} />
        ))}
      </GroupedList>

      <section aria-label="时间线">
        <h3 className="mb-1.5 px-4 text-footnote font-medium uppercase tracking-wide text-secondary-label">时间线</h3>
        <ol className="relative ml-6 flex flex-col gap-3 border-l border-separator pl-5">
          {timeline.map((t, i) => (
            <li key={i} className="relative">
              <span className={cn('absolute -left-[25px] top-1.5 size-2.5 rounded-full ring-4 ring-bg-elevated', t.tone)} />
              <div className="flex items-baseline gap-2">
                <span className="text-body text-label">{t.label}</span>
                <span className="text-footnote text-secondary-label tabular-nums">{formatTime(t.ts)}</span>
              </div>
              {t.detail ? <p className="text-footnote text-secondary-label">{t.detail}</p> : null}
            </li>
          ))}
        </ol>
      </section>

      <JobLog job={job} />
      {isRecoverable(job) ? <RecoveryWizard job={job} open={wizard} onOpenChange={setWizard} /> : null}

      {terminal || job.status === 'queued' ? (
        <Button
          variant="destructive-tinted"
          icon={<Trash2 />}
          onClick={async () => {
            if (await confirm({ title: '删除这条任务记录？', confirmLabel: '删除', destructive: true })) {
              remove.mutate(job.id, { onSuccess: () => (toast.success('已删除'), onClose()) })
            }
          }}
        >
          删除任务
        </Button>
      ) : null}
    </div>
  )
}

function JobLog({ job }: { job: Job }) {
  const active = isJobActive(job)
  const q = useJobLog(job.id, active)
  const lines = Array.isArray(q.data?.lines) ? q.data.lines : []
  return (
    <section aria-label="串口日志">
      <div className="mb-1.5 flex items-center px-4">
        <h3 className="flex-1 text-footnote font-medium uppercase tracking-wide text-secondary-label">串口日志</h3>
        {active ? (
          <Button size="sm" variant="plain" onClick={() => q.refetch()} loading={q.isFetching}>
            刷新
          </Button>
        ) : null}
      </div>
      {!active ? (
        <p className="rounded-lg bg-bg-grouped-secondary px-4 py-3 text-footnote text-secondary-label shadow-sm">日志只在任务进行中保留在内存里；完整记录请在「调试」页实时查看。</p>
      ) : q.isLoading ? (
        <Skeleton className="h-40 w-full rounded-lg" />
      ) : q.error ? (
        <p className="rounded-lg bg-bg-grouped-secondary px-4 py-3 text-footnote text-secondary-label shadow-sm">日志不可用：{q.error.message}</p>
      ) : (
        <VirtualList
          count={lines.length}
          rowHeight={18}
          follow
          role="log"
          aria-label="任务串口日志"
          className="h-56 rounded-lg bg-bg-grouped-secondary py-1 font-mono text-caption shadow-sm"
          empty={<p className="px-4 py-3 text-footnote text-secondary-label">暂无日志</p>}
          renderRow={(i) => {
            const l = lines[i]
            const err = /^(error|ALARM)/i.test(l.text)
            return (
              <div className={cn('flex gap-2 truncate px-3 leading-[18px]', err ? 'text-red' : l.dir === '>' ? 'text-accent' : 'text-label')}>
                <span className="text-tertiary-label">{formatTime(l.t)}</span>
                <span className="w-3 text-tertiary-label">{l.dir === '>' ? '→' : l.dir === '<' ? '←' : '!'}</span>
                <span className="truncate">{l.text}</span>
              </div>
            )
          }}
        />
      )}
    </section>
  )
}

function durationText(job: Job): string {
  const real = jobDuration(job)
  if (job.status === 'done' && real != null && job.est_s) {
    const diff = Math.round((real - job.est_s) / 60)
    const mins = Math.max(1, Math.round(real / 60))
    return diff === 0 ? `${mins} 分钟，和预计一样` : `${mins} 分钟，比预计${diff < 0 ? '快' : '慢'} ${Math.abs(diff)} 分钟`
  }
  if (job.status === 'failed' || job.status === 'aborted') {
    const pct = Math.floor(job.percent ?? (job.total_lines ? (100 * (job.acked_line ?? 0)) / job.total_lines : 0))
    return `写到 ${pct}%（${formatDuration(real)}）后停止`
  }
  return `预计 ${formatDuration(job.est_s)}`
}
