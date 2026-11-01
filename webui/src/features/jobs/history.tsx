import { Download, FolderOpen, History, MoreHorizontal, RotateCcw, Trash2 } from 'lucide-react'
import * as React from 'react'
import { create } from 'zustand'
import { useNavigate } from 'react-router-dom'
import { downloadFrom } from '@/api/download'
import { useJobActions, useJobs } from '@/api/jobs'
import { runAction } from '@/features/machine/errors'
import type { Job } from '@/api/types'
import { TERMINAL_JOB_STATUSES } from '@/api/types'
import {
  Card, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, ErrorState,
  IconButton, SearchField, Segmented, SkeletonList,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { toast } from '@/lib/toast'
import { JobStatusBadge, formatDateTime, jobDuration, jobOutcome, sourceInfo } from './shared'

type Filter = 'all' | 'done' | 'failed' | 'aborted'

/** History rows hidden while their delete is still undoable (02-ux §2.6: toast「撤销」instead of a confirm). */
export const usePendingDeletes = create<{ ids: string[] }>(() => ({ ids: [] }))
function deferDelete(job: Job, commit: () => void) {
  usePendingDeletes.setState((s) => ({ ids: [...s.ids, job.id] }))
  const drop = () => usePendingDeletes.setState((s) => ({ ids: s.ids.filter((x) => x !== job.id) }))
  const timer = setTimeout(() => {
    commit()
    setTimeout(drop, 2000)
  }, 5000)
  toast({
    title: `已删除「${job.name}」`,
    duration: 5000,
    action: {
      label: '撤销',
      onClick: () => {
        clearTimeout(timer)
        drop()
      },
    },
  })
}

export function JobMenu({ job, onDeleted }: { job: Job; onDeleted?: () => void }) {
  const navigate = useNavigate()
  const { retry, remove } = useJobActions()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="更多操作" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem
          icon={<RotateCcw />}
          onSelect={() =>
            retry.mutate(
              { id: job.id },
              { onSuccess: (j) => toast.success('已加入队列', { description: j?.name, action: { label: '查看', onClick: () => navigate(`/jobs/${j.id}`) } }) },
            )
          }
        >
          重新打印
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Download />} onSelect={() => runAction('下载失败', () => downloadFrom(`/jobs/${job.id}/gcode`, `${job.name}.gcode`))}>
          下载 G 代码
        </DropdownMenuItem>
        {job.source?.project_id ? (
          <DropdownMenuItem icon={<FolderOpen />} onSelect={() => navigate(`/studio/${job.source.project_id}`)}>
            打开项目
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={<Trash2 />}
          destructive
          onSelect={() => {
            onDeleted?.()
            deferDelete(job, () => remove.mutate(job.id))
          }}
        >
          删除记录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function HistorySection({ compact }: { compact?: boolean }) {
  const navigate = useNavigate()
  const q = useJobs()
  const [filter, setFilter] = React.useState<Filter>('all')
  const [search, setSearch] = React.useState('')
  const pending = usePendingDeletes((s) => s.ids)
  const rows = React.useMemo(() => {
    const s = search.trim().toLowerCase()
    return (q.data ?? [])
      .filter((j) => TERMINAL_JOB_STATUSES.includes(j.status) && !pending.includes(j.id))
      .filter((j) => filter === 'all' || j.status === filter)
      .filter((j) => !s || j.name.toLowerCase().includes(s) || j.id.includes(s))
      .sort((a, b) => (b.finished_at ?? b.created_at) - (a.finished_at ?? a.created_at))
  }, [q.data, filter, search, pending])

  return (
    <section className="flex flex-col gap-3" aria-labelledby="jobs-history">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="jobs-history" className="mr-auto text-title3 text-label">
          历史
        </h2>
        <Segmented<Filter>
          size="sm"
          aria-label="按结果筛选"
          value={filter}
          onValueChange={setFilter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'done', label: '完成' },
            { value: 'failed', label: '失败' },
            { value: 'aborted', label: '已停止' },
          ]}
        />
        <SearchField value={search} onValueChange={setSearch} placeholder="搜索任务" className={cn(compact ? 'w-full' : 'w-52')} />
      </div>
      {q.isLoading ? (
        <SkeletonList rows={5} />
      ) : q.error ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={History}
            title={search || filter !== 'all' ? '没有符合条件的任务' : '还没有任务记录'}
            description={search || filter !== 'all' ? '换个筛选条件试试。' : '打印完成、停止或失败的任务会记录在这里。'}
          />
        </Card>
      ) : compact ? (
        <Card className="overflow-hidden">
          {rows.map((j) => (
            <div
              key={j.id}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/jobs/${j.id}`)}
              onKeyDown={(e) => e.key === 'Enter' && navigate(`/jobs/${j.id}`)}
              className="focus-ring flex min-h-14 items-center gap-3 px-4 py-2 active:bg-tertiary-fill [&+&]:hairline-t"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-body text-label">{j.name}</div>
                <div className="truncate text-footnote text-secondary-label tabular-nums">
                  {formatDateTime(j.started_at ?? j.created_at)} · {formatDuration(jobDuration(j))}
                </div>
              </div>
              <JobStatusBadge job={j} />
              <JobMenu job={j} />
            </div>
          ))}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full table-fixed text-left">
            <thead className="hairline-b text-footnote text-secondary-label">
              <tr>
                <th className="w-[34%] px-4 py-2 font-medium">名称</th>
                <th className="w-[16%] px-2 py-2 font-medium">来源</th>
                <th className="w-[15%] px-2 py-2 font-medium">开始</th>
                <th className="w-[10%] py-2 pl-2 pr-6 text-right font-medium">用时</th>
                <th className="w-[17%] px-2 py-2 font-medium">结果</th>
                <th className="w-12 px-2 py-2"><span className="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((j) => {
                const src = sourceInfo(j)
                const Icon = src.icon
                return (
                  <tr
                    key={j.id}
                    onClick={() => navigate(`/jobs/${j.id}`)}
                    className="cursor-default text-body hover:bg-quaternary-fill [&+&]:hairline-t"
                  >
                    <td className="px-4 py-2">
                      <button type="button" className="focus-ring block w-full truncate rounded-sm text-left text-label" onClick={() => navigate(`/jobs/${j.id}`)}>
                        {j.name}
                      </button>
                      {j.errors?.length ? <span className="text-footnote text-red">{j.errors.length} 个固件错误</span> : null}
                    </td>
                    <td className="truncate px-2 py-2 text-subheadline text-secondary-label">
                      <span className="inline-flex items-center gap-1.5">
                        <Icon className="size-3.5 shrink-0" />
                        {src.label}
                      </span>
                    </td>
                    <td className="truncate px-2 py-2 text-subheadline text-secondary-label tabular-nums">{formatDateTime(j.started_at ?? j.created_at)}</td>
                    <td className="py-2 pl-2 pr-6 text-right text-subheadline text-secondary-label tabular-nums">{formatDuration(jobDuration(j))}</td>
                    <td className="px-2 py-2" title={jobOutcome(j)}>
                      <JobStatusBadge job={j} />
                    </td>
                    <td className="px-2 py-1 text-right">
                      <JobMenu job={j} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  )
}
