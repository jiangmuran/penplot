/** Composition model helpers (03-backend §3.3, 04 §8). Pure functions — no React. */
import type {
  DocPage, Element, ElementType, Jitter, Margins, OriginSpec, PaperBase, PaperRef, PaperSpec, ProjectDoc, Transform,
} from '@/api/studio'
import { uid } from '@/lib/id'

export const IDENTITY: Transform = { x: 0, y: 0, scale: 1, sx: 1, sy: 1, rotation: 0 }

export const NO_JITTER: Jitter = {
  randomY: 0, randomRotate: [0, 0], randomFontSize: [1, 1], randomSpace: [1, 1], randomXScale: [1, 1], randomYScale: [1, 1],
  randomFirstPos: 0, simple: 0, widthAdd: 0, spaceWidthAdd: 0, tabWidthAdd: 0, baseLine: 1, chars: '，,.。',
}

export interface JitterPreset {
  id: string
  label: string
  jitter: Partial<Jitter>
}
export const JITTER_PRESETS: JitterPreset[] = [
  { id: 'none', label: '工整', jitter: { randomY: 0, randomRotate: [0, 0], randomFontSize: [1, 1], randomSpace: [1, 1], randomXScale: [1, 1], randomYScale: [1, 1] } },
  { id: 'natural', label: '自然', jitter: { randomY: 0.06, randomRotate: [-3, 3], randomFontSize: [0.94, 1.06], randomSpace: [0.9, 1.1], randomXScale: [0.95, 1.05], randomYScale: [0.95, 1.05] } },
  { id: 'loose', label: '潦草', jitter: { randomY: 0.12, randomRotate: [-6, 6], randomFontSize: [0.88, 1.12], randomSpace: [0.8, 1.25], randomXScale: [0.9, 1.1], randomYScale: [0.9, 1.1] } },
]

export const TYPE_LABEL: Record<ElementType, string> = {
  text: '文本框', flow_text: '信笺正文', image: '图片', svg: 'SVG', dxf: 'DXF', shape: '形状', gcode: 'G 代码',
}
export const SHAPE_LABEL: Record<string, string> = { rect: '矩形', ellipse: '椭圆', line: '直线', polygon: '多边形', grid: '格线' }

export function elementName(el: Element): string {
  if (el.name) return el.name
  if (el.type === 'text') return (el.props.text || '文本框').replace(/\s+/g, ' ').slice(0, 16) || '文本框'
  if (el.type === 'shape') return SHAPE_LABEL[el.props.kind] ?? '形状'
  const fn = (el.props as { file_name?: string }).file_name
  return fn || TYPE_LABEL[el.type]
}

// ------------------------------------------------------------------ papers

export const DEFAULT_MARGINS: Margins = { l: 31.8, r: 31.8, t: 25.4, b: 25.4 }

export function paperDims(p: PaperBase): { w: number; h: number } {
  const land = p.orientation === 'landscape'
  return land ? { w: p.height_mm, h: p.width_mm } : { w: p.width_mm, h: p.height_mm }
}

export const FALLBACK_PAPER: PaperBase = {
  name: 'A4普通边距', width_mm: 209, height_mm: 296, margins: DEFAULT_MARGINS, orientation: 'portrait', rotation: 0,
  ruling: { line_num: 20, line_gap: 0, line_gap_offset: 0, base_line: 1 },
}

/** Resolve a PaperRef against the paper list. */
export function resolvePaper(ref: PaperRef | null | undefined, papers: PaperSpec[] | undefined): PaperBase {
  if (ref?.spec) return ref.spec
  if (ref?.paper_id) {
    const p = papers?.find((x) => x.id === ref.paper_id)
    if (p) return p
  }
  return papers?.find((x) => x.id === 'a4-normal') ?? FALLBACK_PAPER
}

export function pagePaperRef(doc: ProjectDoc, page: DocPage): PaperRef {
  return page.paper ?? doc.paper
}

// ------------------------------------------------------------------ origin

