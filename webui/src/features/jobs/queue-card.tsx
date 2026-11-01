import { Frame, Layers, MoreHorizontal, Play, Trash2, TriangleAlert } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { useRole } from '@/api/collab'
import { useJobActions, useJobs } from '@/api/jobs'
import { isJobActive, useLive } from '@/api/store'
import type { Job } from '@/api/types'
import {
  Badge, Button, Card, CardHeader, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  ErrorState, IconButton, SkeletonList,
} from '@/components/ui'
import { useMachineGate } from '@/features/machine/gate'
import { confirm } from '@/lib/confirm'
import { formatDuration } from '@/lib/format'

export async function confirmStart(job: Job, origin_valid: boolean | undefined) {
  return confirm({
    title: `开始打印「${job.name}」？`,
    description: [
      '请确认：纸张已放好并固定；笔已抬起且位于纸张原点。',
      origin_valid ? '' : '原点现在无效：开始时会把笔当前的位置设为原点（如果机器配置允许）。',
      job.out_of_work_area ? '注意：作品超出机器行程。' : '',
    ]
      .filter(Boolean)
      .join(' '),
    confirmLabel: '开始',
  })
}

function groups(jobs: Job[]) {
  const map = new Map<string, Job[]>()
  for (const j of jobs) {
    const k = j.batch_id ?? `single:${j.id}`
    map.set(k, [...(map.get(k) ?? []), j])
  }
  return [...map.entries()]
    .map(([k, list]) => ({ key: k, batch: k.startsWith('single:') ? null : k, jobs: list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)) }))
    .sort((a, b) => a.jobs[0].created_at - b.jobs[0].created_at)
}

function QueueRow({ job, canStart, inBatch }: { job: Job; canStart: boolean; inBatch: boolean }) {
  const navigate = useNavigate()
  const { start, remove, frame } = useJobActions()
  const originValid = useLive((s) => s.machine?.origin_valid)
  // Admins may still start an out-of-bounds job: the start guard lists the issues and offers 「仍然打印」.
  const admin = useRole() === 'admin'
  return (
    <div className="flex min-h-[var(--row-h)] items-center gap-3 px-4 py-1.5">
      <button type="button" className="focus-ring min-w-0 flex-1 rounded-sm text-left" onClick={() => navigate(`/jobs/${job.id}`)}>
        <span className="block truncate text-body text-label">{inBatch && job.seq ? `第 ${job.seq} 页 · ` : ''}{job.name}</span>
        <span className="flex items-center gap-1.5 truncate text-footnote text-secondary-label tabular-nums">
          {job.total_lines.toLocaleString()} 行 · 约 {formatDuration(job.est_s)}
          {job.out_of_work_area ? (
            <Badge size="sm" tone="orange" icon={TriangleAlert}>超出行程</Badge>
          ) : null}
        </span>
      </button>
      {job.out_of_work_area && !admin ? (
        <Button size="sm" variant="gray" onClick={() => navigate(`/jobs/${job.id}`)}>
          查看原因
        </Button>
      ) : (
        <IconButton
          label="开始"
          variant="tinted"
          disabled={!canStart}
          loading={start.isPending && start.variables?.id === job.id}
          onClick={async () => {
            if (await confirmStart(job, originValid)) start.mutate({ id: job.id })
          }}
        >
          <Play />
        </IconButton>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="更多操作">
            <MoreHorizontal />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem icon={<Frame />} disabled={!canStart || !job.bbox} onSelect={() => frame.mutate(job.id)}>
            走边框（抬笔）
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            icon={<Trash2 />}
            destructive
            onSelect={async () => {
              if (await confirm({ title: `删除「${job.name}」？`, description: '任务将从队列中移除。', confirmLabel: '删除', destructive: true })) remove.mutate(job.id)
            }}
          >
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function QueueCard({ className }: { className?: string }) {
  const q = useJobs({ status: 'queued' })
  const { startNext, removeBatch } = useJobActions()
  const { job, machine } = useLive(useShallow((s) => ({ job: s.job, machine: s.machine })))
  const busy = isJobActive(job)
  const blocked = useMachineGate().leaseBlocked
  const canStart = !busy && !!machine?.connected && !blocked
  const data = q.data ?? []

  return (
    <Card className={className}>
      <CardHeader
        title={`队列${data.length ? `（${data.length}）` : ''}`}
        subtitle={busy ? '当前任务结束后可开始下一个' : !machine?.connected ? '机器未连接' : '任务不会自动开始，换纸后手动开始'}
      />
      {q.isLoading ? (
        <SkeletonList rows={3} className="mx-4 mb-4 shadow-none" />
      ) : q.error ? (
        <ErrorState className="py-6" error={q.error} onRetry={() => q.refetch()} />
      ) : data.length === 0 ? (
        <p className="px-4 pb-5 pt-1 text-subheadline text-secondary-label">队列是空的</p>
      ) : (
        <div className="flex flex-col pb-2">
          {groups(data).map((g) => (
            <div key={g.key} className="hairline-t first:shadow-none">
              {g.batch ? (
                <div className="flex items-center gap-2 px-4 pb-0.5 pt-2.5">
                  <Layers className="size-3.5 text-secondary-label" />
                  <span className="flex-1 text-footnote font-medium text-secondary-label">批量 · 还有 {g.jobs.length} 张</span>
                  <Button size="sm" variant="plain" disabled={!canStart} loading={startNext.isPending} onClick={() => startNext.mutate(g.batch!)}>
                    继续下一张
                  </Button>
                  <IconButton
                    size="sm"
                    label="删除整个批次"
                    onClick={async () => {
                      if (await confirm({ title: '删除整个批次？', description: `将移除 ${g.jobs.length} 个排队中的任务。`, confirmLabel: '删除', destructive: true }))
                        removeBatch.mutate(g.batch!)
                    }}
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              ) : null}
              {g.jobs.map((j) => (
                <QueueRow key={j.id} job={j} canStart={canStart} inBatch={!!g.batch} />
              ))}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
