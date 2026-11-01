/**
 * Live machine state fed by the WebSocket (src/api/ws.ts). Read it with selectors:
 *
 *   const machine = useLive((s) => s.machine)
 *   const conn = useLive((s) => s.conn)
 *   const { job, progress } = useLive(useShallow((s) => ({ job: s.job, progress: s.progress })))
 *
 * Writers are the `apply*` actions, called only by the WS client (and by HTTP fallbacks such as
 * a `gap` refetch). Features should not mutate it directly; call the REST/WS action and let the
 * server event update the store.
 */
import { create } from 'zustand'
import type {
  Alarm, AlarmEvent, FirmwareError, Job, JobProgress, LogLine, MachineStatus, SystemMetricsEvent, Task, WsHello,
  WsJobEvent, WsTaskEvent,
} from './types'
import { ACTIVE_JOB_STATUSES } from './types'

export type ConnState = 'idle' | 'connecting' | 'open' | 'reconnecting'
export type LinkQuality = 'good' | 'fair' | 'poor' | 'unknown'

export const LOG_CAPACITY = 5000

export interface EstopState {
  at: number
  phase: 'sending' | 'sent' | 'failed'
  via?: 'ws' | 'http'
  error?: string
}

export interface LiveState {
  conn: ConnState
  /** True once a hello was received in this page session. */
  everConnected: boolean
  /** Consecutive failed attempts since the last successful hello. */
  attempts: number
  nextRetryAt: number | null
  rtt: number | null
  quality: LinkQuality
  serverVersion: string | null
  connId: string | null
  lastMessageAt: number | null

  machine: MachineStatus | null
  job: Job | null
  progress: JobProgress | null
  /** The most recently finished job (shown as "已完成 ✓" for 5 s by the mini-player). */
  finished: { job: Job; at: number } | null
  tasks: Record<string, Task>
  /** Active alarm (cleared when GRBL leaves the Alarm state). */
  alarm: Alarm | null
  alarms: Alarm[]
  firmwareErrors: FirmwareError[]
  log: LogLine[]
  logDropped: number
  system: SystemMetricsEvent | null
  estop: EstopState | null

  setConn: (c: Partial<Pick<LiveState, 'conn' | 'attempts' | 'nextRetryAt' | 'rtt' | 'quality' | 'lastMessageAt'>>) => void
  applyHello: (h: WsHello) => void
  applyStatus: (m: MachineStatus) => void
  applyProgress: (p: JobProgress) => void
  applyJobEvent: (e: WsJobEvent) => void
  setCurrentJob: (j: Job | null) => void
  applyTask: (t: WsTaskEvent) => void
  applyAlarm: (a: AlarmEvent | Alarm) => void
  clearAlarm: () => void
  applyFirmwareError: (e: FirmwareError) => void
  appendLog: (lines: LogLine[], dropped?: number) => void
  clearLog: () => void
  applySystem: (s: SystemMetricsEvent) => void
  setEstop: (e: EstopState | null) => void
  clearFinished: () => void
}

export function isJobActive(j: Job | null | undefined): boolean {
  return !!j && ACTIVE_JOB_STATUSES.includes(j.status)
}

function progressFromJob(j: Job | null): JobProgress | null {
  if (!j || !j.total_lines) return null
  return {
    job_id: j.id,
    line_acked: j.acked_line,
    line_sent: j.sent_line ?? j.acked_line,
    total: j.total_lines,
    percent: j.percent ?? (100 * j.acked_line) / j.total_lines,
    elapsed_s: j.elapsed_s ?? 0,
    eta_s: j.eta_s ?? null,
  }
}

export function qualityFromRtt(rtt: number | null): LinkQuality {
  if (rtt == null) return 'unknown'
  if (rtt < 150) return 'good'
  if (rtt < 500) return 'fair'
  return 'poor'
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (!same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  return true
}

/**
 * Structural sharing for status frames: unchanged fields (wpos, ov, pins, last_alarm…) keep their
 * old references and an otherwise identical frame (only `updated_at` moved) keeps the old object,
 * so `useLive((s) => s.machine)` / `s.machine?.wpos` subscribers don't re-render 4×/s for nothing.
 */
function shareStatus(prev: MachineStatus | null, m: MachineStatus): MachineStatus {
  if (!prev) return m
  let changed = false
  const out: Record<string, unknown> = {}
  const p = prev as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(m)) {
    if (same(p[k], v)) out[k] = p[k]
    else {
      out[k] = v
      if (k !== 'updated_at') changed = true
    }
  }
  if (!changed && Object.keys(p).length === Object.keys(out).length) return prev
  return out as unknown as MachineStatus
}

