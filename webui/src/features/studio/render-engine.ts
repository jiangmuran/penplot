/**
 * Preview rendering.
 *
 * 1. Element-local paths: every element is rendered by the backend at an identity transform (one scratch page
 *    per element, batched into one request) and cached by `elementKey` (type + props — transform excluded, like
 *    the server's own element cache, 03 §3.3). The canvas applies the transform itself, so dragging, rotating
 *    and resizing are instant and never re-render.
 * 2. Page render: the real document (debounced; a running render always finishes, the newest doc waits; identical
 *    content is not re-rendered) for stats, warnings,
 *    out-of-work-area checks, pen order / travel overlays, and as the source for print & export.
 */
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { errorMessage, isApiError } from '@/api/client'
import {
  fetchPaths, renderProject, type Element, type PaperRef, type Polylines, type ProjectDoc, type RenderResult,
} from '@/api/studio'
import { uid } from '@/lib/id'
import { onLinkRestored } from '@/api/net'
import { cacheGetMany, cachePutMany } from './el-cache'
import { polylinesBBox, polylinesToD } from './geometry'
import { IDENTITY } from './model'

export const CLIENT_ID = uid('ui').slice(0, 10)

export interface ElRender {
  status: 'pending' | 'ok' | 'error'
  d?: string
  bbox?: [number, number, number, number] | null
  /** flow_text: one entry per laid-out page (page 0 = host page). */
  pages?: { d: string; bbox: [number, number, number, number] | null }[]
  strokes?: number
  missing?: string[]
  overflow?: boolean
  error?: string
  code?: string
  at: number
  /** restored from the IndexedDB cache; a server render is on its way */
  cached?: boolean
  /** 0..1 while a slow (202 task) render runs */
  progress?: number
}

export interface PageRenderState {
  status: 'idle' | 'running' | 'ok' | 'error'
  result: RenderResult | null
  error: string | null
  version: number
  at: number
}

interface RenderStore {
  els: Record<string, ElRender>
  page: PageRenderState
  set: (key: string, r: ElRender) => void
  setMany: (m: Record<string, ElRender>) => void
  setPage: (p: Partial<PageRenderState>) => void
}

export const useRender = create<RenderStore>((set, get) => ({
  els: {},
  page: { status: 'idle', result: null, error: null, version: 0, at: 0 },
  set: (key, r) => set({ els: { ...get().els, [key]: r } }),
  setMany: (m) => {
    const els = { ...get().els, ...m }
    const keys = Object.keys(els)
    if (keys.length > 400) {
      keys.sort((a, b) => els[a].at - els[b].at)
      for (const k of keys.slice(0, keys.length - 300)) delete els[k]
    }
    set({ els })
  },
  setPage: (p) => set({ page: { ...get().page, ...p } }),
}))

// ------------------------------------------------------------------ element scheduler

export interface RenderItem {
  key: string
  el: Element
  paper: PaperRef
}

const queue = new Map<string, RenderItem>()
let wanted = new Set<string>()
let lastItems: RenderItem[] = []
const attempts = new Map<string, number>()
let retryTimer: ReturnType<typeof setTimeout> | null = null
let inflight = false
let timer: ReturnType<typeof setTimeout> | null = null
let projectId: string | null = null
let vars: Record<string, string> = {}

const SCRATCH_PRINT = { optimize: false, copies: 1, simplify: 0, multi_page: 'separate_jobs' as const }

export function requestElements(pid: string, items: RenderItem[], variables: Record<string, string>) {
  projectId = pid
  vars = variables
  lastItems = items
  wanted = new Set(items.map((i) => i.key))
  const els = useRender.getState().els
  let added = false
  const fresh: string[] = []
  for (const it of items) {
    const cur = els[it.key]
    if (cur && (cur.status !== 'error' || Date.now() - cur.at < 15_000)) continue
    if (!cur) fresh.push(it.key)
    if (!queue.has(it.key)) {
      queue.set(it.key, it)
      added = true
    }
  }
  if (added) schedule(160)
  // show the last known paths (IndexedDB) right away; the server render replaces them
  if (fresh.length) {
    void cacheGetMany(fresh).then((hit) => {
      const now = useRender.getState().els
      const m: Record<string, ElRender> = {}
      for (const [k, v] of Object.entries(hit)) if (!now[k] || now[k].status === 'pending') m[k] = { ...v, status: 'ok', at: 0, cached: true }
      if (Object.keys(m).length) useRender.getState().setMany(m)
    })
  }
}

