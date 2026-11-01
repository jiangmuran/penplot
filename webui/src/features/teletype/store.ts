/**
 * Live teletype state: REST snapshot (GET /teletype/state) + WS `teletype` events (see '@/api/teletype').
 * The typing echo is not stored in React state; it goes to listeners.
 *
 * Sync rules (status-display fixes):
 * - WS `hello` carries `snapshot.teletype` (same shape as GET /state) and is the first message of a stream, so it
 *   is applied directly: no REST round-trip racing with the events that follow it.
 * - A REST load (page mount, `gap`, unknown session) buffers the events that arrive meanwhile and replays them
 *   on top of the snapshot, so an `ack` that lands during the fetch does not leave a char stuck as "queued".
 * - `gap` (server dropped events for this client) → full reload.
 * - Pen / machine state, queue and paused come from `state.pen` too, not only from `pen` events (which are sent
 *   on change only, so a reconnecting client used to show "—" until something moved).
 */
import { create } from 'zustand'
import {
  DEFAULT_FORM, geometryFor, teletypeApi, isTeletypeUnavailable,
  type CharTuple, type PaperSnapshot, type TeletypeCfg, type TeletypeEvent, type TeletypeFontInfo, type TeletypeMode,
  type TeletypePen, type TeletypeState,
} from '@/api/teletype'
import { ws } from '@/api/ws'

export interface Char {
  id: number
  ch: string
  row: number
  col: number
  st: 'q' | 'ok'
  /** grid cells (CJK = 2) */
  w: number
  /** glyph key into `glyphs` */
  gk: string
}

export type Availability = 'loading' | 'ready' | 'unavailable' | 'error'

export interface PenInfo {
  /** pen in paper mm: x right, y DOWN (machine Y is negative downward) */
  x: number
  y: number
  z: number
}

type PaperMeta = Omit<PaperSnapshot, 'chars' | 'glyphs' | 'font' | 'missing'>

interface TT {
  availability: Availability
  error: unknown
  /** a session exists on the server */
  active: boolean
  sessionId: string | null
  owner: TeletypeState['owner']
  terminalEnabled: boolean
  mode: TeletypeMode
  cfg: TeletypeCfg | null
  paper: PaperMeta
  chars: Map<number, Char>
  /** glyph key → SVG path d (cell-local mm), for the current page */
  glyphs: Map<string, string>
  /** bumps on every char change so selectors re-render cheaply */
  rev: number
  /** G-code lines queued or in flight */
  pending: number
  /** chars sent to the controller and not acknowledged yet */
  queued: number
  /** chars acknowledged, whole session */
  written: number
  paused: boolean
  originOk: boolean
  pen: PenInfo | null
  /** raw GRBL state ('Idle', 'Run', 'Hold:0', 'Alarm' …) */
  machineState: string
  machineConnected: boolean
  needPaperMessage: string | null
  font: TeletypeFontInfo | null
  nextFont: TeletypeFontInfo | null
  missing: string[]
  log: { t: number; msg: string }[]
  /** ack timestamps for the chars/s rate */
  acks: number[]
  /** last time any teletype data arrived (ms) */
  syncedAt: number
}

const idlePaper = (): PaperMeta => ({
  page: 1, geo: geometryFor({ ...DEFAULT_FORM }), row: 0, col: 0, need_paper: false,
})

const IDLE = {
  active: false, sessionId: null, owner: null, mode: 'type' as TeletypeMode, cfg: null,
  pending: 0, queued: 0, written: 0, paused: false, originOk: true, pen: null, machineState: '', machineConnected: true,
  needPaperMessage: null, font: null, nextFont: null, missing: [] as string[],
}

export const useTeletype = create<TT>(() => ({
  availability: 'loading',
  error: null,
  terminalEnabled: false,
  ...IDLE,
  paper: idlePaper(),
  chars: new Map(),
  glyphs: new Map(),
  rev: 0,
  log: [],
  acks: [],
  syncedAt: 0,
}))

type OutListener = (data: string, reset?: boolean) => void
const outListeners = new Set<OutListener>()
let typedLog = ''
/** Typing echo (`typed` events); the backlog from the last snapshot is replayed on subscribe. */
export function onTeletypeTyped(l: OutListener) {
  outListeners.add(l)
  if (typedLog) l(typedLog, true)
  return () => {
    outListeners.delete(l)
  }
}

function toChar([id, ch, row, col, st, w, gk]: CharTuple): Char {
  return { id, ch, row, col, st, w: w ?? 1, gk: gk ?? `m1:${ch}` }
}

