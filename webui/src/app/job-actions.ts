import { pauseJob, resumeJob, runAction, stopJob } from '@/api/machine'
import type { Job } from '@/api/types'
import { confirm } from '@/lib/confirm'

/** Stop with the standard confirmation (02-ux §3.8). Cancel has default focus. */
export async function confirmStopJob(job: Pick<Job, 'id'>) {
  const ok = await confirm({
    title: '停止当前任务？',
    description: '笔将抬起并回到原点。',
    confirmLabel: '停止',
    destructive: true,
  })
  if (ok) await runAction('停止任务失败', () => stopJob(job))
  return ok
}

export function togglePause(job: Pick<Job, 'id' | 'status'>) {
  if (job.status === 'paused') return runAction('继续任务失败', () => resumeJob(job))
  if (job.status === 'running') return runAction('暂停任务失败', () => pauseJob(job))
  return Promise.resolve(false)
}
