/**
 * Jobs, batches and job logs (03 §4.6, 04 §5). Pages-agent addition.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from './client'
import { startJobGuarded } from './job-guard'
import { queryClient, qk } from './query'
import type { Job, JobStatus } from './types'
import type { components } from './schema'

export type BatchInfo = components['schemas']['BatchInfo']
export type LogSlice = components['schemas']['LogSlice']

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: '排队中',
  preparing: '准备中',
  running: '进行中',
  paused: '已暂停',
  stopping: '正在停止',
  done: '已完成',
  failed: '失败',
  aborted: '已停止',
}

export type Tone = 'gray' | 'blue' | 'green' | 'orange' | 'red'
export function jobTone(j: Pick<Job, 'status' | 'reason'>): Tone {
  switch (j.status) {
    case 'done':
      return 'green'
    case 'failed':
      return 'red'
    case 'aborted':
      return j.reason === 'estop' || j.reason?.startsWith('alarm') ? 'red' : 'gray'
    case 'paused':
      return 'orange'
    case 'queued':
      return 'gray'
    default:
      return 'blue'
  }
}

export function useJobs(params: { status?: string; batch_id?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: qk.jobs.list(params),
    queryFn: () => api.get<Job[]>('/jobs', { query: { limit: 200, ...params } }),
    select: (d: unknown) => (Array.isArray(d) ? (d as Job[]) : []),
    staleTime: 5_000,
  })
}

export function useJob(id: string | null | undefined) {
  return useQuery({
    queryKey: qk.jobs.detail(id ?? '-'),
    queryFn: () => api.get<Job>(`/jobs/${id}`),
    enabled: !!id,
  })
}

export function useJobLog(id: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: [...qk.jobs.detail(id ?? '-'), 'log'],
    queryFn: () => api.get<LogSlice>(`/jobs/${id}/log`, { query: { limit: 2000 } }),
    enabled: !!id && enabled,
    retry: false,
  })
}


const invalidate = () => queryClient.invalidateQueries({ queryKey: qk.jobs.all })

export function useJobActions() {
  const start = useMutation({
    // pen_unknown / out_of_work_area are handled interactively (./job-guard); null = cancelled
    mutationFn: ({ id, set_zero }: { id: string; set_zero?: boolean }) => startJobGuarded(id, set_zero == null ? {} : { set_zero }),
    meta: { errorTitle: '开始任务失败' },
    onSettled: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/jobs/${id}`),
    meta: { errorTitle: '删除任务失败' },
    onSettled: invalidate,
  })
  const retry = useMutation({
    mutationFn: ({ id, from_line }: { id: string; from_line?: number | null }) => api.post<Job>(`/jobs/${id}/retry`, from_line ? { from_line } : {}),
    meta: { errorTitle: '重新打印失败' },
    onSettled: invalidate,
  })
  const frame = useMutation({
    mutationFn: (id: string) => api.post<Job>(`/jobs/${id}/frame`, { z: 'up' }),
    meta: { errorTitle: '走边框失败' },
  })
  const startNext = useMutation({
    mutationFn: (batchId: string) => api.post<Job>(`/batches/${batchId}/start-next`, {}),
    meta: { errorTitle: '开始下一页失败' },
    onSettled: invalidate,
  })
  const removeBatch = useMutation({
    mutationFn: (batchId: string) => api.delete(`/batches/${batchId}`),
    meta: { errorTitle: '删除批次失败' },
    onSettled: invalidate,
  })
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch<Job>(`/jobs/${id}`, { name }),
    meta: { errorTitle: '重命名失败' },
    onSettled: invalidate,
  })
  return { start, remove, retry, frame, startNext, removeBatch, rename }
}
