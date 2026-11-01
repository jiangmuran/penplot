/**
 * Multi-user collaboration for the studio.
 *
 * Transport: WebSocket client messages (`studio.presence` / `studio.patch` / `studio.saved` / `studio.bye`,
 * relayed by the server to other sessions viewing the same project) **and** a BroadcastChannel between tabs of the
 * same browser. The server side is still being added; until it relays, collaboration works across tabs/windows and
 * every message is harmless to the current server (unknown types are ignored).
 *
 * Model:
 * - presence: who is here, their page and selection (soft locks: "XX 正在编辑"), heartbeat 5 s, expiry 15 s.
 * - live patches: element-level upserts/deletes + page structure, applied without history and without re-broadcast.
 * - saving: whoever made local edits saves. A `saved {rev}` from a peer is adopted when we have no own unsaved edits;
 *   otherwise a `409 rev_conflict` is resolved by a 3-way element merge (base = our last saved doc) — nothing is
 *   discarded: for elements both sides changed we keep ours and offer "改用对方版本".
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { ws } from '@/api/ws'
import type { DocPage, Element, ProjectDoc } from '@/api/studio'
import { toast } from '@/lib/toast'
import { clone } from './model'
import { CLIENT_ID } from './render-engine'
import { useStudio } from './store'

export interface Peer {
  client: string
  /** Account display name (from the server's data.from), falls back to the device name. */
  name: string
  /** Device label the peer chose (e.g. "iPad · Safari"). */
  device?: string
  viewer?: boolean
  color: string
  page: number
  selection: string[]
  at: number
}

const COLORS = ['#ff9500', '#af52de', '#30b0c7', '#34c759', '#ff2d55', '#5856d6', '#a2845e', '#007aff']
function colorFor(id: string) {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0
  return COLORS[Math.abs(h) % COLORS.length]
}

const NAME_KEY = 'penplot.studio.name'
function defaultName() {
  const ua = navigator.userAgent
  const dev = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Linux'
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '浏览器'
  return `${dev} · ${br}`
}

interface CollabState {
  me: { client: string; name: string; color: string }
  peers: Record<string, Peer>
  setName: (n: string) => void
}

export const useCollab = create<CollabState>((set, get) => ({
  me: { client: CLIENT_ID, name: localStorage.getItem(NAME_KEY) || defaultName(), color: colorFor(CLIENT_ID) },
  peers: {},
  setName: (n) => {
    const name = n.trim() || defaultName()
    localStorage.setItem(NAME_KEY, name)
    set({ me: { ...get().me, name } })
    sendPresence()
  },
}))

// ------------------------------------------------------------------ transport

type Msg =
  | { type: 'studio.presence'; project_id: string; client: string; name: string; color: string; page: number; selection: string[] }
  | { type: 'studio.patch'; project_id: string; client: string; ops: PatchOp[] }
  | { type: 'studio.saved'; project_id: string; client: string; rev: number }
  | { type: 'studio.bye'; project_id: string; client: string }

type PatchOp =
  | { op: 'el'; page_id: string; element: Element }
  | { op: 'del'; page_id: string; id: string }
  | { op: 'pages'; pages: { id: string; paper: DocPage['paper']; origin: DocPage['origin']; background?: DocPage['background'] }[] }
  | { op: 'doc'; paper?: ProjectDoc['paper']; print?: ProjectDoc['print']; variables?: ProjectDoc['variables']; name?: string }

const bc: BroadcastChannel | null = typeof BroadcastChannel === 'function' ? new BroadcastChannel('penplot-studio') : null

function send(m: Msg) {
  // Viewers may only send presence/bye (04 §11); the server would drop anything else anyway.
  if (useStudio.getState().readOnly && m.type !== 'studio.presence' && m.type !== 'studio.bye') return
  bc?.postMessage(m)
  const { type, ...data } = m
  ws.send({ type, data })
}

/** Server-added attribution on relayed studio.* messages. */
interface From {
  user?: { id: string; username: string; display_name?: string; role?: string }
  conn_id?: string
}

function projectId() {
  return useStudio.getState().project?.id ?? null
}

export function sendPresence() {
  const pid = projectId()
  if (!pid) return
  const s = useStudio.getState()
  const me = useCollab.getState().me
  send({ type: 'studio.presence', project_id: pid, client: me.client, name: me.name, color: me.color, page: s.view.page, selection: s.selection })
}

export function announceSaved(rev: number) {
  const pid = projectId()
  if (pid) send({ type: 'studio.saved', project_id: pid, client: CLIENT_ID, rev })
}

// ------------------------------------------------------------------ receive

let applyingRemote = false
/** True while applying a peer patch (store subscribers must not re-broadcast or mark own edits). */
export const isApplyingRemote = () => applyingRemote

/** Own unsaved edits exist (as opposed to peer patches only). */
let ownDirty = false
export const hasOwnEdits = () => ownDirty
export function clearOwnEdits() {
  ownDirty = false
}

