/** Editor commands shared by toolbar, context menus, inspector and shortcuts. */
import { errorMessage } from '@/api/client'
import { qk, queryClient } from '@/api/query'
import { importFile, type Element, type PaperBase, type PaperSpec } from '@/api/studio'
import { toast } from '@/lib/toast'
import { aabb, corners, localBox, type Box } from './geometry'
import {
  clone, elementName, makeFlow, makeGcode, makeImage, makeShape, makeText, makeVector, maxZ, newId, newPage, normalizeZ,
  pagePaperRef, paperDims, resolvePaper, sortedByZ,
} from './model'
import { useRender } from './render-engine'
import { currentPage, selectedElements, studio, useStudio } from './store'

export function papersCache(): PaperSpec[] | undefined {
  return queryClient.getQueryData<PaperSpec[]>(qk.papers.list())
}

export function currentPaper(pageIndex?: number): PaperBase {
  const s = useStudio.getState()
  const doc = s.doc
  const page = doc?.pages[pageIndex ?? s.view.page]
  return resolvePaper(doc && page ? pagePaperRef(doc, page) : null, papersCache())
}

let pickedFont: string | null = null
/** Remember a CJK-capable font to use when the app has no default font set. */
export function setFallbackFont(id: string | null) {
  pickedFont = id
}
export function defaultFontId(): string | null {
  const s = queryClient.getQueryData<{ default_font?: string | null }>(qk.settings)
  return s?.default_font ?? pickedFont
}

/** Page-space AABB of an element (uses the rendered bbox when the frame depends on it). */
export function elementAABB(el: Element, paper: PaperBase): Box {
  return aabb(corners(el.transform, localBox(el, paper, findRendered(el))))
}

/** AABB of the element's ink (rendered paths) on the page; falls back to the layout box before the first render. */
export function inkAABB(el: Element, paper: PaperBase): Box {
  const rb = findRendered(el)
  if (!rb || el.type === 'flow_text') return elementAABB(el, paper)
  return aabb(corners(el.transform, { x: rb[0], y: rb[1], w: Math.max(0, rb[2] - rb[0]), h: Math.max(0, rb[3] - rb[1]) }))
}

