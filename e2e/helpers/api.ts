import { expect, request, type APIRequestContext, type APIResponse } from '@playwright/test'
import { API, BASE_URL, PASSWORD } from './env'

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, msg: string) {
    super(msg)
  }
  get code(): string | undefined {
    return (this.body as { error?: { code?: string } })?.error?.code
  }
}

export interface Job {
  id: string
  name: string
  status: 'queued' | 'preparing' | 'running' | 'paused' | 'stopping' | 'done' | 'failed' | 'aborted'
  reason: string | null
  percent: number
  acked_line: number
  total_lines: number
  errors: { line: number; cmd: string; reply: string }[]
  can_retry_from: number | null
}
export interface MachineStatus {
  connected: boolean
  connecting: boolean
  grbl_state: string
  wpos: number[] | null
  pen: 'up' | 'down' | 'unknown'
  origin_valid: boolean
  busy: boolean
  job_id: string | null
  last_alarm: { code: number; text: string; hint: string } | null
}

export const TERMINAL = ['done', 'failed', 'aborted'] as const
export const ACTIVE = ['queued', 'preparing', 'running', 'paused', 'stopping'] as const

/** Thin REST client for arranging state and verifying side effects (cookie session or bearer). */
export class Api {
  private constructor(public ctx: APIRequestContext) {}

  static async session(password = PASSWORD, base = BASE_URL, username?: string) {
    const ctx = await request.newContext({ baseURL: base, extraHTTPHeaders: { 'X-Penplot': '1', Origin: base } })
    const api = new Api(ctx)
    await api.post('/auth/login', username ? { username, password } : { password })
    return api
  }

  static async bearer(token: string, base = BASE_URL) {
    return new Api(await request.newContext({ baseURL: base, extraHTTPHeaders: { Authorization: `Bearer ${token}` } }))
  }

  static async anonymous(base = BASE_URL) {
    return new Api(await request.newContext({ baseURL: base, extraHTTPHeaders: { 'X-Penplot': '1', Origin: base } }))
  }

  async dispose() {
    await this.ctx.dispose()
  }

  private async parse<T>(r: APIResponse, what: string): Promise<T> {
    const text = await r.text()
    const body = text ? JSON.parse(text) : null
    if (!r.ok()) throw new ApiError(r.status(), body, `${what} -> ${r.status()} ${text.slice(0, 300)}`)
    return body as T
  }

  async raw(method: string, path: string, data?: unknown) {
    return this.ctx.fetch(API + path, { method, data: data as never, timeout: 30_000 })
  }
  async get<T = unknown>(path: string) {
    return this.parse<T>(await this.ctx.get(API + path, { timeout: 30_000 }), `GET ${path}`)
  }
  async post<T = unknown>(path: string, data: unknown = {}) {
    return this.parse<T>(await this.ctx.post(API + path, { data: data as never, timeout: 30_000 }), `POST ${path}`)
  }
  async patch<T = unknown>(path: string, data: unknown) {
    return this.parse<T>(await this.ctx.patch(API + path, { data: data as never, timeout: 30_000 }), `PATCH ${path}`)
  }
  async del<T = unknown>(path: string) {
    return this.parse<T>(await this.ctx.delete(API + path, { timeout: 30_000 }), `DELETE ${path}`)
  }

  // ---------- library / jobs ----------
  async importGcode(name: string, text: string): Promise<string> {
    const r = await this.ctx.post(API + '/import/gcode', {
      multipart: { file: { name, mimeType: 'text/plain', buffer: Buffer.from(text) } },
      timeout: 30_000,
    })
    const body = await this.parse<{ file: { id: string } }>(r, 'import gcode')
    return body.file.id
  }

  async createJob(fileId: string, name: string, start: boolean) {
    return this.post<Job>('/jobs', { source: { file_id: fileId }, name, start })
  }

  job(id: string) {
    return this.get<Job>(`/jobs/${id}`)
  }

  async currentJob(): Promise<Job | null> {
    const r = await this.ctx.get(API + '/jobs/current')
    if (r.status() === 204) return null
    const t = await r.text()
    return t ? (JSON.parse(t) as Job) : null
  }

  async waitJob(id: string, statuses: readonly string[], timeout = 45_000) {
    await expect
      .poll(async () => (await this.job(id)).status, { timeout, message: `job ${id} -> ${statuses.join('|')}` })
      .toMatch(new RegExp(`^(${statuses.join('|')})$`))
    return this.job(id)
  }

  machine() {
    return this.get<MachineStatus>('/machine/status')
  }

  /**
   * Bring the simulated plotter back to a usable baseline: no active job, not in alarm,
   * connected, Idle. Tests that drive the machine call this first (state is shared).
   */
  async resetMachine() {
    const cur = await this.currentJob()
    if (cur && (ACTIVE as readonly string[]).includes(cur.status)) {
      if (cur.status === 'queued') await this.del(`/jobs/${cur.id}`).catch(() => null)
      else {
        await this.post(`/jobs/${cur.id}/stop`).catch(() => null)
        try {
          await this.waitJob(cur.id, TERMINAL, 20_000)
        } catch {
          await this.post('/machine/estop').catch(() => null)
          await this.waitJob(cur.id, TERMINAL, 20_000)
        }
      }
    }
    // queued leftovers would make the jobs page show "开始「…」" instead of the empty state
    const queued = await this.get<Job[]>('/jobs?status=queued').catch(() => [] as Job[])
    for (const j of queued) await this.del(`/jobs/${j.id}`).catch(() => null)
    let m = await this.machine()
    if (!m.connected && !m.connecting) {
      await this.post('/machine/connect', {}).catch(() => null)
    }
    await expect.poll(async () => (await this.machine()).connected, { timeout: 20_000, message: 'machine connected' }).toBe(true)
    m = await this.machine()
    if (m.grbl_state.startsWith('Alarm')) await this.post('/machine/unlock')
    await expect
      .poll(async () => (await this.machine()).grbl_state, { timeout: 20_000, message: 'machine idle' })
      .toBe('Idle')
    // jobs are refused with 409 pen_unknown / origin_invalid until the pen is up and XYZ zeroed
    m = await this.machine()
    if (!m.origin_valid || m.pen === 'unknown') await this.zeroHere()
  }

  /** Pen up + zero XYZ so `origin_valid` is true. */
  async zeroHere() {
    await this.post('/machine/pen', { state: 'up' })
    await this.post('/machine/zero', { axes: 'xyz' })
  }
}
