/**
 * Fetch client for `/api/v1`.
 *
 *   const fonts = await api.get<Font[]>('/fonts', { query: { q: '行书' } })
 *   await api.post('/machine/zero', { axes: 'xy' }, { idempotencyKey: true })
 *   await api.post('/fonts', formData)            // FormData/Blob bodies are sent as-is
 *
 * - `credentials: 'include'` (cookie session), `X-Penplot: 1` on unsafe methods (CSRF, 03 §6).
 * - Errors become `ApiError` (status, code, message, detail). Network failures → status 0, code 'network'.
 * - 401 → `onUnauthorized` handler (shell: session-expired sheet or redirect to /login).
 *   423 `setup_required` → `onSetupRequired` (redirect to /setup). Opt out with `skipAuthHandling`.
 */
import { uid } from '@/lib/id'
import { describeErrorText } from './errors'
import { reportLinkDown, reportLinkOk } from './net'
import type { ApiErrorBody } from './types'

export const API_BASE = '/api/v1'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail: unknown
  readonly headers?: Headers
  constructor(status: number, code: string, message: string, detail?: unknown, headers?: Headers) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
    this.headers = headers
  }
  get isNetwork() {
    return this.status === 0
  }
  /**
   * Link down: no response at all, or a proxy/gateway error (502/504, and a 503 without our JSON error body —
   * a backend 503 carries a code like `machine_disconnected` and is a real answer).
   */
  get isOffline() {
    return this.status === 0 || this.status === 502 || this.status === 504 || (this.status === 503 && this.code === 'http_503')
  }
  /** Seconds to wait, from Retry-After or detail.retry_after (429 / lockout). */
  get retryAfter(): number | null {
    const h = this.headers?.get('Retry-After')
    if (h && !Number.isNaN(Number(h))) return Number(h)
    const d = this.detail as { retry_after_s?: number; retry_after?: number } | null
    const v = d?.retry_after_s ?? d?.retry_after
    return typeof v === 'number' ? v : null
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError
}

const STATUS_MESSAGES: Record<number, string> = {
  0: '无法连接到设备',
  400: '请求无效',
  401: '登录已过期，请重新登录',
  403: '没有权限执行此操作',
  404: '未找到',
  409: '当前状态不允许此操作',
  413: '文件过大',
  422: '参数校验失败',
  423: '需要先完成初始设置',
  429: '操作过于频繁，请稍后再试',
  500: '服务器内部错误',
  501: '此功能尚不可用',
  502: '连接中断',
  503: '机器未连接',
  504: '设备响应超时',
  507: '存储空间不足',
}

/** Human message for any error (ApiError or otherwise). See describeError() in './errors'. */
export function errorMessage(e: unknown): string {
  return describeErrorText(e)
}

type Handlers = {
  onUnauthorized: (err: ApiError) => void
  onSetupRequired: (err: ApiError) => void
}
const handlers: Handlers = {
  onUnauthorized: () => {
    if (!location.pathname.startsWith('/login')) {
      const next = encodeURIComponent(location.pathname + location.search)
      location.assign(`/login?next=${next}`)
    }
  },
  onSetupRequired: () => {
    if (!location.pathname.startsWith('/setup')) location.assign('/setup')
  },
}
export function setAuthHandlers(h: Partial<Handlers>) {
  Object.assign(handlers, h)
}

export type Query = Record<string, string | number | boolean | null | undefined | (string | number)[]>