export const useLive = create<LiveState>((set, get) => ({
  conn: 'idle',
  everConnected: false,
  attempts: 0,
  nextRetryAt: null,
  rtt: null,
  quality: 'unknown',
  serverVersion: null,
  connId: null,
  lastMessageAt: null,
  machine: null,
  job: null,
  progress: null,
  finished: null,
  tasks: {},
  alarm: null,
  alarms: [],
  firmwareErrors: [],
  log: [],
  logDropped: 0,
  system: null,
  estop: null,

  setConn: (c) => set(c),

  applyHello: (h) => {
    const tasks: Record<string, Task> = {}
    for (const t of h.snapshot?.tasks ?? []) tasks[t.id] = t
    const machine = h.snapshot?.machine ?? null
    const job = h.snapshot?.job ?? null
    set({
      everConnected: true,
      attempts: 0,
      nextRetryAt: null,
      serverVersion: h.server_version,
      connId: h.conn_id,
      machine,
      job: isJobActive(job) || job?.status === 'queued' ? job : null,
      progress: progressFromJob(job),
      tasks,
      alarm: machine?.grbl_state?.startsWith('Alarm') ? (machine.last_alarm ?? get().alarm) : null,
    })
  },

  applyStatus: (m) => {
    const { alarm, machine: prev } = get()
    const machine = shareStatus(prev, m)
    const nextAlarm = m.grbl_state?.startsWith('Alarm') ? (alarm ?? m.last_alarm ?? null) : null
    if (machine === prev && nextAlarm === alarm) return
    set({ machine, alarm: nextAlarm })
  },

  applyProgress: (p) => {
    const job = get().job
    set({
      progress: p,
      job:
        job && job.id === p.job_id
          ? { ...job, acked_line: p.line_acked, sent_line: p.line_sent, percent: p.percent, eta_s: p.eta_s, elapsed_s: p.elapsed_s }
          : job,
    })
  },

  applyJobEvent: (e) => {
    const cur = get().job
    const job = e.job
    if (!job) {
      if (cur?.id === e.job_id) set({ job: null, progress: null })
      return
    }
    if (isJobActive(job)) {
      set({ job, progress: cur?.id === job.id ? get().progress : progressFromJob(job) })
    } else if (cur?.id === job.id) {
      set({ job: null, progress: null, finished: { job, at: Date.now() } })
    } else if (['done', 'failed', 'aborted'].includes(job.status)) {
      set({ finished: { job, at: Date.now() } })
    }
  },

  setCurrentJob: (j) => set({ job: j, progress: progressFromJob(j) }),

  applyTask: (t) => {
    const tasks = { ...get().tasks }
    const prev = tasks[t.task_id]
    tasks[t.task_id] = {
      ...prev,
      id: t.task_id,
      kind: t.kind,
      state: t.state as Task['state'],
      progress: t.progress,
      message: t.message,
      result: t.result,
      error: (t.error as Task['error']) ?? null,
      created_at: prev?.created_at ?? Date.now() / 1000,
    }
    // keep finished tasks for a while so UIs can read results, cap at 100 entries
    const ids = Object.keys(tasks)
    if (ids.length > 100) for (const id of ids.slice(0, ids.length - 100)) delete tasks[id]
    set({ tasks })
  },

  applyAlarm: (a) => {
    const alarm: Alarm = { ...a, ts: 'ts' in a && a.ts ? a.ts : Date.now() / 1000 }
    set({ alarm, alarms: [alarm, ...get().alarms].slice(0, 20) })
  },
  clearAlarm: () => set({ alarm: null }),

  applyFirmwareError: (e) => set({ firmwareErrors: [e, ...get().firmwareErrors].slice(0, 50) }),

  appendLog: (lines, dropped = 0) => {
    if (!lines.length && !dropped) return
    const log = get().log
    const next = log.length + lines.length > LOG_CAPACITY ? [...log, ...lines].slice(-LOG_CAPACITY) : log.concat(lines)
    set({ log: next, logDropped: get().logDropped + dropped })
  },
  clearLog: () => set({ log: [], logDropped: 0 }),

  applySystem: (s) => set({ system: { ...get().system, ...s } }),
  setEstop: (estop) => set({ estop }),
  clearFinished: () => set({ finished: null }),
}))
