/**
 * Side effects of live events: toasts for job transitions/notices, query invalidation, REST
 * re-sync after `gap`, auth re-check when the socket is rejected, browser notifications.
 */
import { useQueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { refreshLive } from '@/api/machine'
import { qk } from '@/api/query'
import { ws } from '@/api/ws'
import { toast } from '@/lib/toast'

const REASON: Record<string, string> = {
  user_stop: '已手动停止',
  estop: '已急停',
  gcode_error: 'G 代码错误',
  serial_lost: '串口连接丢失',
  process_crash: '服务异常退出',
  shutdown: '服务关闭',
  alarm_locked: '机器处于报警锁定',
  not_connected: '机器未连接',
  prepare_failed: '准备失败',
}
export function reasonText(r?: string | null) {
  if (!r) return ''
  if (r.startsWith('alarm:')) return `报警 ${r.slice(6)}`
  return REASON[r] ?? r
}

export function LiveEffects() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  React.useEffect(() => {
    ws.onGap = () => void refreshLive()
    ws.onAuthProblem = (code) => {
      if (code === 4423) navigate('/setup')
      else void qc.invalidateQueries({ queryKey: qk.auth.state })
    }
    let first = true
    const offs = [
      ws.on('hello', () => {
        // After a reconnect, REST caches may be stale.
        if (!first) void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
        // the auth gate fetched /auth/state moments ago on page load: only re-check when it is not fresh
        const fresh = first && Date.now() - (qc.getQueryState(qk.auth.state)?.dataUpdatedAt ?? 0) < 15_000
        first = false
        if (!fresh) void qc.invalidateQueries({ queryKey: qk.auth.state })
      }),
      ws.on('job', (e) => {
        void qc.invalidateQueries({ queryKey: qk.jobs.all })
        const job = e.job
        if (!job || e.from === e.to) return
        // Sound / notifications / change-paper banner: see ./attention.tsx
        if (e.to === 'done' && !job.batch_id) {
          toast.success('任务已完成', { description: job.name, key: `job:${job.id}` })
        } else if (e.to === 'failed') {
          toast.error('任务失败', { description: `${job.name}${job.reason ? ` · ${reasonText(job.reason)}` : ''}`, key: `job:${job.id}` })
        } else if (e.to === 'aborted' && job.reason !== 'estop') {
          toast.info('任务已停止', { description: job.name, key: `job:${job.id}` })
        }
      }),
      ws.on('notice', (n) => {
        if (n.code === 'lease_taken') return // announced by the lease toast (./attention.tsx)
        const level = n.level === 'error' ? 'error' : n.level === 'warning' ? 'warning' : 'info'
        toast({ title: n.message, level, key: `notice:${n.code}` })
      }),
      ws.on('task', (t) => {
        if (t.state === 'done' || t.state === 'failed') void qc.invalidateQueries({ queryKey: qk.tasks.detail(t.task_id) })
      }),
    ]
    return () => {
      offs.forEach((o) => o())
      ws.onGap = null
      ws.onAuthProblem = null
    }
  }, [qc, navigate])
  return null
}