/** Drawing bounding box of a page (page mm) = what the backend anchors a 'content' origin to. */
export function contentBox(elements: Element[], paper: PaperBase): Box | null {
  const els = useRender.getState().els
  const boxes = elements
    .filter((e) => !e.hidden)
    .filter((e) => {
      // rendered without any ink (e.g. an empty text) → not part of the drawing
      const k = lastKeys.get(e.id)
      const r = k ? els[k] : undefined
      return !(r?.status === 'ok' && !r.bbox && !r.pages?.some((p) => p.bbox))
    })
    .map((e) => inkAABB(e, paper))
  if (!boxes.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of boxes) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function findRendered(el: Element) {
  // cheap lookup: the canvas stores the last key per element id
  const key = lastKeys.get(el.id)
  const e = key ? useRender.getState().els[key] : undefined
  return e?.bbox ?? null
}
export const lastKeys = new Map<string, string>()

// ------------------------------------------------------------------ insert

function centerOfPage(paper: PaperBase) {
  const { w, h } = paperDims(paper)
  return { x: w / 2, y: h / 2 }
}

export function insertText(at?: { x: number; y: number }, box?: { w: number; h: number }) {
  const s = useStudio.getState()
  const page = currentPage(s)
  if (!page) return
  const paper = currentPaper()
  const c = centerOfPage(paper)
  const el = makeText(at?.x ?? c.x - 40, at?.y ?? c.y - 12, maxZ(page) + 1, defaultFontId())
  if (box && el.type === 'text') el.props.box = { w: Math.max(10, box.w), h: Math.max(6, box.h) }
  studio.addElements([el])
  useStudio.setState({ tool: 'select', editTextOf: el.id })
  return el
}

export function insertShape(kind: 'rect' | 'ellipse' | 'line' | 'polygon' | 'grid', at?: { x: number; y: number }, size?: { w: number; h: number }) {
  const s = useStudio.getState()
  const page = currentPage(s)
  if (!page) return
  const paper = currentPaper()
  const c = centerOfPage(paper)
  const w = size?.w ?? (kind === 'grid' ? 120 : 40)
  const h = size?.h ?? (kind === 'grid' ? 15 : 30)
  const el = makeShape(kind, at?.x ?? c.x - w / 2, at?.y ?? c.y - h / 2, maxZ(page) + 1, w, h)
  studio.addElements([el])
  useStudio.setState({ tool: 'select' })
  return el
}

/** Upload files and place them on the current page (arranged around the centre, all selected). */
export async function addFiles(files: File[], as: 'element' | 'letter' = 'element') {
  const s = useStudio.getState()
  if (!s.doc) return
  const page = currentPage(s)
  if (!page) return
  const paper = currentPaper()
  const { w: pw } = paperDims(paper)
  const maxW = pw - paper.margins.l - paper.margins.r
  const c = centerOfPage(paper)
  const tid = toast.info(files.length > 1 ? `正在导入 ${files.length} 个文件…` : `正在导入 ${files[0].name}…`, { duration: 60_000, ephemeral: true })
  const made: Element[] = []
  let z = maxZ(page) + 1
  for (const f of files) {
    try {
      const r = await importFile(f)
      let el: Element | null = null
      if (r.kind === 'svg' || r.kind === 'dxf') {
        const d = r.data
        el = makeVector(r.kind, { file_id: d.file.id, file_name: f.name, w: d.width_mm, h: d.height_mm }, 0, 0, z, maxW)
      } else if (r.kind === 'image') {
        el = makeImage({ file_id: r.data.file.id, file_name: f.name, w: 0, h: 0, px_w: r.data.px_w, px_h: r.data.px_h }, 0, 0, z, Math.min(80, maxW))
      } else if (r.kind === 'gcode') {
        const bb = r.data.analysis.bbox ?? [0, 0, 30, 30]
        el = makeGcode({ file_id: r.data.file.id, file_name: f.name, w: Math.max(1, bb[2] - bb[0]), h: Math.max(1, bb[3] - bb[1]) }, 0, 0, z)
        if (r.data.analysis.warnings?.length) toast.warning(`${f.name}：${r.data.analysis.warnings.length} 条警告`, { description: r.data.analysis.warnings.slice(0, 3).join('；') })
      } else if (r.kind === 'text') {
        if (as === 'letter') {
          setLetterText(r.data.text)
          continue
        }
        el = makeText(0, 0, z, defaultFontId(), r.data.text)
        if (el.type === 'text') el.props.box = { w: Math.min(120, maxW), h: Math.min(120, Math.max(20, (r.data.text.split('\n').length + 1) * 10.4)) }
      }
      if (el) {
        z++
        made.push(el)
      }
    } catch (e) {
      toast.error(`无法导入 ${f.name}`, { description: errorMessage(e) })
    }
  }
  toast.dismiss(tid)
  if (!made.length) return
  // arrange in a row around the page centre
  const sizes = made.map((e) => localBox(e, paper))
  const gap = 6
  const total = sizes.reduce((n, b) => n + b.w, 0) + gap * (made.length - 1)
  let x = c.x - total / 2
  made.forEach((e, i) => {
    e.transform.x = Math.max(0, x)
    e.transform.y = Math.max(0, c.y - sizes[i].h / 2)
    x += sizes[i].w + gap
  })
  studio.addElements(made)
  toast.success(made.length > 1 ? `已添加 ${made.length} 个元素` : `已添加 ${elementName(made[0])}`)
}

export function setLetterText(text: string) {
  const s = useStudio.getState()
  s.edit((doc) => {
    const page = doc.pages[s.view.page] ?? doc.pages[0]
    const flow = page.elements.find((e) => e.type === 'flow_text')
    if (flow && flow.type === 'flow_text') flow.props.text = text
    else page.elements = normalizeZ([{ ...makeFlow(defaultFontId(), text), z: -1 }, ...page.elements])
  })
}

/** Switch document mode: letter adds a flow_text body on the current page; free removes it (undoable). */
export function setMode(mode: 'free' | 'letter') {
  const s = useStudio.getState()
  const doc = s.doc
  if (!doc) return
  if (mode === 'letter') {
    if (doc.pages.some((p) => p.elements.some((e) => e.type === 'flow_text'))) return
    const flow = { ...makeFlow(defaultFontId(), ''), z: -1 }
    s.edit((d) => {
      const page = d.pages[s.view.page]
      page.elements = normalizeZ([flow, ...page.elements])
    })
    useStudio.setState({ selection: [flow.id], editTextOf: flow.id })
  } else {
    s.edit((d) => {
      for (const p of d.pages) p.elements = normalizeZ(p.elements.filter((e) => e.type !== 'flow_text'))
    })
    useStudio.setState({ selection: [] })
    toast({ title: '已移除信笺正文', action: { label: '撤销', onClick: () => useStudio.getState().undo() }, duration: 5000 })
  }
}

// ------------------------------------------------------------------ clipboard

const CLIP_KEY = 'penplot.studio.clipboard'
export function copySelection(cut = false) {
  const s = useStudio.getState()
  const els = selectedElements(s).filter((e) => e.type !== 'flow_text')
  if (!els.length) return
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(els))
  } catch {
    /* ignore */
  }
  if (cut) {
    studio.deleteElements(els.map((e) => e.id))
    toast({ title: `已剪切 ${els.length} 个元素`, duration: 3000 })
  }
}

