/**
 * 电传打字机 (teletype) client — 04-contract-notes §16, penplot/web/routers/teletype.py.
 *
 *   GET    /teletype/state             → TeletypeState ({active:false, terminal_enabled} when no session)
 *   GET    /teletype/font              → {glyphs, fallback} (built-in mono font, grid units; unused by the UI)
 *   POST   /teletype/preview           {text?, font_id?, char_h?, letter_spacing?, line_spacing?, paper_w?, paper_h?, margin?}
 *                                      → TeletypePreview (unset fields: the session's settings, else defaults)
 *   POST   /teletype/session           TeletypeSessionCreate → TeletypeState (201; holds the machine like a job;
 *                                      the current pen position becomes the paper top-left when set_zero)
 *   DELETE /teletype/session           unsent text dropped, pen up, back to origin
 *   POST   /teletype/type {text}       typing mode ('\n'/'\r' newline, '\b'/'\x7f' back one char (a CJK char = 2 cells), '\t');
 *                                      the server keeps full-width punctuation when the font has it
 *                                      → {ok, echo}; page full → 409 need_paper
 *   POST   /teletype/newpage           a fresh sheet is in place
 *   POST   /teletype/action {action, args}  pause|resume|stop|change_paper|set_origin|home|pen_up|mode|interrupt|settings
 *   WS     /teletype/pty               terminal mode (admin + settings.teletype.terminal_enabled)
 *   WS     main socket: topic `teletype` (TeletypeEvent), client message `tt_keys {id, data}` (acked)
 *
 * Teletype events (data.kind): snapshot{state|paper} · chars{list,glyphs} · ack{ids,id,queued} (batched) · dropped{ids} ·
 * cursor{row,col,queued} · need_paper{on,page,message} · typed{data} · mode{mode} · missing{chars,font} ·
 * pen{pos:[x,y,z],pending,queued,state,paused,connected} · state{state} · cols{cols} · error{cmd,reply} ·
 * halted{reason,origin_ok} · closed{reason?}
 * GET /teletype/state (and the WS hello `snapshot.teletype`) carries every field these events update.
 */
import { api, isApiError } from './client'
import type { components } from './schema'
import { ws } from './ws'

type S = components['schemas']
export type TeletypeMode = 'type' | 'term'
export type TeletypeSessionCreate = S['TeletypeSessionCreate']
export type TeletypeActionName = S['TeletypeAction']['action']

/** Session config as the server reports it in `state.cfg`. */
export interface TeletypeCfg {
  char_h: number
  cell_w: number
  line_h: number
  paper_w: number
  paper_h: number
  margin: number
  feed: number
  z_down: number
  z_up: number
  z_speed: number
  max_backlog: number
  font_id?: string
  letter_spacing?: number | null
  line_spacing?: number | null
}

export interface PaperGeo {
  h: number
  cw: number
  lh: number
  cols: number
  rows: number
  margin: number
  paper_w: number
  paper_h: number
}

export interface TeletypeFontInfo {
  id: string
  name: string
  cjk: boolean
}

/**
 * [id, ch, row, col, state, w, gk] — state 'q' queued, 'ok' acknowledged by the controller; w = grid cells
 * (CJK / full-width = 2); gk = key into the `glyphs` map (SVG path d in cell-local mm, x right / y down).
 */
export type CharTuple = [number, string, number, number, 'q' | 'ok', number?, string?]

export interface PaperSnapshot {
  page: number
  geo: PaperGeo
  row: number
  col: number
  chars: CharTuple[]
  glyphs?: Record<string, string>
  need_paper: boolean
  overflow?: number
  queued?: number
  skipped?: number
  written?: number
  font?: TeletypeFontInfo
  missing?: string[]
}

/** Live machine view of the session (WS `pen` event == state.pen). pos = work mm, Y negative downward. */
export interface TeletypePen {
  pos: [number, number, number] | null
  pending: number
  queued?: number
  state: string
  paused: boolean
  connected?: boolean
}

/** S['TeletypeState'] with the free-form dicts typed. */
export type TeletypeState = Omit<S['TeletypeState'], 'cfg' | 'paper' | 'owner' | 'font' | 'next_font' | 'pen' | 'missing' | 'queued' | 'written' | 'row' | 'col'> & {
  cfg?: TeletypeCfg | null
  paper?: PaperSnapshot | null
  owner?: { id?: string; username?: string; display_name?: string | null } | null
  font?: TeletypeFontInfo | null
  next_font?: TeletypeFontInfo | null
  pen?: TeletypePen | null
  missing?: string[]
  queued?: number
  written?: number
  row?: number | null
  col?: number | null
}

