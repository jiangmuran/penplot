/** Canvas geometry: element frames, affine transforms, bounding boxes, snapping. Units: mm, page space, y down. */
import type { Element, PaperBase, Transform } from '@/api/studio'
import { paperDims } from './model'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}
export interface Pt {
  x: number
  y: number
}

/** Local (unscaled) content frame of an element. `rendered` = local bbox of the rendered paths, if known. */
export function localBox(el: Element, paper: PaperBase, rendered?: [number, number, number, number] | null): Box {
  const fromRendered = (fallback: Box): Box =>
    rendered ? { x: Math.min(0, rendered[0]), y: Math.min(0, rendered[1]), w: Math.max(1, rendered[2] - Math.min(0, rendered[0])), h: Math.max(1, rendered[3] - Math.min(0, rendered[1])) } : fallback
  switch (el.type) {
    case 'text': {
      const b = el.props.box
      if (b && b.w) return { x: 0, y: 0, w: b.w, h: b.h || el.props.size_mm * el.props.line_height }
      return fromRendered({ x: 0, y: 0, w: 40, h: el.props.size_mm * el.props.line_height })
    }
    case 'flow_text': {
      const { w, h } = paperDims(paper)
      const m = paper.margins
      return { x: m.l, y: m.t, w: Math.max(1, w - m.l - m.r), h: Math.max(1, h - m.t - m.b) }
    }
    case 'shape': {
      const p = el.props
      if ((p.kind === 'line' || p.kind === 'polygon') && p.points?.length) {
        const xs = p.points.map((q) => q[0])
        const ys = p.points.map((q) => q[1])
        const x0 = Math.min(...xs)
        const y0 = Math.min(...ys)
        return { x: x0, y: y0, w: Math.max(0.01, Math.max(...xs) - x0), h: Math.max(0.01, Math.max(...ys) - y0) }
      }
      return { x: 0, y: 0, w: Math.max(0.01, p.w), h: Math.max(0.01, p.h) }
    }
    case 'image': {
      const p = el.props as typeof el.props & { px_w?: number; px_h?: number }
      const ar = p.px_w && p.px_h ? p.px_h / p.px_w : rendered ? (rendered[3] - rendered[1]) / Math.max(1e-6, rendered[2] - rendered[0]) : 0.75
      return { x: 0, y: 0, w: p.width_mm, h: p.width_mm * ar }
    }
    case 'svg':
    case 'dxf': {
      const p = el.props as typeof el.props & { native_w?: number; native_h?: number }
      if (p.native_w && p.native_h) {
        const w = p.width_mm || p.native_w
        return { x: 0, y: 0, w, h: (w * p.native_h) / p.native_w }
      }
      return fromRendered({ x: 0, y: 0, w: p.width_mm || 30, h: p.width_mm || 30 })
    }
    case 'gcode': {
      const p = el.props as typeof el.props & { native_w?: number; native_h?: number }
      if (p.native_w && p.native_h) return { x: 0, y: 0, w: p.native_w, h: p.native_h }
      return fromRendered({ x: 0, y: 0, w: 30, h: 30 })
    }
  }
}

export function scaleOf(t: Transform) {
  return { sx: (t.scale ?? 1) * (t.sx ?? 1), sy: (t.scale ?? 1) * (t.sy ?? 1) }
}

/** SVG transform string for an element (page = T · R · S · local). */
export function svgTransform(t: Transform) {
  const { sx, sy } = scaleOf(t)
  return `translate(${t.x} ${t.y}) rotate(${t.rotation || 0}) scale(${sx} ${sy})`
}