export function paste(offset = 5) {
  const s = useStudio.getState()
  const page = currentPage(s)
  if (!page) return
  let els: Element[] = []
  try {
    els = JSON.parse(localStorage.getItem(CLIP_KEY) ?? '[]') as Element[]
  } catch {
    return
  }
  if (!els.length) return
  let z = maxZ(page) + 1
  const copies = sortedByZ(els).map((e) => ({ ...clone(e), id: newId(), z: z++, locked: false, transform: { ...e.transform, x: e.transform.x + offset, y: e.transform.y + offset } }))
  studio.addElements(copies)
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(copies))
  } catch {
    /* ignore */
  }
}

export function duplicateSelection() {
  copySelection()
  paste(5)
}

export function deleteSelection() {
  const s = useStudio.getState()
  const els = selectedElements(s).filter((e) => !e.locked)
  if (!els.length) return
  studio.deleteElements(els.map((e) => e.id))
  toast({
    title: els.length > 1 ? `已删除 ${els.length} 个元素` : `已删除「${elementName(els[0])}」`,
    action: { label: '撤销', onClick: () => useStudio.getState().undo() },
    duration: 5000,
  })
}

// ------------------------------------------------------------------ arrange

export function nudge(dx: number, dy: number) {
  const s = useStudio.getState()
  const ids = selectedElements(s).filter((e) => !e.locked).map((e) => e.id)
  if (!ids.length) return
  studio.updateElements(ids, (e) => ({ ...e, transform: { ...e.transform, x: round3(e.transform.x + dx), y: round3(e.transform.y + dy) } }), { coalesce: `nudge:${ids.join(',')}` })
}
const round3 = (v: number) => Math.round(v * 1000) / 1000

export function zOrder(dir: 'up' | 'down' | 'top' | 'bottom') {
  const s = useStudio.getState()
  const page = currentPage(s)
  if (!page || !s.selection.length) return
  const sel = new Set(s.selection)
  let list = sortedByZ(page.elements)
  if (dir === 'top') list = [...list.filter((e) => !sel.has(e.id)), ...list.filter((e) => sel.has(e.id))]
  else if (dir === 'bottom') list = [...list.filter((e) => sel.has(e.id)), ...list.filter((e) => !sel.has(e.id))]
  else if (dir === 'up') {
    for (let i = list.length - 2; i >= 0; i--) if (sel.has(list[i].id) && !sel.has(list[i + 1].id)) [list[i], list[i + 1]] = [list[i + 1], list[i]]
  } else {
    for (let i = 1; i < list.length; i++) if (sel.has(list[i].id) && !sel.has(list[i - 1].id)) [list[i], list[i - 1]] = [list[i - 1], list[i]]
  }
  const order = new Map(list.map((e, i) => [e.id, i]))
  s.edit((doc) => {
    const p = doc.pages[s.view.page]
    p.elements = p.elements.map((e) => ({ ...e, z: order.get(e.id) ?? e.z }))
  })
}

/** Move element `id` to position `index` in the z-ordered list (layers drag & drop). */
export function moveToIndex(id: string, index: number) {
  const s = useStudio.getState()
  const page = currentPage(s)
  if (!page) return
  const list = sortedByZ(page.elements)
  const from = list.findIndex((e) => e.id === id)
  if (from < 0) return
  const [it] = list.splice(from, 1)
  list.splice(Math.max(0, Math.min(list.length, index)), 0, it)
  const order = new Map(list.map((e, i) => [e.id, i]))
  s.edit((doc) => {
    const p = doc.pages[s.view.page]
    p.elements = p.elements.map((e) => ({ ...e, z: order.get(e.id) ?? e.z }))
  })
}

export function toggleLock(ids?: string[]) {
  const s = useStudio.getState()
  const els = ids ? currentPage(s)?.elements.filter((e) => ids.includes(e.id)) ?? [] : selectedElements(s)
  if (!els.length) return
  const lock = !els.every((e) => e.locked)
  studio.updateElements(els.map((e) => e.id), (e) => ({ ...e, locked: lock }))
  if (lock && !ids) useStudio.setState({ selection: [] })
}

export function toggleHidden(ids?: string[]) {
  const s = useStudio.getState()
  const els = ids ? currentPage(s)?.elements.filter((e) => ids.includes(e.id)) ?? [] : selectedElements(s)
  if (!els.length) return
  const hide = !els.every((e) => e.hidden)
  studio.updateElements(els.map((e) => e.id), (e) => ({ ...e, hidden: hide }))
}

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