function addLog(msg: string) {
  useTeletype.setState((s) => ({ log: [...s.log.slice(-199), { t: Date.now() / 1000, msg }] }))
}
export { addLog as teletypeLog }

function penFrom(p: TeletypePen) {
  return {
    pending: p.pending ?? 0,
    ...(p.queued != null ? { queued: p.queued } : {}),
    paused: !!p.paused,
    machineState: p.state ?? '',
    machineConnected: p.connected !== false,
    pen: p.pos ? { x: p.pos[0], y: -p.pos[1], z: p.pos[2] } : null,
  }
}

function applyPaper(p: PaperSnapshot) {
  const { chars, glyphs, font, missing, ...paper } = p
  const m = new Map<number, Char>()
  for (const t of chars ?? []) m.set(t[0], toChar(t))
  useTeletype.setState((s) => ({
    paper: { ...paper, overflow: paper.overflow ?? 0 },
    chars: m,
    glyphs: new Map(Object.entries(glyphs ?? {})),
    rev: s.rev + 1,
    ...(font ? { font } : {}),
    ...(missing ? { missing } : {}),
    ...(paper.queued != null ? { queued: paper.queued } : {}),
    ...(paper.written != null ? { written: paper.written } : {}),
    // a fresh sheet: the "page full" message is history
    ...(!paper.need_paper ? { needPaperMessage: null } : {}),
  }))
}

/** Full or brief state (brief = no paper / typed_log). */
function applyState(st: TeletypeState) {
  if (!st.active) {
    useTeletype.setState((s) => ({
      ...IDLE, terminalEnabled: !!st.terminal_enabled, paper: idlePaper(), chars: new Map(), glyphs: new Map(),
      rev: s.rev + 1, syncedAt: Date.now(),
    }))
    typedLog = ''
    for (const l of outListeners) l('', true)
    return
  }
  useTeletype.setState((s) => ({
    active: true,
    sessionId: st.session_id ?? null,
    owner: st.owner ?? null,
    terminalEnabled: !!st.terminal_enabled,
    mode: st.mode ?? 'type',
    cfg: st.cfg ?? s.cfg,
    pending: st.pending ?? 0,
    queued: st.queued ?? s.queued,
    written: st.written ?? s.written,
    paused: !!st.paused,
    originOk: st.origin_ok !== false,
    font: st.font ?? s.font,
    nextFont: st.next_font ?? null,
    missing: st.missing ?? s.missing,
    needPaperMessage: st.need_paper ? s.needPaperMessage : null,
    paper: {
      ...s.paper,
      need_paper: !!st.need_paper,
      page: st.page ?? s.paper.page,
      row: st.row ?? s.paper.row,
      col: st.col ?? s.paper.col,
    },
    ...(st.pen ? penFrom(st.pen) : {}),
    syncedAt: Date.now(),
  }))
  if (st.paper) applyPaper(st.paper)
  if (st.typed_log != null) {
    typedLog = st.typed_log
    for (const l of outListeners) l(typedLog, true)
  }
}

let loading: TeletypeEvent[] | null = null

export async function loadTeletype() {
  if (loading) return
  loading = []
  try {
    const st = await teletypeApi.state()
    useTeletype.setState({ availability: 'ready', error: null })
    const buffered = loading
    loading = null
    applyState(st)
    // events that raced the fetch: replaying is idempotent (chars add-if-missing, acks set ok, …)
    for (const e of buffered) handleTeletypeEvent(e)
  } catch (e) {
    loading = null
    if (isTeletypeUnavailable(e)) useTeletype.setState({ availability: 'unavailable', error: null })
    // keep the page as it is on a transient failure once loaded
    else if (useTeletype.getState().availability !== 'ready') useTeletype.setState({ availability: 'error', error: e })
  }
}

/** Apply a server state returned by a REST call (session start / action / newpage). */
export function applyTeletypeState(st: TeletypeState) {
  applyState(st)
}