export function rot(p: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

/** Local point → page. */
export function toPage(t: Transform, p: Pt): Pt {
  const { sx, sy } = scaleOf(t)
  const q = rot({ x: p.x * sx, y: p.y * sy }, t.rotation || 0)
  return { x: q.x + t.x, y: q.y + t.y }
}

/** Page point → rotation frame of the element (scaled local, origin at transform x/y). */
export function toFrame(t: Transform, p: Pt): Pt {
  return rot({ x: p.x - t.x, y: p.y - t.y }, -(t.rotation || 0))
}

/** The element frame in its rotation frame (scaled local box). */
export function frameBox(t: Transform, b: Box): Box {
  const { sx, sy } = scaleOf(t)
  const x0 = b.x * sx
  const x1 = (b.x + b.w) * sx
  const y0 = b.y * sy
  const y1 = (b.y + b.h) * sy
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
}

export function corners(t: Transform, b: Box): Pt[] {
  return [
    toPage(t, { x: b.x, y: b.y }),
    toPage(t, { x: b.x + b.w, y: b.y }),
    toPage(t, { x: b.x + b.w, y: b.y + b.h }),
    toPage(t, { x: b.x, y: b.y + b.h }),
  ]
}

export function aabb(pts: Pt[]): Box {
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  const x0 = Math.min(...boxes.map((b) => b.x))
  const y0 = Math.min(...boxes.map((b) => b.y))
  const x1 = Math.max(...boxes.map((b) => b.x + b.w))
  const y1 = Math.max(...boxes.map((b) => b.y + b.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function intersects(a: Box, b: Box) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}
export function contains(outer: Box, inner: Box, tol = 0.25) {
  return inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol
}

// ------------------------------------------------------------------ snapping

export interface SnapLine {
  axis: 'x' | 'y'
  at: number
  label?: string
}

export interface SnapTargets {
  xs: { v: number; label?: string }[]
  ys: { v: number; label?: string }[]
}

export function paperTargets(paper: PaperBase): SnapTargets {
  const { w, h } = paperDims(paper)
  const m = paper.margins
  return {
    xs: [{ v: 0, label: '纸边' }, { v: w, label: '纸边' }, { v: w / 2, label: '中线' }, { v: m.l, label: '边距' }, { v: w - m.r, label: '边距' }],
    ys: [{ v: 0, label: '纸边' }, { v: h, label: '纸边' }, { v: h / 2, label: '中线' }, { v: m.t, label: '边距' }, { v: h - m.b, label: '边距' }],
  }
}

export function boxTargets(boxes: Box[]): SnapTargets {
  const xs: SnapTargets['xs'] = []
  const ys: SnapTargets['ys'] = []
  for (const b of boxes) {
    xs.push({ v: b.x }, { v: b.x + b.w / 2 }, { v: b.x + b.w })
    ys.push({ v: b.y }, { v: b.y + b.h / 2 }, { v: b.y + b.h })
  }
  return { xs, ys }
}

/** Snap a moving box. Returns the delta to add and the guide lines to draw. */
export function snapBox(b: Box, targets: SnapTargets, tol: number, grid: number | null): { dx: number; dy: number; lines: SnapLine[] } {
  const pick = (vals: number[], cands: { v: number; label?: string }[]) => {
    let best: { d: number; at: number; label?: string } | null = null
    for (const v of vals) {
      for (const c of cands) {
        const d = c.v - v
        if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: c.v, label: c.label }
      }
    }
    return best
  }
  const sx = pick([b.x, b.x + b.w / 2, b.x + b.w], targets.xs)
  const sy = pick([b.y, b.y + b.h / 2, b.y + b.h], targets.ys)
  const lines: SnapLine[] = []
  let dx = 0
  let dy = 0
  if (sx) {
    dx = sx.d
    lines.push({ axis: 'x', at: sx.at, label: sx.label })
  } else if (grid) dx = Math.round(b.x / grid) * grid - b.x
  if (sy) {
    dy = sy.d
    lines.push({ axis: 'y', at: sy.at, label: sy.label })
  } else if (grid) dy = Math.round(b.y / grid) * grid - b.y
  return { dx, dy, lines }
}

export const round2 = (v: number) => Math.round(v * 100) / 100
export const fmtMm = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—')

/** Polylines (flat xy arrays) → SVG path data. */
export function polylinesToD(lines: Float32Array[]): string {
  const parts: string[] = []
  for (const l of lines) {
    if (l.length < 2) continue
    let s = `M${l[0].toFixed(2)} ${l[1].toFixed(2)}`
    if (l.length === 2) s += `l0.01 0`
    for (let i = 2; i < l.length; i += 2) s += `L${l[i].toFixed(2)} ${l[i + 1].toFixed(2)}`
    parts.push(s)
  }
  return parts.join('')
}

export function polylinesBBox(lines: Float32Array[]): [number, number, number, number] | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const l of lines) {
    for (let i = 0; i < l.length; i += 2) {
      if (l[i] < x0) x0 = l[i]
      if (l[i] > x1) x1 = l[i]
      if (l[i + 1] < y0) y0 = l[i + 1]
      if (l[i + 1] > y1) y1 = l[i + 1]
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null
}

/** Travel moves (pen up) between consecutive polylines as SVG path data. */
export function travelD(lines: Float32Array[], start: Pt | null): string {
  const parts: string[] = []
  let px = start?.x ?? null
  let py = start?.y ?? null
  for (const l of lines) {
    if (l.length < 2) continue
    if (px != null && py != null) parts.push(`M${px.toFixed(2)} ${py.toFixed(2)}L${l[0].toFixed(2)} ${l[1].toFixed(2)}`)
    px = l[l.length - 2]
    py = l[l.length - 1]
  }
  return parts.join('')
}