/** Align selection to each other (≥2) or to the page margin box (1). */
export function align(mode: AlignMode) {
  const s = useStudio.getState()
  const els = selectedElements(s).filter((e) => !e.locked)
  if (!els.length) return
  const paper = currentPaper()
  const boxes = els.map((e) => elementAABB(e, paper))
  let ref: Box
  if (els.length === 1) {
    const { w, h } = paperDims(paper)
    const m = paper.margins
    ref = { x: m.l, y: m.t, w: w - m.l - m.r, h: h - m.t - m.b }
  } else {
    const x0 = Math.min(...boxes.map((b) => b.x))
    const y0 = Math.min(...boxes.map((b) => b.y))
    ref = { x: x0, y: y0, w: Math.max(...boxes.map((b) => b.x + b.w)) - x0, h: Math.max(...boxes.map((b) => b.y + b.h)) - y0 }
  }
  const deltas = new Map<string, { dx: number; dy: number }>()
  els.forEach((e, i) => {
    const b = boxes[i]
    let dx = 0
    let dy = 0
    if (mode === 'left') dx = ref.x - b.x
    if (mode === 'hcenter') dx = ref.x + ref.w / 2 - (b.x + b.w / 2)
    if (mode === 'right') dx = ref.x + ref.w - (b.x + b.w)
    if (mode === 'top') dy = ref.y - b.y
    if (mode === 'vcenter') dy = ref.y + ref.h / 2 - (b.y + b.h / 2)
    if (mode === 'bottom') dy = ref.y + ref.h - (b.y + b.h)
    deltas.set(e.id, { dx, dy })
  })
  studio.updateElements([...deltas.keys()], (e) => {
    const d = deltas.get(e.id)!
    return { ...e, transform: { ...e.transform, x: round3(e.transform.x + d.dx), y: round3(e.transform.y + d.dy) } }
  })
}

export function distribute(axis: 'x' | 'y') {
  const s = useStudio.getState()
  const els = selectedElements(s).filter((e) => !e.locked)
  if (els.length < 3) return
  const paper = currentPaper()
  const items = els.map((e) => ({ e, b: elementAABB(e, paper) })).sort((a, b) => (axis === 'x' ? a.b.x - b.b.x : a.b.y - b.b.y))
  const first = items[0].b
  const last = items[items.length - 1].b
  const span = axis === 'x' ? last.x + last.w - first.x : last.y + last.h - first.y
  const sizes = items.reduce((n, it) => n + (axis === 'x' ? it.b.w : it.b.h), 0)
  const gap = (span - sizes) / (items.length - 1)
  let pos = axis === 'x' ? first.x : first.y
  const deltas = new Map<string, number>()
  for (const it of items) {
    deltas.set(it.e.id, pos - (axis === 'x' ? it.b.x : it.b.y))
    pos += (axis === 'x' ? it.b.w : it.b.h) + gap
  }
  studio.updateElements([...deltas.keys()], (e) => {
    const d = deltas.get(e.id)!
    return { ...e, transform: { ...e.transform, x: axis === 'x' ? round3(e.transform.x + d) : e.transform.x, y: axis === 'y' ? round3(e.transform.y + d) : e.transform.y } }
  })
}

// ------------------------------------------------------------------ pages

export function addPage(after?: number) {
  const s = useStudio.getState()
  if (!s.doc) return
  const at = (after ?? s.view.page) + 1
  const p = newPage()
  s.edit((doc) => {
    doc.pages.splice(at, 0, p)
  })
  useStudio.setState({ view: { page: at, sub: 0 }, selection: [] })
}

export function duplicatePage(i: number) {
  const s = useStudio.getState()
  if (!s.doc) return
  const src = s.doc.pages[i]
  const copy = { ...clone(src), id: newId('p'), elements: src.elements.filter((e) => e.type !== 'flow_text').map((e) => ({ ...clone(e), id: newId() })) }
  s.edit((doc) => {
    doc.pages.splice(i + 1, 0, copy)
  })
  useStudio.setState({ view: { page: i + 1, sub: 0 }, selection: [] })
}

export function deletePage(i: number) {
  const s = useStudio.getState()
  if (!s.doc || s.doc.pages.length <= 1) return
  s.edit((doc) => {
    doc.pages.splice(i, 1)
  })
  useStudio.setState({ view: { page: Math.max(0, Math.min(i, s.doc.pages.length - 2)), sub: 0 }, selection: [] })
  toast({ title: `已删除第 ${i + 1} 页`, action: { label: '撤销', onClick: () => useStudio.getState().undo() }, duration: 5000 })
}

export function movePage(from: number, to: number) {
  const s = useStudio.getState()
  if (!s.doc || from === to) return
  s.edit((doc) => {
    const [p] = doc.pages.splice(from, 1)
    doc.pages.splice(to, 0, p)
  })
  useStudio.setState({ view: { page: to, sub: 0 } })
}

export function selectAll() {
  const s = useStudio.getState()
  const page = currentPage(s)
  if (page) useStudio.setState({ selection: page.elements.filter((e) => !e.locked).map((e) => e.id) })
}