export const DEFAULT_ORIGIN: OriginSpec = { corner: 0, revxy: false, x_rev: false, y_rev: false, offset_x_mm: 0, offset_y_mm: 0, rotation: 0, set_zero_at_start: null, anchor: null }

export type OriginAnchor = 'paper' | 'content'
/** Effective anchor: 'content' = origin at the drawing's bounding-box corner (pen parked at the top-left of the writing). */
export const originAnchor = (o: Partial<OriginSpec> | null | undefined): OriginAnchor => (o?.anchor === 'content' ? 'content' : 'paper')

/** Field-wise merge like the backend's printcfg.merge_print: null/undefined fields of later layers don't wipe earlier ones. */
export function mergeOrigin(...layers: (Partial<OriginSpec> | null | undefined)[]): OriginSpec {
  const out: Record<string, unknown> = { ...DEFAULT_ORIGIN }
  for (const l of layers) if (l) for (const [k, v] of Object.entries(l)) if (v != null) out[k] = v
  return out as OriginSpec
}

/** Machine travel configured? (0×0 = not set: the plotter has no homing, travel is not checked.) */
export function hasTravel(wa: { w_mm: number; h_mm: number } | null | undefined): wa is { w_mm: number; h_mm: number } {
  return !!wa && wa.w_mm > 0 && wa.h_mm > 0
}

/** Origin from the profile (axes + settings offsets). */
export function profileOrigin(doc: { axes?: Record<string, unknown>; settings?: Record<string, unknown>; print_defaults?: Record<string, unknown> } | undefined): OriginSpec {
  const a = (doc?.axes ?? {}) as { revxy?: boolean; xAxeRev?: boolean; yAxeRev?: boolean; pos?: number }
  const s = (doc?.settings ?? {}) as { offsetX?: number; offsetY?: number; rotate?: number }
  const rot = Number(s.rotate ?? 0)
  const pd = ((doc?.print_defaults ?? {}) as { origin?: Partial<OriginSpec> | null }).origin ?? null
  return mergeOrigin({
    corner: ([0, 1, 2, 3].includes(Number(a.pos)) ? Number(a.pos) : 0) as OriginSpec['corner'],
    revxy: !!a.revxy,
    x_rev: !!a.xAxeRev,
    y_rev: !!a.yAxeRev,
    offset_x_mm: Number(s.offsetX ?? 0) || 0,
    offset_y_mm: Number(s.offsetY ?? 0) || 0,
    rotation: ([0, 90, 180, 270].includes(rot) ? rot : 0) as OriginSpec['rotation'],
  }, pd)
}

export type ContentBox = { x: number; y: number; w: number; h: number } | null | undefined

/**
 * Origin marker position in page space (mm). anchor 'paper': the chosen paper corner (+ inward offset);
 * anchor 'content': the chosen corner of the drawing's bounding box `content` (layout.export_transform_mm).
 */
export function originPoint(o: OriginSpec, w: number, h: number, content?: ContentBox) {
  const right = o.corner === 1 || o.corner === 3
  const bottom = o.corner === 2 || o.corner === 3
  let x0 = 0
  let y0 = 0
  let x1 = w
  let y1 = h
  if (originAnchor(o) === 'content' && content) {
    x0 = content.x
    y0 = content.y
    x1 = content.x + content.w
    y1 = content.y + content.h
  }
  return { x: right ? x1 - o.offset_x_mm : x0 + o.offset_x_mm, y: bottom ? y1 - o.offset_y_mm : y0 + o.offset_y_mm }
}

/** Page-space unit vectors of machine +X and +Y (inverse of export_transform_mm's axis mapping). */
export function machineAxes(o: OriginSpec) {
  const fwd = (dx: number, dy: number) => {
    let x = dx
    let y = -dy
    if (o.revxy) [x, y] = [y, x]
    if (o.x_rev) x = -x
    if (o.y_rev) y = -y
    return [x, y] as const
  }
  // M columns = images of page unit vectors; M is a signed permutation → inverse = transpose.
  const [a, c] = fwd(1, 0)
  const [b, d] = fwd(0, 1)
  // machine +X (1,0) → page (a, b); machine +Y (0,1) → page (c, d)
  return { x: { x: a, y: b }, y: { x: c, y: d } }
}