export interface RequestOptions extends Omit<RequestInit, 'body' | 'method'> {
  method?: string
  body?: unknown
  query?: Query
  /** Adds `Idempotency-Key` (true → random). For non-idempotent control calls (jog, command, zero). */
  idempotencyKey?: string | boolean
  /** Return the raw Response (downloads, SVG, binary). */
  raw?: boolean
  /** Don't trigger the global 401/423 handlers. */
  skipAuthHandling?: boolean
  /** Abort after this many ms (default 30 s; 0 = none). */
  timeoutMs?: number
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function buildUrl(path: string, query?: Query): string {
  const url = path.startsWith('http') || path.startsWith(API_BASE) ? path : `${API_BASE}${path.startsWith('/') ? '' : '/'}${path}`
  if (!query) return url
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v == null) continue
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)))
    else sp.set(k, String(v))
  }
  const qs = sp.toString()
  return qs ? `${url}?${qs}` : url
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { body, query, idempotencyKey, raw, skipAuthHandling, timeoutMs = 30_000, headers: h, signal, ...init } = opts
  const method = (opts.method ?? (body !== undefined ? 'POST' : 'GET')).toUpperCase()
  const headers = new Headers(h)
  headers.set('Accept', headers.get('Accept') ?? 'application/json')
  if (UNSAFE.has(method)) headers.set('X-Penplot', '1')
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey === true ? uid('idem-') : idempotencyKey)

  let payload: BodyInit | undefined
  if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer || body instanceof URLSearchParams || typeof body === 'string') {
    payload = body as BodyInit
  } else if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
    payload = JSON.stringify(body)
  }

  const ctrl = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs) : null
  const onAbort = () => ctrl.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort)

  let res: Response
  try {
    res = await fetch(buildUrl(path, query), {
      ...init,
      method,
      headers,
      body: payload,
      credentials: 'include',
      signal: ctrl.signal,
    })
  } catch (e) {
    if (signal?.aborted) throw e
    const timeout = (e as DOMException)?.name === 'TimeoutError' || ctrl.signal.reason?.name === 'TimeoutError'
    reportLinkDown()
    throw new ApiError(0, timeout ? 'timeout' : 'network', timeout ? '请求超时，请检查网络' : STATUS_MESSAGES[0], e)
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  if (!res.ok) {
    let code = `http_${res.status}`
    let message = STATUS_MESSAGES[res.status] ?? '操作没有完成'
    let detail: unknown
    const ct = res.headers.get('Content-Type') ?? ''
    if (ct.includes('json')) {
      try {
        const j = (await res.json()) as Partial<ApiErrorBody> & { detail?: unknown }
        if (j.error) {
          code = j.error.code || code
          message = j.error.message || message
          detail = j.error.detail
        } else if (j.detail !== undefined) {
          detail = j.detail // FastAPI default shape
        }
      } catch {
        /* ignore */
      }
    }
    const err = new ApiError(res.status, code, message, detail, res.headers)
    if (err.isOffline) reportLinkDown()
    else reportLinkOk()
    if (!skipAuthHandling) {
      const isAuthCall = path.includes('/auth/')
      if (res.status === 401 && !isAuthCall) handlers.onUnauthorized(err)
      if (res.status === 423) handlers.onSetupRequired(err)
    }
    throw err
  }

  reportLinkOk()
  if (raw) return res as unknown as T
  if (res.status === 204 || res.headers.get('Content-Length') === '0') return undefined as T
  const ct = res.headers.get('Content-Type') ?? ''
  if (ct.includes('json')) return (await res.json()) as T
  return (await res.text()) as unknown as T
}

type Opts = Omit<RequestOptions, 'body' | 'method'>
export const api = {
  request,
  get: <T = unknown>(path: string, o?: Opts) => request<T>(path, { ...o, method: 'GET' }),
  delete: <T = unknown>(path: string, o?: Opts) => request<T>(path, { ...o, method: 'DELETE' }),
  post: <T = unknown>(path: string, body?: unknown, o?: Opts) => request<T>(path, { ...o, method: 'POST', body: body ?? {} }),
  put: <T = unknown>(path: string, body?: unknown, o?: Opts) => request<T>(path, { ...o, method: 'PUT', body }),
  patch: <T = unknown>(path: string, body?: unknown, o?: Opts) => request<T>(path, { ...o, method: 'PATCH', body }),
  url: buildUrl,
}