function onMessage(raw: unknown, wireType?: string) {
  const body = ((raw as { data?: Msg })?.data ?? raw) as Msg & { from?: From }
  if (!body || typeof body !== 'object') return
  const m = { ...body, type: (wireType ?? body.type) as Msg['type'] } as Msg & { from?: From }
  if (!('client' in m) || m.client === CLIENT_ID) return
  const pid = projectId()
  if (!pid || m.project_id !== pid) return
  switch (m.type) {
    case 'studio.presence': {
      const known = !!useCollab.getState().peers[m.client]
      // Authoritative name from the server (data.from); the client-chosen name is only a device hint.
      const u = m.from?.user
      const name = u ? (u.display_name || u.username) : m.name
      const role = u?.role
      useCollab.setState({
        peers: {
          ...useCollab.getState().peers,
          [m.client]: { client: m.client, name, color: m.color, page: m.page, selection: role === 'viewer' ? [] : m.selection, at: Date.now(), viewer: role === 'viewer', device: u ? m.name : undefined },
        },
      })
      if (!known) {
        toast.info(`${name} 加入了此项目${role === 'viewer' ? '（只读）' : ''}`, { key: `peer-${m.client}`, ephemeral: true })
        sendPresence()
      }
      break
    }
    case 'studio.bye': {
      const peers = { ...useCollab.getState().peers }
      delete peers[m.client]
      useCollab.setState({ peers })
      break
    }
    case 'studio.patch':
      applyRemote(m.ops)
      break
    case 'studio.saved': {
      const st = useStudio.getState()
      if (!st.project || m.rev <= st.project.rev) break
      if (!ownDirty) {
        st.setProjectMeta({ rev: m.rev })
        st.markSaved(m.rev, st.version)
        setBase(st.doc)
      }
      break
    }
  }
}

function applyRemote(ops: PatchOp[]) {
  const st = useStudio.getState()
  if (!st.doc) return
  const dragging = new Set(st.dragging)
  applyingRemote = true
  try {
    st.edit(
      (doc) => applyOps(doc, ops, dragging),
      { record: false, remote: true },
    )
    // remote edits don't count as ours: keep saved status
    const s2 = useStudio.getState()
    if (!ownDirty) useStudio.setState({ savedVersion: s2.version, saveState: 'saved' })
  } finally {
    applyingRemote = false
  }
}

function applyOps(doc: ProjectDoc, ops: PatchOp[], skip: Set<string>): ProjectDoc {
  for (const o of ops) {
    if (o.op === 'el' || o.op === 'del') {
      const page = doc.pages.find((p) => p.id === o.page_id)
      if (!page) continue
      if (o.op === 'el') {
        if (skip.has(o.element.id)) continue
        const i = page.elements.findIndex((e) => e.id === o.element.id)
        if (i >= 0) page.elements[i] = o.element
        else {
          // element moved between pages → remove elsewhere
          for (const p of doc.pages) p.elements = p.elements.filter((e) => e.id !== o.element.id)
          page.elements.push(o.element)
        }
      } else page.elements = page.elements.filter((e) => e.id !== o.id)
    } else if (o.op === 'pages') {
      const byId = new Map(doc.pages.map((p) => [p.id, p]))
      doc.pages = o.pages.map((p) => ({ ...(byId.get(p.id) ?? { id: p.id, elements: [] }), paper: p.paper, origin: p.origin, background: p.background ?? null }))
    } else if (o.op === 'doc') {
      if (o.paper !== undefined) doc.paper = o.paper
      if (o.print !== undefined) doc.print = o.print
      if (o.variables !== undefined) doc.variables = o.variables
      if (o.name !== undefined) doc.name = o.name
    }
  }
  return doc
}

// ------------------------------------------------------------------ diff (local → ops)

const j = (v: unknown) => JSON.stringify(v)

export function diffDocs(a: ProjectDoc, b: ProjectDoc): PatchOp[] {
  const ops: PatchOp[] = []
  const pa = a.pages.map((p) => ({ id: p.id, paper: p.paper, origin: p.origin, background: p.background ?? null }))
  const pb = b.pages.map((p) => ({ id: p.id, paper: p.paper, origin: p.origin, background: p.background ?? null }))
  if (j(pa) !== j(pb)) ops.push({ op: 'pages', pages: pb })
  const d: Extract<PatchOp, { op: 'doc' }> = { op: 'doc' }
  if (j(a.paper) !== j(b.paper)) d.paper = b.paper
  if (j(a.print) !== j(b.print)) d.print = b.print
  if (j(a.variables) !== j(b.variables)) d.variables = b.variables
  if (a.name !== b.name) d.name = b.name
  if (Object.keys(d).length > 1) ops.push(d)
  const oldEls = new Map<string, { page: string; el: Element }>()
  for (const p of a.pages) for (const e of p.elements) oldEls.set(e.id, { page: p.id, el: e })
  for (const p of b.pages) {
    for (const e of p.elements) {
      const o = oldEls.get(e.id)
      if (!o || o.page !== p.id || (o.el !== e && j(o.el) !== j(e))) ops.push({ op: 'el', page_id: p.id, element: e })
      oldEls.delete(e.id)
    }
  }
  for (const [id, o] of oldEls) ops.push({ op: 'del', page_id: o.page, id })
  return ops
}

