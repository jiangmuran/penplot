/**
 * WebSocket client for `/api/v1/ws` (03 §5). A single instance, `ws`, is started by the shell.
 *
 *   // raw event listener (any server message type)
 *   useWsEvent('log', (p) => …)                    // or: const off = ws.on('error', (p) => …)
 *   // opt in to a topic that is not in the default set (e.g. 'log'); ref-counted
 *   useWsTopics(['log'])
 *   // command with ack (rejects on timeout / not connected / ok:false)
 *   await ws.cmd('pause', { mode: 'soft' })
 *
 * Every message is `{type, seq, ts, ...payload}` (a `data` envelope is also accepted). On each
 * `hello` the live store (src/api/store.ts) is reset from the snapshot. Reconnects with backoff
 * 0.5 → 1 → 2 → 5 s (then every 5 s), immediately on `online` / tab becoming visible. Client
 * pings every 10 s to measure RTT; 45 s of silence forces a reconnect.
 */
import { useEffect, useRef } from 'react'
import { uid } from '@/lib/id'
import { API_BASE } from './client'
import { reportLinkOk } from './net'
import { qualityFromRtt, useLive } from './store'
import type { WsAck, WsCmdOp, WsServerEvents, WsServerType, WsTopic } from './types'

const BACKOFF = [500, 1000, 2000, 5000]
const PING_EVERY = 10_000
const SILENCE_LIMIT = 45_000
// Same as the server's default set (everything except `log`); our `subscribe` replaces it, so list all.
export const DEFAULT_TOPICS: WsTopic[] = [
  'status', 'progress', 'job', 'alarm', 'task', 'system', 'error', 'notice', 'presence', 'lease', 'project', 'locks', 'teletype',
]

type Handler<T extends WsServerType> = (payload: WsServerEvents[T], raw: Record<string, unknown>) => void
type AnyHandler = (payload: unknown, raw: Record<string, unknown>) => void

export class WsCommandError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'WsCommandError'
    this.code = code
  }
}

