/**
 * Machine/job actions shared by the shell and pages. Each prefers the already-open WebSocket
 * (no new TCP handshake over flaky WiFi) and falls back to REST.
 */
import { toast } from '@/lib/toast'
import { api, errorMessage } from './client'
import { queryClient, qk } from './query'
import { useLive } from './store'
import type { Job, MachineStatus } from './types'
import { ws } from './ws'

async function wsOrHttp(op: Parameters<typeof ws.cmd>[0], args: Record<string, unknown>, http: () => Promise<unknown>, timeoutMs = 3000) {
  if (ws.isOpen) {
    try {
      await ws.cmd(op, args, { timeoutMs })
      return 'ws' as const
    } catch (e) {
      // A rejection from the server (ok:false) is final; transport problems fall back to HTTP.
      if ((e as { code?: string }).code !== 'timeout' && (e as { code?: string }).code !== 'disconnected') throw e
    }
  }
  await http()
  return 'http' as const
}

let estopInFlight = false

/**
 * E-STOP (02-ux §2.4, 03 §2.4): single call, no confirmation. WS first (1.5 s), then HTTP with
 * retries. Never throws; result is reflected in `useLive().estop`.
 */
export async function estop(): Promise<boolean> {
  const live = useLive.getState()
  if (estopInFlight) return false
  estopInFlight = true
  live.setEstop({ at: Date.now(), phase: 'sending' })
  try {
    if (ws.isOpen) {
      try {
        await ws.cmd('estop', {}, { timeoutMs: 1500 })
        useLive.getState().setEstop({ at: Date.now(), phase: 'sent', via: 'ws' })
        return true
      } catch {
        /* fall through to HTTP */
      }
    }
    let lastErr: unknown
    for (let i = 0; i < 3; i++) {
      try {
        await api.post('/machine/estop', {}, { timeoutMs: 4000, skipAuthHandling: true })
        useLive.getState().setEstop({ at: Date.now(), phase: 'sent', via: 'http' })
        return true
      } catch (e) {
        lastErr = e
        await new Promise((r) => setTimeout(r, 300 * (i + 1)))
      }
    }
    useLive.getState().setEstop({ at: Date.now(), phase: 'failed', error: errorMessage(lastErr) })
    return false
  } finally {
    estopInFlight = false
  }
}

export function pauseJob(job: Pick<Job, 'id'>, mode: 'soft' | 'hold' = 'soft') {
  return wsOrHttp('pause', { mode }, () => api.post(`/jobs/${job.id}/pause`, { mode }))
}
export function resumeJob(job: Pick<Job, 'id'>) {
  return wsOrHttp('resume', {}, () => api.post(`/jobs/${job.id}/resume`, {}))
}
export function stopJob(job: Pick<Job, 'id'>) {
  return wsOrHttp('stop', {}, () => api.post(`/jobs/${job.id}/stop`, {}))
}

export async function connectMachine(body: { port?: string; baud?: number } = {}) {
  const s = await api.post<MachineStatus>('/machine/connect', body)
  if (s && typeof s === 'object') useLive.getState().applyStatus(s)
  return s
}
export async function disconnectMachine() {
  await api.post('/machine/disconnect', {})
}
export async function unlockMachine() {
  await api.post('/machine/unlock', {})
}
/** Release a feed hold no job/teletype owns (soft reset; position kept). 409 job_active / teletype_active. */
export async function clearHold() {
  await api.post('/machine/clear-hold', {})
}
export async function penUp() {
  return wsOrHttp('pen', { state: 'up' }, () => api.post('/machine/pen', { state: 'up' }))
}

/** Re-sync the live store via REST (after a WS `gap`, or while the socket is down). */
export async function refreshLive() {
  const live = useLive.getState()
  try {
    const [status, job] = await Promise.all([
      api.get<MachineStatus>('/machine/status', { timeoutMs: 6000 }),
      api.get<Job | undefined>('/jobs/current', { timeoutMs: 6000 }),
    ])
    if (status) live.applyStatus(status)
    live.setCurrentJob(job ?? null)
    queryClient.invalidateQueries({ queryKey: qk.jobs.all })
  } catch (e) {
    console.warn('[live] refresh failed', e)
  }
}

/** Run an action, toasting failures with a title. Returns true on success. */
export async function runAction(title: string, fn: () => Promise<unknown>, success?: string): Promise<boolean> {
  try {
    await fn()
    if (success) toast.success(success)
    return true
  } catch (e) {
    toast.error(title, { description: errorMessage(e), key: title })
    return false
  }
}
