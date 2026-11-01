/**
 * Background task helpers (03 §2.7, 04 §1 "Long work"). Pages-agent addition.
 *
 *   const task = useTask(taskId)          // live via WS `task`, falls back to polling GET /tasks/{id}
 *   await cancelTask(taskId)              // DELETE /tasks/{id}
 *   const r = await waitForTask<RenderResult>(taskId)
 */
import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import { qk } from './query'
import { useLive } from './store'
import type { Task, TaskRef } from './types'

export function isTaskFinished(t: Pick<Task, 'state'> | null | undefined) {
  return !!t && (t.state === 'done' || t.state === 'failed' || t.state === 'cancelled')
}

/** True when a response is a `202 {task_id}` reference rather than a final result. */
export function isTaskRef(x: unknown): x is TaskRef {
  return !!x && typeof x === 'object' && 'task_id' in x && typeof (x as TaskRef).task_id === 'string'
}

/** Watch one task. Live store first; polls REST every 1.5 s while unfinished (covers WS gaps). */
export function useTask(taskId: string | null | undefined): Task | null {
  const live = useLive((s) => (taskId ? s.tasks[taskId] : undefined))
  const q = useQuery({
    queryKey: qk.tasks.detail(taskId ?? '-'),
    queryFn: () => api.get<Task>(`/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (query) => (isTaskFinished(query.state.data) || isTaskFinished(live) ? false : 1500),
    staleTime: 0,
  })
  if (!taskId) return null
  const rest = q.data ?? null
  if (live && rest) {
    // prefer whichever is further along
    if (isTaskFinished(rest) && !isTaskFinished(live)) return rest
    return { ...rest, ...live, created_at: rest.created_at, result: live.result ?? rest.result }
  }
  return live ?? rest
}

/** All tasks of a kind that are still running (live store). */

export function cancelTask(taskId: string) {
  return api.delete<Task>(`/tasks/${taskId}`)
}

/** Resolve when the task finishes (polling). Rejects on failure/cancel. */
export async function waitForTask<T = unknown>(taskId: string, { intervalMs = 1000, timeoutMs = 10 * 60_000 } = {}): Promise<T> {
  const start = Date.now()
  for (;;) {
    const live = useLive.getState().tasks[taskId]
    const t = live && isTaskFinished(live) ? live : await api.get<Task>(`/tasks/${taskId}`)
    if (t.state === 'done') return (t.result ?? null) as T
    if (t.state === 'failed') throw new Error(t.error?.message ?? '任务失败')
    if (t.state === 'cancelled') throw new Error('任务已取消')
    if (Date.now() - start > timeoutMs) throw new Error('任务超时')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