/** Re-request every wanted element whose render failed (backoff per key; also after the link comes back). */
function scheduleRetry(keys: string[]) {
  let wait = 0
  for (const k of keys) {
    const n = (attempts.get(k) ?? 0) + 1
    attempts.set(k, n)
    wait = Math.max(wait, Math.min(30_000, 1500 * 2 ** (n - 1)))
  }
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(retryFailed, wait)
}
function retryFailed() {
  retryTimer = null
  if (!projectId) return
  const els = useRender.getState().els
  let added = false
  for (const it of lastItems) {
    if (els[it.key]?.status === 'error' && wanted.has(it.key) && !queue.has(it.key)) {
      queue.set(it.key, it)
      added = true
    }
  }
  if (added) schedule(30)
}
onLinkRestored(() => {
  attempts.clear()
  retryFailed()
})

/** Drop cached errors (e.g. after a font was installed) and re-request. */
export function retryErrors() {
  const els = { ...useRender.getState().els }
  for (const [k, v] of Object.entries(els)) if (v.status === 'error') delete els[k]
  useRender.setState({ els })
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void flush(), ms)
}

async function flush() {
  if (inflight || !projectId) return
  for (const k of [...queue.keys()]) if (!wanted.has(k)) queue.delete(k)
  if (!queue.size) return
  const batch = [...queue.values()].slice(0, 16)
  for (const it of batch) queue.delete(it.key)
  const pend: Record<string, ElRender> = {}
  const els = useRender.getState().els
  for (const it of batch) if (!els[it.key] || els[it.key].status === 'error') pend[it.key] = { status: 'pending', at: Date.now() }
  if (Object.keys(pend).length) useRender.getState().setMany(pend)
  inflight = true
  try {
    await renderBatch(projectId, batch)
  } finally {
    inflight = false
    if (queue.size) schedule(30)
  }
}

async function renderBatch(pid: string, batch: RenderItem[]): Promise<void> {
  const doc: ProjectDoc = {
    version: 1,
    name: '_preview',
    variables: [],
    paper: batch[0].paper,
    print: SCRATCH_PRINT,
    pages: batch.map((it, i) => ({
      id: `s${i}`,
      paper: it.paper,
      origin: null,
      elements: [{ ...it.el, transform: { ...IDENTITY }, z: 0, hidden: false, locked: false } as Element],
    })),
  }
  let res: RenderResult
  try {
    res = await renderProject(pid, { doc, variables: vars, overrides: SCRATCH_PRINT }, {
      onProgress: (t) => {
        const els = useRender.getState().els
        const m: Record<string, ElRender> = {}
        for (const it of batch) if (els[it.key]?.status === 'pending') m[it.key] = { ...els[it.key], progress: t.progress ?? 0 }
        if (Object.keys(m).length) useRender.getState().setMany(m)
      },
    })
  } catch (e) {
    if (batch.length > 1 && !(isApiError(e) && e.isOffline)) {
      // isolate the failing element(s)
      for (const it of batch) await renderBatch(pid, [it])
      return
    }
    const out: Record<string, ElRender> = {}
    const els = useRender.getState().els
    for (const it of batch) {
      // keep showing cached / previous paths while retrying
      const prev = els[it.key]
      out[it.key] = prev?.status === 'ok' && prev.cached ? prev : { status: 'error', error: errorMessage(e), code: isApiError(e) ? e.code : undefined, at: Date.now() }
    }
    useRender.getState().setMany(out)
    scheduleRetry(batch.map((it) => it.key))
    return
  }
  const out: Record<string, ElRender> = {}
  await Promise.all(
    batch.map(async (it, i) => {
      const pages = res.pages.filter((p) => p.source_page === i)
      try {
        const polys: Polylines[] = await Promise.all(pages.map((p) => fetchPaths(res.rid, p.index)))
        const ds = polys.map((pl) => ({ d: polylinesToD(pl), bbox: polylinesBBox(pl) }))
        const w = pages[0]?.warnings
        out[it.key] = {
          status: 'ok',
          d: ds[0]?.d ?? '',
          bbox: ds[0]?.bbox ?? null,
          pages: it.el.type === 'flow_text' ? ds : undefined,
          strokes: polys.reduce((n, p) => n + p.length, 0),
          missing: w?.missing_glyphs ?? [],
          overflow: !!w?.overflow,
          at: Date.now(),
        }
      } catch (e) {
        out[it.key] = { status: 'error', error: errorMessage(e), at: Date.now() }
      }
    }),
  )
  useRender.getState().setMany(out)
  const failed = Object.entries(out).filter(([, v]) => v.status === 'error').map(([k]) => k)
  for (const k of Object.keys(out)) if (out[k].status === 'ok') attempts.delete(k)
  if (failed.length) scheduleRetry(failed)
  void cachePutMany(out)
}

// ------------------------------------------------------------------ page render

let pageCtl: AbortController | null = null