export function handleTeletypeEvent(e: TeletypeEvent) {
  if (loading) {
    loading.push(e)
    return
  }
  const set = useTeletype.setState
  const cur = useTeletype.getState()
  // events of another session (or one we have not seen yet) → resync
  if (e.session_id && e.session_id !== cur.sessionId && e.kind !== 'snapshot' && e.kind !== 'closed') {
    void loadTeletype()
    return
  }
  set({ syncedAt: Date.now() })
  switch (e.kind) {
    case 'snapshot':
      if (e.state) applyState(e.state)
      else if (e.paper) applyPaper(e.paper)
      break
    case 'state':
      applyState(e.state)
      break
    case 'chars':
      if (!cur.active) {
        void loadTeletype()
        break
      }
      set((s) => {
        const chars = new Map(s.chars)
        for (const t of e.list) if (!chars.has(t[0])) chars.set(t[0], toChar(t))
        let glyphs = s.glyphs
        if (e.glyphs) {
          glyphs = new Map(s.glyphs)
          for (const [k, d] of Object.entries(e.glyphs)) glyphs.set(k, d)
        }
        return { chars, glyphs, rev: s.rev + 1, queued: s.queued + e.list.length }
      })
      break
    case 'ack': {
      const ids = e.ids ?? (e.id != null ? [e.id] : [])
      set((s) => {
        const chars = new Map(s.chars)
        let n = 0
        for (const id of ids) {
          const c = chars.get(id)
          if (c && c.st !== 'ok') {
            chars.set(id, { ...c, st: 'ok' })
            n++
          }
        }
        const now = performance.now()
        return {
          chars,
          rev: s.rev + 1,
          queued: e.queued ?? Math.max(0, s.queued - ids.length),
          written: s.written + ids.length,
          acks: [...s.acks.filter((t) => now - t < 5000), ...Array<number>(n).fill(now)],
        }
      })
      break
    }
    case 'dropped':
      if (e.ids?.length) addLog(`${e.ids.length} 个字未写出，已丢弃`)
      set((s) => {
        const chars = new Map(s.chars)
        for (const id of e.ids ?? []) chars.delete(id)
        return { chars, rev: s.rev + 1, queued: 0 }
      })
      break
    case 'cursor':
      set((s) => ({ paper: { ...s.paper, row: e.row, col: e.col }, ...(e.queued != null ? { queued: e.queued } : {}) }))
      break
    case 'need_paper':
      set((s) => ({ paper: { ...s.paper, need_paper: e.on, page: e.page ?? s.paper.page }, needPaperMessage: e.on ? e.message ?? null : null }))
      if (e.on) addLog(e.message || `第 ${e.page ?? ''} 页写满，等待换纸`)
      break
    case 'mode':
      set({ mode: e.mode })
      break
    case 'cols':
      set((s) => ({ paper: { ...s.paper, geo: { ...s.paper.geo, cols: e.cols } } }))
      break
    case 'pen':
      set(penFrom(e))
      break
    case 'missing':
      set((s) => ({ missing: [...s.missing, ...e.chars.filter((c) => !s.missing.includes(c))] }))
      addLog(`字体里没有「${e.chars.join('')}」，已画成方框`)
      break
    case 'typed':
      typedLog = (typedLog + e.data).slice(-20_000)
      for (const l of outListeners) l(e.data)
      break
    case 'error':
      addLog(`控制器报错：${e.reply}（${e.cmd}）`)
      break
    case 'halted':
      set({ originOk: e.origin_ok !== false, paused: false })
      addLog(e.origin_ok === false ? '已停止：原点失效，请抬笔并重新设为原点' : '已停止，未写出的字已丢弃')
      break
    case 'closed':
      if (e.session_id && cur.sessionId && e.session_id !== cur.sessionId) break
      addLog(e.reason === 'serial_lost' ? '串口断开，会话已结束' : '会话已结束')
      applyState({ active: false, terminal_enabled: cur.terminalEnabled, pending: 0, paused: false, need_paper: false, origin_ok: true, pty_running: false })
      break
  }
}

let wired = false
/** Attach the WS listeners once (module lifetime). */
export function wireTeletype() {
  if (wired) return
  wired = true
  ws.on('teletype' as never, (p: unknown) => {
    const ev = p as TeletypeEvent | TeletypeEvent[]
    if (Array.isArray(ev)) ev.forEach(handleTeletypeEvent)
    else if (ev && typeof ev === 'object' && 'kind' in ev) handleTeletypeEvent(ev)
  })
  // a (re)connect starts with a snapshot of the session: apply it directly (same shape as GET /state)
  ws.on('hello', (p: unknown) => {
    const snap = (p as { snapshot?: { teletype?: TeletypeState | null } } | null)?.snapshot
    const s = useTeletype.getState()
    if (s.availability !== 'ready') return
    if (snap && 'teletype' in snap) {
      if (snap.teletype) applyState(snap.teletype)
      else if (s.active) applyState({ active: false, terminal_enabled: s.terminalEnabled, pending: 0, paused: false, need_paper: false, origin_ok: true, pty_running: false })
    } else void loadTeletype()
  })
  // the server dropped events for us: the page model may be wrong now
  ws.on('gap', () => {
    if (useTeletype.getState().availability === 'ready') void loadTeletype()
  })
}