/** Work area rectangle in page space, extending from the origin into the page (layout.work_area_rect). */
export function workAreaRect(o: OriginSpec, w: number, h: number, workW: number, workH: number, content?: ContentBox) {
  const p = originPoint(o, w, h, content)
  const ax = machineAxes(o)
  // machine X spans workW along ax.x, machine Y spans workH along ax.y; pick the quadrant pointing into the page
  const inX = o.corner === 1 || o.corner === 3 ? -1 : 1
  const inY = o.corner === 2 || o.corner === 3 ? -1 : 1
  const ex = Math.abs(ax.x.x) > 0.5 ? workW : workH // extent along page x
  const ey = Math.abs(ax.x.x) > 0.5 ? workH : workW
  const x0 = inX > 0 ? p.x : p.x - ex
  const y0 = inY > 0 ? p.y : p.y - ey
  return { x: x0, y: y0, w: ex, h: ey }
}

// ------------------------------------------------------------------ elements

export function newId(prefix = 'e') {
  return uid(prefix).slice(0, 14)
}

const base = (type: ElementType, x: number, y: number, z: number) => ({
  id: newId(), type, transform: { ...IDENTITY, x, y }, z, locked: false, hidden: false, pen: 1, name: null,
})

export function makeText(x: number, y: number, z: number, fontId: string | null, text = '双击编辑文字'): Element {
  return {
    ...base('text', x, y, z),
    type: 'text',
    props: {
      text, font_id: fontId, font_mix: null, size_mm: 8, line_height: 1.3, char_space: 0, align: 'L',
      box: { w: 80, h: 24 }, jitter: { ...NO_JITTER }, seed: Math.floor(Math.random() * 10000), missing_glyph: 'box',
    },
  } as Element
}

export function makeFlow(fontId: string | null, text = ''): Element {
  return {
    ...base('flow_text', 0, 0, 0),
    type: 'flow_text',
    name: '正文',
    props: {
      text, font_id: fontId, font_mix: null, text_size: 1, char_space: 0, align: 'L',
      paragraph: { spe_type: 1, spe_value: 8, left: 0, right: 0 }, line_num: null, jitter: { ...NO_JITTER },
      seed: Math.floor(Math.random() * 10000), missing_glyph: 'box',
    },
  } as Element
}

export function makeShape(kind: 'rect' | 'ellipse' | 'line' | 'polygon' | 'grid', x: number, y: number, z: number, w = 40, h = 30): Element {
  const pts = kind === 'line' ? [[0, 0], [w, 0]] : kind === 'polygon' ? [[w / 2, 0], [w, h], [0, h]] : null
  return {
    ...base('shape', x, y, z),
    type: 'shape',
    props: {
      kind, w, h: kind === 'line' ? 0 : h, points: pts, closed: true, rows: kind === 'grid' ? 1 : 1, cols: kind === 'grid' ? 8 : 1,
      grid_style: kind === 'grid' ? 'tian' : 'plain', hatch: null,
    },
  } as Element
}

export interface ImportMeta {
  file_id: string
  file_name: string
  w: number
  h: number
}

export function makeImage(m: ImportMeta & { px_w: number; px_h: number }, x: number, y: number, z: number, width = 60): Element {
  return {
    ...base('image', x, y, z),
    type: 'image',
    props: {
      file_id: m.file_id, file_name: m.file_name, px_w: m.px_w, px_h: m.px_h, mode: 'edge', width_mm: width, invert: false,
      th_low: 0.1, th_high: 0.25, blur: 1.4, binarize: 0.5, min_len: 6, simplify: 0.6, spacing_mm: 1.2, gamma: 1, max_px: 1200,
    },
  } as Element
}

export function makeVector(kind: 'svg' | 'dxf', m: ImportMeta, x: number, y: number, z: number, maxW?: number): Element {
  const width = maxW && m.w > maxW ? maxW : null
  return {
    ...base(kind, x, y, z),
    type: kind,
    props: { file_id: m.file_id, file_name: m.file_name, units: 'auto', width_mm: width, flatten_tol_mm: 0.1, layers: null, stroke_filter: null, native_w: m.w, native_h: m.h },
  } as Element
}