// ------------------------------------------------------------------ 3-way merge (rev conflict)

let base: ProjectDoc | null = null
export function setBase(doc: ProjectDoc | null) {
  base = doc ? clone(doc) : null
}
export const getBase = () => base

export interface MergeResult {
  doc: ProjectDoc
  conflicts: { id: string; theirs: Element; page_id: string }[]
}

/** Merge `ours` (local) and `theirs` (server) against the common `base`, element by element. */
export function merge3(baseDoc: ProjectDoc, ours: ProjectDoc, theirs: ProjectDoc): MergeResult {
  const conflicts: MergeResult['conflicts'] = []
  const index = (d: ProjectDoc) => {
    const m = new Map<string, { page: string; el: Element }>()
    for (const p of d.pages) for (const e of p.elements) m.set(e.id, { page: p.id, el: e })
    return m
  }
  const B = index(baseDoc)
  const O = index(ours)
  const T = index(theirs)
  // page structure: take ours if we changed it, else theirs
  const pageSig = (d: ProjectDoc) => j(d.pages.map((p) => [p.id, p.paper, p.origin, p.background ?? null]))
  const pagesFrom = pageSig(ours) !== pageSig(baseDoc) ? ours : theirs
  const out: ProjectDoc = clone({ ...theirs, pages: pagesFrom.pages.map((p) => ({ ...p, elements: [] as Element[] })) })
  for (const k of ['paper', 'print', 'variables', 'name'] as const) {
    if (j(ours[k]) !== j(baseDoc[k])) (out as unknown as Record<string, unknown>)[k] = clone(ours[k])
  }
  const pageOf = new Map(out.pages.map((p) => [p.id, p]))
  const ids = new Set([...O.keys(), ...T.keys()])
  for (const id of ids) {
    const b = B.get(id)
    const o = O.get(id)
    const t = T.get(id)
    const oChanged = j(o) !== j(b)
    const tChanged = j(t) !== j(b)
    let pick: { page: string; el: Element } | undefined
    if (oChanged && tChanged && j(o) !== j(t)) {
      pick = o ?? t // keep ours (or theirs if we deleted it but they edited — non-destructive)
      if (o && t) conflicts.push({ id, theirs: t.el, page_id: t.page })
    } else pick = oChanged ? o : t
    if (!pick) continue
    const page = pageOf.get(pick.page) ?? out.pages[0]
    page.elements.push(clone(pick.el))
  }
  return { doc: out, conflicts }
}

// ------------------------------------------------------------------ hook

/** Wire presence + live patches for the open project. */
export function useCollaboration() {
  const pid = useStudio((s) => s.project?.id ?? null)
  useEffect(() => {
    if (!pid) return
    const offWs = [ws.on('*', (payload: unknown, raw: Record<string, unknown>) => {
      if (typeof raw?.type === 'string' && raw.type.startsWith('studio.')) onMessage(payload, raw.type)
    })]
    const onBc = (e: MessageEvent) => onMessage(e.data)
    bc?.addEventListener('message', onBc)
    useCollab.setState({ peers: {} })
    sendPresence()
    const hb = setInterval(() => {
      sendPresence()
      const now = Date.now()
      const peers = useCollab.getState().peers
      const alive = Object.fromEntries(Object.entries(peers).filter(([, p]) => now - p.at < 15_000))
      if (Object.keys(alive).length !== Object.keys(peers).length) useCollab.setState({ peers: alive })
    }, 5000)
    // local edits → patches (throttled)
    let prev = useStudio.getState().doc
    let pending: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      pending = null
      const cur = useStudio.getState().doc
      if (!prev || !cur || prev === cur) return
      const ops = diffDocs(prev, cur)
      prev = cur
      if (ops.length) send({ type: 'studio.patch', project_id: pid, client: CLIENT_ID, ops })
    }
    let lastSel = ''
    const unsub = useStudio.subscribe((s, old) => {
      if (s.doc !== old.doc) {
        if (applyingRemote) prev = s.doc
        else {
          ownDirty = true
          if (!pending) pending = setTimeout(flush, 80)
        }
      }
      const sel = `${s.view.page}|${s.selection.join(',')}`
      if (sel !== lastSel) {
        lastSel = sel
        sendPresence()
      }
    })
    const bye = () => send({ type: 'studio.bye', project_id: pid, client: CLIENT_ID })
    window.addEventListener('pagehide', bye)
    return () => {
      bye()
      if (pending) clearTimeout(pending)
      offWs.forEach((f) => f())
      bc?.removeEventListener('message', onBc)
      clearInterval(hb)
      unsub()
      window.removeEventListener('pagehide', bye)
    }
  }, [pid])
}

/** Peers on the current page who have `id` selected. */
export function usePeersEditing(id: string | null): Peer[] {
  const peers = useCollab((s) => s.peers)
  const page = useStudio((s) => s.view.page)
  if (!id) return []
  return Object.values(peers).filter((p) => p.page === page && p.selection.includes(id))
}