export type TeletypeEvent = { session_id?: string | null } & (
  | { kind: 'snapshot'; state?: TeletypeState; paper?: PaperSnapshot }
  | { kind: 'chars'; list: CharTuple[]; glyphs?: Record<string, string> }
  | { kind: 'ack'; id?: number; ids?: number[]; queued?: number }
  | { kind: 'dropped'; ids: number[] }
  | { kind: 'cursor'; row: number; col: number; queued?: number }
  | { kind: 'need_paper'; on: boolean; page?: number; message?: string }
  | { kind: 'typed'; data: string }
  | { kind: 'mode'; mode: TeletypeMode }
  | ({ kind: 'pen' } & TeletypePen)
  | { kind: 'missing'; chars: string[]; font?: string }
  | { kind: 'state'; state: TeletypeState }
  | { kind: 'cols'; cols: number }
  | { kind: 'error'; cmd: string; reply: string }
  | { kind: 'halted'; reason: string; origin_ok: boolean }
  | { kind: 'closed'; reason?: string }
)

/** POST /teletype/preview result: sample text laid out exactly as the pen would write it. */
export interface TeletypePreview {
  geo: PaperGeo
  chars: CharTuple[]
  glyphs: Record<string, string>
  missing: string[]
  font: TeletypeFontInfo
}

/** Built-in monospace ASCII font id (default; terminal mode always writes with it). */
export const MONO_FONT = 'mono'

/** Defaults for a new session (server defaults: char_h 3, feed 4000, margin 8, max_backlog 1500, font mono). */
export interface SessionForm {
  char_h: number
  feed: number
  margin: number
  paper_w: number
  paper_h: number
  z_up: number | null
  max_backlog: number
  set_zero: boolean
  font_id: string
  /** mm per half-width cell; null = auto (≈ 0.13 × char_h) */
  letter_spacing: number | null
  /** × char_h; null = font default (mono 1.6, library fonts 1.45) */
  line_spacing: number | null
}
export const DEFAULT_FORM: SessionForm = {
  char_h: 3, feed: 4000, margin: 8, paper_w: 210, paper_h: 297, z_up: null, max_backlog: 1500, set_zero: true,
  font_id: MONO_FONT, letter_spacing: null, line_spacing: null,
}

/** Session create body (superset of the generated schema: font / spacing fields). */
export type SessionCreateBody = Partial<TeletypeSessionCreate> & {
  font_id?: string
  letter_spacing?: number | null
  line_spacing?: number | null
}

/**
 * Fallback grid for the mono font (same arithmetic as penplot/web/teletype/paper.py `geometry()`); library fonts
 * get their geometry from POST /teletype/preview.
 */
export function geometryFor(c: { char_h: number; paper_w: number; paper_h: number; margin: number; letter_spacing?: number | null; line_spacing?: number | null }): PaperGeo {
  const h = c.char_h
  const gap = c.letter_spacing ?? h * (0.8 - 4 / 6)
  const cw = Math.max(0.3, (h * 4) / 6 + gap)
  const lh = Math.max(h * 0.8, h * (c.line_spacing || 1.6))
  return {
    h, cw, lh, margin: c.margin, paper_w: c.paper_w, paper_h: c.paper_h,
    cols: Math.max(10, Math.floor((c.paper_w - 2 * c.margin) / cw)),
    rows: Math.max(1, Math.floor((c.paper_h - 2 * c.margin - h) / lh) + 1),
  }
}

export function isTeletypeUnavailable(e: unknown) {
  return isApiError(e) && (e.status === 404 || e.status === 405 || e.status === 501)
}

export const teletypeApi = {
  state: () => api.get<TeletypeState>('/teletype/state', { timeoutMs: 8000 }),
  preview: (body: Record<string, unknown>, signal?: AbortSignal) =>
    api.post<TeletypePreview>('/teletype/preview', body, { signal, timeoutMs: 30_000 }),
  start: (body: SessionCreateBody) =>
    api.post<TeletypeState>('/teletype/session', body, { idempotencyKey: true, timeoutMs: 30_000 }),
  end: () => api.delete<TeletypeState>('/teletype/session', { timeoutMs: 60_000 }),
  type: (text: string) => api.post<{ ok: boolean; echo: string }>('/teletype/type', { text }),
  newpage: () => api.post<TeletypeState>('/teletype/newpage', {}),
  action: (action: TeletypeActionName, args: Record<string, unknown> = {}) =>
    api.post<TeletypeState>('/teletype/action', { action, args }, { timeoutMs: 30_000 }),
}

/**
 * Ordered keystroke sender: batches keys, one request in flight, strictly in order.
 * WS `tt_keys` (acked) when the socket is open, REST `/teletype/type` otherwise. A WS message that
 * was sent but not acked is NOT resent over REST (that could type the text twice).
 */
export function orderedSender(onError: (e: unknown) => void) {
  let buf = ''
  let busy = false
  const flush = async () => {
    if (busy || !buf) return
    busy = true
    const data = buf
    buf = ''
    try {
      if (ws.isOpen) await ws.request({ type: 'tt_keys', data }, { timeoutMs: 5000 })
      else await teletypeApi.type(data)
    } catch (e) {
      onError(e)
    } finally {
      busy = false
      void flush()
    }
  }
  return (d: string) => {
    buf += d
    void flush()
  }
}