/** Stable JSON (sorted keys) → short hash; identical docs give identical keys whatever the edit history. */
export function stableHash(v: unknown): string {
  const seen = (x: unknown): string => {
    if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null'
    if (Array.isArray(x)) return '[' + x.map(seen).join(',') + ']'
    const o = x as Record<string, unknown>
    return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + seen(o[k])).join(',') + '}'
  }
  const str = seen(v)
  let h1 = 0x811c9dc5
  let h2 = 0
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = (Math.imul(h2, 31) + c) | 0
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${str.length.toString(36)}`
}

interface PageReq {
  pid: string
  doc: ProjectDoc
  version: number
  vars: Record<string, string>
  hash: string
  waiters: ((r: RenderResult | null) => void)[]
}
/** hash of the doc the current `page.result` was rendered from */
let doneHash: string | null = null
let running: PageReq | null = null
let nextReq: PageReq | null = null

async function runPage(req: PageReq) {
  running = req
  const ctl = new AbortController()
  pageCtl = ctl
  useRender.getState().setPage({ status: 'running', error: null })
  let out: RenderResult | null = null
  try {
    const result = await renderProject(req.pid, { doc: req.doc, variables: req.vars }, { signal: ctl.signal, slot: `${CLIENT_ID}/page` })
    if (!ctl.signal.aborted) {
      doneHash = req.hash
      out = result
      // only advance the shown version if no newer doc is waiting (keeps "更新中" visible until the latest lands)
      useRender.getState().setPage({ status: nextReq ? 'running' : 'ok', result, version: req.version, at: Date.now() })
    }
  } catch (e) {
    const aborted = ctl.signal.aborted || (e as DOMException)?.name === 'AbortError'
    if (!aborted) {
      // keep the last good result on screen; a connection drop is not a render error
      const offline = isApiError(e) && e.isOffline
      useRender.getState().setPage({ status: offline ? 'ok' : 'error', error: offline ? null : errorMessage(e), version: req.version })
    }
  } finally {
    running = null
    for (const w of req.waiters) w(out)
    const n = nextReq
    nextReq = null
    if (n && !ctl.signal.aborted) {
      if (n.hash === doneHash) {
        useRender.getState().setPage({ status: 'ok', version: n.version })
        for (const w of n.waiters) w(useRender.getState().page.result)
      } else void runPage(n)
    }
  }
  return out
}

/**
 * Render the whole document. Never cancels a running render (on a slow board that starved the preview):
 * a newer request waits and replaces any older waiting one. Identical content (stable hash) is not re-rendered.
 */
export function renderDocNow(pid: string, doc: ProjectDoc, version: number, variables: Record<string, string>): Promise<RenderResult | null> {
  const hash = stableHash([pid, doc, variables])
  const page = useRender.getState().page
  if (!running && hash === doneHash && page.result) {
    if (page.version !== version || page.status !== 'ok') useRender.getState().setPage({ status: 'ok', error: null, version })
    return Promise.resolve(page.result)
  }
  if (running && running.hash === hash) {
    nextReq = null
    return new Promise((res) => running!.waiters.push(res))
  }
  return new Promise((res) => {
    const req: PageReq = { pid, doc, version, vars: variables, hash, waiters: [res] }
    if (running) {
      if (nextReq) req.waiters.push(...nextReq.waiters)
      nextReq = req
    } else void runPage(req)
  })
}

/** True while the shown page result is older than the document (a render is queued or running). */
export function usePageUpdating(version: number) {
  return useRender((s) => s.page.status === 'running' || (s.page.result != null && s.page.version !== version && s.page.status !== 'error'))
}

/** Debounced page render whenever the document version changes. */
export function usePageRender(pid: string | null, doc: ProjectDoc | null, version: number, variables: Record<string, string>) {
  const last = useRef(0)
  useEffect(() => {
    if (!pid || !doc || version === last.current) return
    const t = setTimeout(() => {
      last.current = version
      void renderDocNow(pid, doc, version, variables)
    }, 900)
    return () => clearTimeout(t)
  }, [pid, doc, version, variables])
  useEffect(
    () => () => {
      pageCtl?.abort()
      nextReq = null
      doneHash = null
    },
    [],
  )
}

/** Fetch & cache page-render polylines (pen order) for overlays. */
const pathCache = new Map<string, Promise<Polylines>>()
export function pagePolylines(rid: string, index: number): Promise<Polylines> {
  const k = `${rid}/${index}`
  let p = pathCache.get(k)
  if (!p) {
    p = fetchPaths(rid, index)
    p.catch(() => pathCache.delete(k))
    pathCache.set(k, p)
    if (pathCache.size > 20) pathCache.delete(pathCache.keys().next().value!)
  }
  return p
}

/** Output page index of the render for a canvas view. */
export function outputIndex(result: RenderResult | null, page: number, sub: number): number | null {
  if (!result) return null
  const outs = result.pages.filter((p) => p.source_page === page)
  return outs[sub]?.index ?? null
}
