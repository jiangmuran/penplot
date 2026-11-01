/**
 * Dragging the writing origin (where the pen is parked, raised, before a job starts).
 * The origin is data (OriginSpec): corner + inward offsets from that corner of the PAPER (anchor 'paper') or of the
 * drawing's bounding box (anchor 'content'). Dragging the marker to page point P solves those offsets, so the
 * backend's export_transform_mm puts machine (0,0) exactly at P. Written to the page's own origin when the page has
 * one, else to the project's print origin.
 */
import * as React from 'react'
import type { OriginSpec, PaperBase } from '@/api/studio'
import { bgSnapPoints, type PageBackground } from './background'
import type { Box, Pt } from './geometry'
import { originAnchor, originPoint, paperDims, type ContentBox } from './model'
import { useStudio } from './store'

const CORNER = ['左上', '右上', '左下', '右下'] as const
const r2 = (v: number) => Math.round(v * 100) / 100

/** Offsets that put the origin marker at page point p (inverse of originPoint). */
export function offsetsAt(o: OriginSpec, w: number, h: number, p: Pt, content?: ContentBox) {
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
  return { offset_x_mm: r2(right ? x1 - p.x : p.x - x0), offset_y_mm: r2(bottom ? y1 - p.y : p.y - y0) }
}

export interface SnapPoint {
  p: Pt
  label: string
}

/** Points the origin likes to land on: paper corners, margin corners, drawing/element corners, background features. */
export function originSnapPoints(paper: PaperBase, boxes: { box: Box; label: string }[], bg: PageBackground | null | undefined): SnapPoint[] {
  const { w, h } = paperDims(paper)
  const m = paper.margins
  const out: SnapPoint[] = []
  for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) out.push({ p: { x, y }, label: '纸张角' })
  for (const [x, y] of [[m.l, m.t], [w - m.r, m.t], [m.l, h - m.b], [w - m.r, h - m.b]]) out.push({ p: { x, y }, label: '边距角' })
  for (const { box: b, label } of boxes) {
    for (const [x, y] of [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.h], [b.x + b.w, b.y + b.h]]) out.push({ p: { x, y }, label })
  }
  if (bg && bg.visible) out.push(...bgSnapPoints(bg))
  return out
}

/** Axis lines (paper edges, margins) for one-axis snapping. */
export function originSnapLines(paper: PaperBase) {
  const { w, h } = paperDims(paper)
  const m = paper.margins
  return {
    xs: [{ v: 0, label: '纸边' }, { v: w, label: '纸边' }, { v: m.l, label: '边距' }, { v: w - m.r, label: '边距' }, { v: w / 2, label: '中线' }],
    ys: [{ v: 0, label: '纸边' }, { v: h, label: '纸边' }, { v: m.t, label: '边距' }, { v: h - m.b, label: '边距' }, { v: h / 2, label: '中线' }],
  }
}

/** Snap p: a nearby point wins; else each axis to a line; else 0.5 mm grid. `tol` in mm. */
export function snapOrigin(p: Pt, pts: SnapPoint[], lines: ReturnType<typeof originSnapLines>, tol: number): { p: Pt; label: string | null } {
  let best: SnapPoint | null = null
  let bd = tol
  for (const s of pts) {
    const d = Math.hypot(s.p.x - p.x, s.p.y - p.y)
    if (d <= bd) {
      bd = d
      best = s
    }
  }
  if (best) return { p: { ...best.p }, label: best.label }
  let x = Math.round(p.x * 2) / 2
  let y = Math.round(p.y * 2) / 2
  const labels: string[] = []
  const lx = lines.xs.find((l) => Math.abs(l.v - p.x) <= tol)
  const ly = lines.ys.find((l) => Math.abs(l.v - p.y) <= tol)
  if (lx) {
    x = lx.v
    labels.push(lx.label)
  }
  if (ly) {
    y = ly.v
    labels.push(ly.label)
  }
  return { p: { x, y }, label: labels.length ? labels.join(' · ') : null }
}

/** Write offsets: the page's own origin if it has one, else the project print origin. `live` = no history entry. */
export function applyOriginOffsets(effective: OriginSpec, offs: { offset_x_mm: number; offset_y_mm: number }, live: boolean) {
  const s = useStudio.getState()
  const pi = s.view.page
  s.edit((d) => {
    const page = d.pages[pi]
    if (page?.origin) page.origin = { ...page.origin, ...offs }
    else d.print = { ...d.print, origin: { ...effective, ...(d.print?.origin ?? {}), ...offs } }
  }, live ? { record: false } : { coalesce: 'origin' })
}

/** What the operator must do physically, in words. */
export function parkText(o: OriginSpec, w: number, h: number, content?: ContentBox, short = false): string {
  const p = originPoint(o, w, h, content)
  const right = o.corner === 1 || o.corner === 3
  const bottom = o.corner === 2 || o.corner === 3
  const dx = right ? w - p.x : p.x
  const dy = bottom ? h - p.y : p.y
  const where = `距纸${right ? '右' : '左'}边 ${dx.toFixed(1)} mm、${bottom ? '下' : '上'}边 ${dy.toFixed(1)} mm`
  if (short) return where
  const anchor = originAnchor(o) === 'content' ? `要写内容的${CORNER[o.corner]}角` : `纸张${CORNER[o.corner]}角`
  const off = o.offset_x_mm || o.offset_y_mm ? `（${anchor}向内 ${o.offset_x_mm}, ${o.offset_y_mm} mm）` : `（${anchor}）`
  return `把笔停在这里，抬笔：${where}${off}`
}

/**
 * Pointer handlers for dragging an origin marker inside an SVG whose user units are page mm
 * (position preview, print-sheet thumbnail). Returns props for the marker's hit target.
 */
export function useSvgOriginDrag(opts: {
  svg: React.RefObject<SVGSVGElement | null>
  origin: OriginSpec
  w: number
  h: number
  content?: ContentBox
  snap: SnapPoint[]
  lines: ReturnType<typeof originSnapLines>
  /** snap tolerance in screen px */
  tolPx?: number
  disabled?: boolean
}) {
  const [drag, setDrag] = React.useState<{ label: string | null } | null>(null)
  const st = React.useRef<{ moved: boolean } | null>(null)
  const toSvg = (e: React.PointerEvent) => {
    const svg = opts.svg.current
    const m = svg?.getScreenCTM()
    if (!svg || !m) return null
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
    return { p: { x: pt.x, y: pt.y }, k: 1 / Math.max(1e-6, m.a) }
  }
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (opts.disabled) return
      e.stopPropagation()
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      st.current = { moved: false }
      setDrag({ label: null })
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!st.current) return
      const r = toSvg(e)
      if (!r) return
      if (!st.current.moved) {
        st.current.moved = true
        useStudio.getState().checkpoint()
      }
      const sn = e.altKey ? { p: r.p, label: null } : snapOrigin(r.p, opts.snap, opts.lines, (opts.tolPx ?? 10) * r.k)
      applyOriginOffsets(opts.origin, offsetsAt(opts.origin, opts.w, opts.h, sn.p, opts.content), true)
      setDrag({ label: sn.label })
    },
    onPointerUp: () => {
      st.current = null
      setDrag(null)
    },
    onPointerCancel: () => {
      st.current = null
      setDrag(null)
    },
  }
  return { handlers, dragging: !!drag, label: drag?.label ?? null }
}