export function makeGcode(m: ImportMeta, x: number, y: number, z: number): Element {
  return {
    ...base('gcode', x, y, z),
    type: 'gcode',
    props: { file_id: m.file_id, file_name: m.file_name, as_paths: true, native_w: m.w, native_h: m.h },
  } as Element
}

export function newPage(): DocPage {
  return { id: newId('p'), paper: null, origin: null, elements: [] }
}

export function emptyDoc(name: string, paperId = 'a4-normal'): ProjectDoc {
  return { version: 1, name, variables: [], paper: { paper_id: paperId, spec: null }, print: {}, pages: [newPage()] }
}

/** Deep clone (structuredClone is missing on iOS < 15.4). */
export function clone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : (JSON.parse(JSON.stringify(v)) as T)
}

/** Page point → machine coordinates (export_transform_mm without rotation). */
export function pageToMachine(o: OriginSpec, w: number, h: number, p: { x: number; y: number }, content?: ContentBox) {
  const op = originPoint(o, w, h, content)
  let x = p.x - op.x
  let y = -(p.y - op.y)
  if (o.revxy) [x, y] = [y, x]
  if (o.x_rev) x = -x
  if (o.y_rev) y = -y
  return { x, y }
}

export type Unit = 'mm' | 'in'
export const toUnit = (mm: number, u: Unit) => (u === 'in' ? mm / 25.4 : mm)
export const fromUnit = (v: number, u: Unit) => (u === 'in' ? v * 25.4 : v)

export function maxZ(page: DocPage) {
  return page.elements.reduce((m, e) => Math.max(m, e.z), -1)
}

export function sortedByZ(els: Element[]) {
  return [...els].sort((a, b) => a.z - b.z)
}

/** Re-number z (0..n-1) keeping order. */
export function normalizeZ(els: Element[]): Element[] {
  return sortedByZ(els).map((e, i) => (e.z === i ? e : { ...e, z: i }))
}

export function hasFlow(page: DocPage) {
  return page.elements.some((e) => e.type === 'flow_text')
}

export function isLetterMode(doc: ProjectDoc) {
  return doc.pages.some(hasFlow)
}

/** Fonts referenced by the doc (for coverage checks). */
export function docText(doc: ProjectDoc): string {
  let t = ''
  for (const p of doc.pages) for (const e of p.elements) if (e.type === 'text' || e.type === 'flow_text') t += e.props.text
  return t
}

/** Find `{{var}}` names used in text props / start-end gcode. */
export function usedVariables(doc: ProjectDoc): string[] {
  const set = new Set<string>()
  const re = /\{\{\s*([\w一-鿿]+)\s*\}\}/g
  const scan = (s: string | null | undefined) => {
    if (!s) return
    for (const m of s.matchAll(re)) set.add(m[1])
  }
  for (const p of doc.pages) for (const e of p.elements) if (e.type === 'text' || e.type === 'flow_text') scan(e.props.text)
  scan(doc.print?.start_gcode)
  scan(doc.print?.end_gcode)
  return [...set]
}

/** Stable key of what affects an element's local paths (transform excluded — 03 §3.3). */
export function elementKey(el: Element, paper: PaperBase, vars: Record<string, string>): string {
  const p = el.type === 'flow_text' ? JSON.stringify([paper.width_mm, paper.height_mm, paper.orientation, paper.margins, paper.ruling]) : ''
  const usesVars = (el.type === 'text' || el.type === 'flow_text') && el.props.text.includes('{{')
  return `${el.type}|${JSON.stringify(el.props)}|${p}|${usesVars ? JSON.stringify(vars) : ''}`
}

export function variableValues(doc: ProjectDoc): Record<string, string> {
  const out: Record<string, string> = {}
  for (const v of doc.variables ?? []) out[v.name] = v.default ?? ''
  return out
}