class PenplotSocket {
  private sock: WebSocket | null = null
  private started = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private listeners = new Map<string, Set<AnyHandler>>()
  private pending = new Map<string, { resolve: (a: WsAck) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private topicRefs = new Map<WsTopic, number>()
  private failedHandshakes = 0
  /** Called when the server rejects the socket in a way that suggests auth (shell re-checks /auth/state). */
  onAuthProblem: ((code: number) => void) | null = null
  /** Called after a `gap` message (shell refetches /jobs/current and /machine/status). */
  onGap: (() => void) | null = null

  get url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}${API_BASE}/ws`
  }

  get isOpen(): boolean {
    return this.sock?.readyState === WebSocket.OPEN && useLive.getState().conn === 'open'
  }

  start() {
    if (this.started) return
    this.started = true
    window.addEventListener('online', this.kick)
    document.addEventListener('visibilitychange', this.onVisible)
    this.connect()
  }

  stop() {
    this.started = false
    window.removeEventListener('online', this.kick)
    document.removeEventListener('visibilitychange', this.onVisible)
    this.clearTimers()
    const s = this.sock
    this.sock = null
    s?.close(1000, 'client stop')
    useLive.getState().setConn({ conn: 'idle', nextRetryAt: null })
  }

  /** Reconnect now (e.g. after login). */
  restart() {
    this.stop()
    this.start()
  }

  private kick = () => {
    if (!this.started) return
    if (!this.sock || this.sock.readyState === WebSocket.CLOSED || this.sock.readyState === WebSocket.CLOSING) {
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.connect()
    }
  }

  private onVisible = () => {
    if (document.visibilityState === 'visible') this.kick()
  }

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.retryTimer = null
    this.pingTimer = null
  }

  private connect() {
    const live = useLive.getState()
    live.setConn({ conn: live.everConnected || live.attempts > 0 ? 'reconnecting' : 'connecting', nextRetryAt: null })
    let s: WebSocket
    try {
      s = new WebSocket(this.url, ['penplot.v1'])
    } catch {
      this.scheduleRetry()
      return
    }
    this.sock = s
    let opened = false
    s.onopen = () => {
      opened = true
      this.failedHandshakes = 0
      useLive.getState().setConn({ lastMessageAt: Date.now() })
      this.sendSubscribe()
      this.ping()
      this.pingTimer = setInterval(() => this.heartbeat(), PING_EVERY)
    }
    s.onmessage = (ev) => this.onMessage(ev)
    s.onclose = (ev) => {
      if (this.sock !== s) return
      this.sock = null
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = null
      this.failPending('连接已断开')
      if (!opened) this.failedHandshakes++
      // 4401 unauthenticated, 4423 setup required (04 §11); repeated failed handshakes may also be auth.
      if (ev.code === 4401 || ev.code === 4423 || ev.code === 1008 || this.failedHandshakes === 2) this.onAuthProblem?.(ev.code)
      if (this.started) this.scheduleRetry()
    }
    s.onerror = () => {
      /* onclose follows */
    }
  }

  private scheduleRetry() {
    const live = useLive.getState()
    const attempts = live.attempts + 1
    const delay = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)]
    live.setConn({ conn: 'reconnecting', attempts, nextRetryAt: Date.now() + delay, rtt: null, quality: 'unknown' })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.started) this.connect()
    }, delay)
  }

  private heartbeat() {
    const last = useLive.getState().lastMessageAt ?? 0
    if (Date.now() - last > SILENCE_LIMIT) {
      this.sock?.close(4000, 'silence')
      return
    }
    this.ping()
  }

  private ping() {
    this.sendRaw({ type: 'ping', t: performance.now() })
  }

  /** Send an arbitrary client message (e.g. studio `presence`). Returns false when not connected. */
  send(msg: object): boolean {
    return this.sendRaw(msg)
  }

  private sendRaw(msg: object): boolean {
    if (this.sock?.readyState !== WebSocket.OPEN) return false
    this.sock.send(JSON.stringify(msg))
    return true
  }

  private topics(): WsTopic[] {
    const set = new Set<WsTopic>(DEFAULT_TOPICS)
    for (const [t, n] of this.topicRefs) if (n > 0) set.add(t)
    return [...set]
  }

  private sendSubscribe() {
    this.sendRaw({ type: 'subscribe', topics: this.topics() })
  }

  /** Ref-counted extra topics (e.g. 'log'). Returns a release function. */
  subscribe(topics: WsTopic[]): () => void {
    for (const t of topics) this.topicRefs.set(t, (this.topicRefs.get(t) ?? 0) + 1)
    this.sendSubscribe()
    return () => {
      for (const t of topics) this.topicRefs.set(t, Math.max(0, (this.topicRefs.get(t) ?? 1) - 1))
      this.sendSubscribe()
    }
  }

  on<T extends WsServerType>(type: T, h: Handler<T>): () => void
  on(type: '*', h: AnyHandler): () => void
  on(type: string, h: AnyHandler): () => void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(h)
    return () => set!.delete(h)
  }

  private emit(type: string, payload: unknown, raw: Record<string, unknown>) {
    for (const key of [type, '*']) {
      const set = this.listeners.get(key)
      if (!set) continue
      for (const h of set) {
        try {
          h(payload, raw)
        } catch (e) {
          console.error('[ws] listener error', type, e)
        }
      }
    }
  }

  private onMessage(ev: MessageEvent) {
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
    } catch {
      return
    }
    const type = String(raw.type ?? '')
    const keys = Object.keys(raw)
    const payload: unknown =
      raw.data && typeof raw.data === 'object' && keys.every((k) => ['type', 'seq', 'ts', 'data'].includes(k)) ? raw.data : raw
    const live = useLive.getState()
    live.setConn({ lastMessageAt: Date.now() })
    const p = payload as never
    switch (type) {
      case 'hello':
        reportLinkOk() // the socket is up, so the link is too
        live.applyHello(p)
        live.setConn({ conn: 'open', attempts: 0, nextRetryAt: null })
        break
      case 'status':
        live.applyStatus(p)
        break
      case 'progress':
        live.applyProgress(p)
        break
      case 'job':
        live.applyJobEvent(p)
        break
      case 'alarm':
        live.applyAlarm(p)
        break
      case 'error':
        live.applyFirmwareError(p)
        break
      case 'log': {
        const l = payload as WsServerEvents['log']
        live.appendLog(l.lines ?? [], l.dropped ?? 0)
        break
      }
      case 'gap':
        this.onGap?.()
        break
      case 'task':
        live.applyTask(p)
        break
      case 'system':
        live.applySystem(p)
        break
      case 'ping':
        this.sendRaw({ type: 'pong', t: (payload as { t?: number }).t ?? Date.now() })
        break
      case 'pong': {
        const t = (payload as { t?: number }).t
        if (typeof t === 'number' && t <= performance.now()) {
          const rtt = Math.round(performance.now() - t)
          const prev = live.rtt
          const smooth = prev == null ? rtt : Math.round(prev * 0.6 + rtt * 0.4)
          live.setConn({ rtt: smooth, quality: qualityFromRtt(smooth) })
        }
        break
      }
      case 'ack': {
        const a = payload as WsAck
        const pend = this.pending.get(a.id)
        if (pend) {
          clearTimeout(pend.timer)
          this.pending.delete(a.id)
          if (a.ok) pend.resolve(a)
          else {
            const err = (a.error ?? {}) as { code?: string; message?: string }
            pend.reject(new WsCommandError(err.code ?? 'error', err.message ?? '命令被拒绝'))
          }
        }
        break
      }
    }
    this.emit(type, payload, raw)
  }

  private failPending(msg: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new WsCommandError('disconnected', msg))
      this.pending.delete(id)
    }
  }

  /** Send a command and wait for its ack. */
  cmd(op: WsCmdOp, args: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<WsAck> {
    return this.request({ type: 'cmd', op, args }, opts)
  }

  /** Send any client message that the server acks by `id` (e.g. `{type:'tt_keys', data}`) and wait for the ack. */
  request(msg: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<WsAck> {
    const id = uid('c')
    return new Promise<WsAck>((resolve, reject) => {
      if (!this.isOpen) {
        reject(new WsCommandError('disconnected', '与设备的连接已断开'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new WsCommandError('timeout', '设备无应答'))
      }, opts.timeoutMs ?? 4000)
      this.pending.set(id, { resolve, reject, timer })
      this.sendRaw({ ...msg, id })
    })
  }
}

export const ws = new PenplotSocket()

/** Listen to a server message type for the component's lifetime. */
export function useWsEvent<T extends WsServerType>(type: T, handler: Handler<T>) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => ws.on(type, (p, r) => ref.current(p, r)), [type])
}

/** Subscribe to extra topics (e.g. ['log']) while mounted. */
export function useWsTopics(topics: WsTopic[]) {
  const key = topics.join(',')
  useEffect(() => ws.subscribe(key.split(',') as WsTopic[]), [key])
}
