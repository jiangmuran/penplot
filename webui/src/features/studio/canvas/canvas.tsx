/**
 * Composition canvas (02-ux §3.1): SVG world in page mm (pan/zoom), paper + margins, machine travel area,
 * origin/axes, elements (backend-rendered local paths + client transform), selection with 8 resize handles +
 * rotate handle, snapping guides, marquee, creation tools, rulers, pinch/wheel zoom.
 */
import * as React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useLive } from '@/api/store'
import type { Element, OriginSpec, PaperBase } from '@/api/studio'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui'
import { useCoarsePointer, useReducedMotion } from '@/lib/media'
import { isMac } from '@/lib/platform'
import {
  align, contentBox, copySelection, deleteSelection, duplicateSelection, elementAABB, insertShape, insertText, lastKeys, paste, selectAll,
  toggleHidden, toggleLock, zOrder,
} from '../actions'
import {
  aabb, boxTargets, contains, corners, frameBox, intersects, localBox, paperTargets, rot, scaleOf, snapBox, toFrame,
  travelD, union, type Box, type Pt, type SnapLine,
} from '../geometry'
import { machineAxes, makeShape, maxZ, originPoint, paperDims, sortedByZ, workAreaRect } from '../model'
import { outputIndex, pagePolylines, useRender } from '../render-engine'
import { currentPage, studio, useStudio } from '../store'
import { useCollab } from '../collab'
import { ElementView, useElementRender } from './element-view'
import { Guides, HANDLES, handlePoint, OriginOverlay, RULER, Rulers, SelectionFrame, sx, sy, type Handle, type Viewport } from './overlays'
import { StrokeAnimation } from './stroke-anim'
import { aroundPivot, bgCorners, imgToPage, liveBackground, normDeg, pageToImg, type PageBackground } from '../background'
import { applyOriginOffsets, offsetsAt, originSnapLines, originSnapPoints, parkText, snapOrigin } from '../origin-drag'
import { BackgroundImage } from './background-layer'

export const MM_100 = 96 / 25.4 // px per mm at 100 %

type Gesture =
  | { kind: 'pan'; x: number; y: number; panX: number; panY: number }
  | { kind: 'move'; start: Pt; ids: string[]; orig: Map<string, Element>; box: Box; moved: boolean; others: Box[] }
  | { kind: 'resize'; id: string; handle: Handle; orig: Element; frame: Box; lb: Box; moved: boolean }
  | { kind: 'rotate'; id: string; orig: Element; center: Pt; c: Pt; a0: number; moved: boolean }
  | { kind: 'marquee'; start: Pt; cur: Pt; additive: boolean; base: string[] }
  | { kind: 'create'; tool: 'text' | 'rect' | 'ellipse' | 'line'; start: Pt; cur: Pt }
  | { kind: 'pinch'; d0: number; mid0: Pt; zoom0: number; panX: number; panY: number }
  | { kind: 'origin'; moved: boolean }
  | { kind: 'bgmove'; start: Pt; orig: PageBackground; moved: boolean }
  | { kind: 'bgscale'; orig: PageBackground; c: Pt; d0: number; moved: boolean }
  | { kind: 'bgrotate'; orig: PageBackground; c: Pt; a0: number; moved: boolean }
  | { kind: 'bgpinch'; orig: PageBackground; a0: Pt; b0: Pt; moved: boolean }

export interface CanvasProps {
  paper: PaperBase
  origin: OriginSpec
  workArea: { w_mm: number; h_mm: number } | null
  /** Extra bottom inset (compact toolbars over the canvas). */
  insetBottom?: number
  onRequestTextEdit?: (id: string) => void
}

export function Canvas({ paper, origin, workArea, insetBottom = 0, onRequestTextEdit }: CanvasProps) {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const svgRef = React.useRef<SVGSVGElement>(null)
  const [size, setSize] = React.useState({ width: 800, height: 600 })
  const touch = useCoarsePointer()
  const reduced = useReducedMotion()
  const st = useStudio(
    useShallow((s) => ({
      doc: s.doc, view: s.view, selection: s.selection, tool: s.tool, spaceHand: s.spaceHand, zoom: s.zoom, overlays: s.overlays,
      fitRequest: s.fitRequest, animate: s.animate, bgAlign: s.bgAlign, bgCalib: s.bgCalib, bgTouch: s.bgTouch, readOnly: s.readOnly,
    })),
  )
  const page = st.doc?.pages[st.view.page] ?? null
  const { w: pw, h: ph } = paperDims(paper)
  const v: Viewport = { zoom: st.zoom.zoom, panX: st.zoom.panX, panY: st.zoom.panY, width: size.width, height: size.height }
  const [guides, setGuides] = React.useState<SnapLine[]>([])
  const [marquee, setMarquee] = React.useState<Box | null>(null)
  const [creating, setCreating] = React.useState<{ tool: string; box: Box; line?: [Pt, Pt] } | null>(null)
  const [hover, setHover] = React.useState<string | null>(null)
  const [liveLabel, setLiveLabel] = React.useState<string | null>(null)
  const [originLabel, setOriginLabel] = React.useState<string | null>(null)
  const peers = useCollab((s) => s.peers)
  const gesture = React.useRef<Gesture | null>(null)
  const pointers = React.useRef(new Map<number, Pt>())

  // ---------------------------------------------------------------- size + fit
  React.useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }))
    ro.observe(el)
    setSize({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const fit = React.useCallback(() => {
    const el = hostRef.current
    if (!el) return
    const W = el.clientWidth
    const H = el.clientHeight - insetBottom
    const pad = touch ? 28 : 48
    const left = st.overlays.rulers && !touch ? RULER : 0
    const z = Math.max(0.2, Math.min((W - left - pad * 2) / pw, (H - left - pad * 2 - 24) / ph))
    useStudio.getState().setZoom({ zoom: z, panX: left + (W - left - pw * z) / 2, panY: left + (H - left - ph * z) / 2 - 8 })
  }, [pw, ph, insetBottom, touch, st.overlays.rulers])

  const lastFit = React.useRef(-1)
  React.useEffect(() => {
    if (size.width < 50) return
    if (lastFit.current !== st.fitRequest) {
      lastFit.current = st.fitRequest
      fit()
    }
  }, [st.fitRequest, size.width, fit])
  // refit when paper dims change
  React.useEffect(() => {
    useStudio.getState().requestFit()
  }, [pw, ph])

  // ---------------------------------------------------------------- derived geometry
  const els = React.useMemo(() => (page ? sortedByZ(page.elements) : []), [page])
  const cbox = page && st.view.sub === 0 ? contentBox(page.elements, paper) : null
  const work = workArea ? workAreaRect(origin, pw, ph, workArea.w_mm, workArea.h_mm, cbox) : null
  const paperBox: Box = { x: 0, y: 0, w: pw, h: ph }
  const sel = st.view.sub === 0 && !st.bgAlign ? els.filter((e) => st.selection.includes(e.id)) : []
  const bg = page?.background ?? null
  const align = st.bgAlign && !!bg

  const toWorld = React.useCallback((clientX: number, clientY: number): Pt => {
    const r = svgRef.current!.getBoundingClientRect()
    const z = useStudio.getState().zoom
    return { x: (clientX - r.left - z.panX) / z.zoom, y: (clientY - r.top - z.panY) / z.zoom }
  }, [])

  // ---------------------------------------------------------------- wheel zoom / pan
  React.useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const z = useStudio.getState().zoom
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect()
        const mx = e.clientX - r.left
        const my = e.clientY - r.top
        const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025))
        const zoom = Math.min(80, Math.max(0.15, z.zoom * k))
        const f = zoom / z.zoom
        useStudio.getState().setZoom({ zoom, panX: mx - (mx - z.panX) * f, panY: my - (my - z.panY) * f })
      } else {
        const m = e.deltaMode === 1 ? 16 : 1
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY
        useStudio.getState().setZoom({ ...z, panX: z.panX - dx * m, panY: z.panY - dy * m })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---------------------------------------------------------------- gestures
  const snapOn = (e: { metaKey: boolean; ctrlKey: boolean }) => st.overlays.snap && !(isMac ? e.metaKey : e.ctrlKey)

  const onPointerDown = (e: React.PointerEvent) => {
    if (!page) return
    const target = e.target as Element & SVGElement
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
    hostRef.current?.focus({ preventScroll: true })
    // align mode: two fingers rotate/scale/move the background (unless the view mode is chosen)
    if (pointers.current.size === 2 && align && bg && !bg.locked && st.bgTouch === 'bg') {
      const [a, b] = [...pointers.current.values()]
      gesture.current = { kind: 'bgpinch', orig: bg, a0: toWorld(a.x, a.y), b0: toWorld(b.x, b.y), moved: false }
      return
    }
    // pinch with two touch pointers
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const z = useStudio.getState().zoom
      const r = svgRef.current!.getBoundingClientRect()
      gesture.current = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), mid0: { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }, zoom0: z.zoom, panX: z.panX, panY: z.panY }
      return
    }
    const p = toWorld(e.clientX, e.clientY)
    const tool = st.tool
    const elId = (target.closest?.('[data-el-id]') as SVGElement | null)?.getAttribute('data-el-id') ?? null
    const handle = (target.closest?.('[data-handle]') as SVGElement | null)?.getAttribute('data-handle') ?? null

    if (e.button === 2) {
      if (elId && !st.selection.includes(elId)) studio.get().select([elId])
      return
    }
    if (e.button === 1 || tool === 'hand' || st.spaceHand) {
      gesture.current = { kind: 'pan', x: e.clientX, y: e.clientY, panX: v.panX, panY: v.panY }
      return
    }
    if (align && bg) {
      const calib = st.bgCalib
      if (calib && (calib.step === 'a' || calib.step === 'b')) {
        const q = pageToImg(bg, p)
        const qq = { x: Math.round(q.x * 10) / 10, y: Math.round(q.y * 10) / 10 }
        useStudio.getState().setBgCalib(calib.step === 'a' ? { step: 'b', a: qq } : { ...calib, step: 'dist', b: qq })
        return
      }
      const pan = () => (gesture.current = { kind: 'pan', x: e.clientX, y: e.clientY, panX: v.panX, panY: v.panY })
      if (bg.locked || (e.pointerType === 'touch' && st.bgTouch === 'view')) return void pan()
      const c = { x: bg.transform.x, y: bg.transform.y }
      if (handle === 'bg-rotate') gesture.current = { kind: 'bgrotate', orig: bg, c, a0: Math.atan2(p.y - c.y, p.x - c.x), moved: false }
      else if (handle === 'bg-scale') gesture.current = { kind: 'bgscale', orig: bg, c, d0: Math.max(1e-6, Math.hypot(p.x - c.x, p.y - c.y)), moved: false }
      else gesture.current = { kind: 'bgmove', start: p, orig: bg, moved: false }
      return
    }
    if (handle === 'origin' && !st.readOnly) {
      gesture.current = { kind: 'origin', moved: false }
      return
    }
    if (handle && sel.length === 1) {
      const el = sel[0]
      const lb = localBox(el, paper, renderedBBox(el))
      const frame = frameBox(el.transform, lb)
      if (handle === 'rotate') {
        const c = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 }
        const rc = rot(c, el.transform.rotation || 0)
        const center = { x: el.transform.x + rc.x, y: el.transform.y + rc.y }
        gesture.current = { kind: 'rotate', id: el.id, orig: el, center, c, a0: Math.atan2(p.y - center.y, p.x - center.x), moved: false }
      } else {
        gesture.current = { kind: 'resize', id: el.id, handle: handle as Handle, orig: el, frame, lb, moved: false }
      }
      return
    }
    if (tool === 'text' || tool === 'rect' || tool === 'ellipse' || tool === 'line') {
      gesture.current = { kind: 'create', tool, start: p, cur: p }
      return
    }
    if (elId) {
      let ids = st.selection
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        studio.get().toggleSelect(elId)
        return
      }
      if (!ids.includes(elId)) {
        ids = [elId]
        studio.get().select(ids)
      }
      const moving = els.filter((x) => ids.includes(x.id) && !x.locked)
      if (!moving.length) return
      const boxes = moving.map((x) => elementAABB(x, paper))
      const others = els.filter((x) => !ids.includes(x.id) && !x.hidden).map((x) => elementAABB(x, paper))
      gesture.current = { kind: 'move', start: p, ids: moving.map((x) => x.id), orig: new Map(moving.map((x) => [x.id, x])), box: union(boxes)!, moved: false, others }
      return
    }
    // blank area
    if (e.pointerType === 'touch') {
      gesture.current = { kind: 'pan', x: e.clientX, y: e.clientY, panX: v.panX, panY: v.panY }
      if (!e.shiftKey) studio.get().select([])
      return
    }
    gesture.current = { kind: 'marquee', start: p, cur: p, additive: e.shiftKey, base: e.shiftKey ? st.selection : [] }
    if (!e.shiftKey) studio.get().select([])
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) {
      const id = ((e.target as SVGElement).closest?.('[data-el-id]') as SVGElement | null)?.getAttribute('data-el-id') ?? null
      if (id !== hover) setHover(id)
      return
    }
    const p = toWorld(e.clientX, e.clientY)
    const z = useStudio.getState().zoom
    switch (g.kind) {
      case 'pinch': {
        if (pointers.current.size < 2) return
        const [a, b] = [...pointers.current.values()]
        const r = svgRef.current!.getBoundingClientRect()
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }
        const zoom = Math.min(80, Math.max(0.15, g.zoom0 * (d / g.d0)))
        const f = zoom / g.zoom0
        useStudio.getState().setZoom({ zoom, panX: mid.x - (g.mid0.x - g.panX) * f, panY: mid.y - (g.mid0.y - g.panY) * f })
        return
      }
      case 'pan':
        useStudio.getState().setZoom({ ...z, panX: g.panX + e.clientX - g.x, panY: g.panY + e.clientY - g.y })
        return
      case 'origin': {
        if (!g.moved) {
          g.moved = true
          studio.get().checkpoint()
        }
        const boxes = els.filter((x) => !x.hidden).map((x) => ({ box: elementAABB(x, paper), label: '元素角' }))
        if (cbox) boxes.push({ box: cbox, label: '内容角' })
        const sn = snapOn(e) ? snapOrigin(p, originSnapPoints(paper, boxes, bg), originSnapLines(paper), 8 / z.zoom) : { p, label: null }
        applyOriginOffsets(origin, offsetsAt(origin, pw, ph, sn.p, cbox), true)
        setOriginLabel(sn.label)
        return
      }
      case 'bgmove': {
        let dx = p.x - g.start.x
        let dy = p.y - g.start.y
        if (!g.moved && Math.hypot(dx, dy) * z.zoom < 3) return
        if (!g.moved) {
          g.moved = true
          studio.get().checkpoint()
        }
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        let lines: SnapLine[] = []
        if (snapOn(e)) {
          const cs = bgCorners({ ...g.orig, transform: { ...g.orig.transform, x: g.orig.transform.x + dx, y: g.orig.transform.y + dy } })
          const moved = aabb(cs)
          const snap = snapBox(moved, paperTargets(paper), 6 / z.zoom, null)
          dx += snap.dx
          dy += snap.dy
          lines = snap.lines
        }
        setGuides(lines)
        liveBackground({ ...g.orig.transform, x: r3(g.orig.transform.x + dx), y: r3(g.orig.transform.y + dy) })
        setLiveLabel(`中心 X ${(g.orig.transform.x + dx).toFixed(1)}  Y ${(g.orig.transform.y + dy).toFixed(1)}`)
        return
      }
      case 'bgscale': {
        if (!g.moved) {
          g.moved = true
          studio.get().checkpoint()
        }
        const k = Math.max(0.02, Math.hypot(p.x - g.c.x, p.y - g.c.y) / g.d0)
        const t = { ...g.orig.transform, scale: g.orig.transform.scale * k }
        liveBackground(t)
        setLiveLabel(`${(g.orig.px_w * t.scale).toFixed(1)} × ${(g.orig.px_h * t.scale).toFixed(1)} mm`)
        return
      }
      case 'bgrotate': {
        if (!g.moved) {
          g.moved = true
          studio.get().checkpoint()
        }
        const a = Math.atan2(p.y - g.c.y, p.x - g.c.x)
        let deg = g.orig.transform.rotation + ((a - g.a0) * 180) / Math.PI
        if (e.shiftKey) deg = Math.round(deg / 15) * 15
        else if (Math.abs(deg - Math.round(deg / 90) * 90) < 1.5) deg = Math.round(deg / 90) * 90
        else deg = Math.round(deg * 10) / 10
        liveBackground({ ...g.orig.transform, rotation: normDeg(deg) })
        setLiveLabel(`${normDeg(deg).toFixed(1)}°`)
        return
      }
      case 'bgpinch': {
        if (pointers.current.size < 2) return
        if (!g.moved) {
          g.moved = true
          studio.get().checkpoint()
        }
        const [ca, cb] = [...pointers.current.values()]
        const a1 = toWorld(ca.x, ca.y)
        const b1 = toWorld(cb.x, cb.y)
        const d0 = Math.max(1e-6, Math.hypot(g.b0.x - g.a0.x, g.b0.y - g.a0.y))
        const k = Math.hypot(b1.x - a1.x, b1.y - a1.y) / d0
        const da = ((Math.atan2(b1.y - a1.y, b1.x - a1.x) - Math.atan2(g.b0.y - g.a0.y, g.b0.x - g.a0.x)) * 180) / Math.PI
        let deg = g.orig.transform.rotation + da
        if (Math.abs(deg - Math.round(deg / 90) * 90) < 2) deg = Math.round(deg / 90) * 90
        // the image point under the first finger's start stays under the moving midpoint of the fingers
        const m0 = { x: (g.a0.x + g.b0.x) / 2, y: (g.a0.y + g.b0.y) / 2 }
        const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 }
        const q = pageToImg(g.orig, m0)
        const t0 = aroundPivot(g.orig, g.orig.transform.scale * k, deg, m0)
        const placed = imgToPage({ ...g.orig, transform: t0 }, q)
        liveBackground({ ...t0, x: r3(t0.x + m1.x - placed.x), y: r3(t0.y + m1.y - placed.y) })
        setLiveLabel(`${normDeg(deg).toFixed(1)}° · ${(g.orig.px_w * t0.scale).toFixed(0)} mm 宽`)
        return
      }
      case 'marquee': {
        g.cur = p
        const box = aabb([g.start, p])
        setMarquee(box)
        const hit = els.filter((x) => !x.locked && intersects(elementAABB(x, paper), box)).map((x) => x.id)
        studio.get().select([...new Set([...g.base, ...hit])])
        return
      }
      case 'create': {
        g.cur = p
        const b = aabb([g.start, p])
        setCreating({ tool: g.tool, box: b, line: g.tool === 'line' ? [g.start, p] : undefined })
        return
      }
      case 'move': {
        let dx = p.x - g.start.x
        let dy = p.y - g.start.y
        if (!g.moved && Math.hypot(dx, dy) * z.zoom < 3) return
        if (!g.moved) {
          g.moved = true
          studio.get().checkpoint()
        }
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        let lines: SnapLine[] = []
        if (snapOn(e)) {
          const moved = { ...g.box, x: g.box.x + dx, y: g.box.y + dy }
          const t = paperTargets(paper)
          const o = boxTargets(g.others)
          const snap = snapBox(moved, { xs: [...t.xs, ...o.xs], ys: [...t.ys, ...o.ys] }, 6 / z.zoom, st.overlays.grid ? 1 : null)
          dx += snap.dx
          dy += snap.dy
          lines = snap.lines
        }
        setGuides(lines)
        const patches = new Map<string, Partial<Element>>()
        for (const [id, el] of g.orig) patches.set(id, { transform: { ...el.transform, x: r3(el.transform.x + dx), y: r3(el.transform.y + dy) } })
        studio.patchLive(patches)
        setLiveLabel(`X ${(g.box.x + dx).toFixed(1)}  Y ${(g.box.y + dy).toFixed(1)}`)
        return
      }
      case 'resize': {
        if (!g.moved) {
          g.moved = true
          studio.get().checkpoint()
        }
        const patch = resizePatch(g, p, e.shiftKey || g.orig.type === 'gcode', e.altKey)
        studio.patchLive(new Map([[g.id, patch]]))
        const t = patch.transform ?? g.orig.transform
        const fb = frameBox(t, localBox({ ...g.orig, ...patch } as Element, paper, renderedBBox(g.orig)))
        setLiveLabel(`${fb.w.toFixed(1)} × ${fb.h.toFixed(1)} mm`)
        return
      }
      case 'rotate': {
        const a = Math.atan2(p.y - g.center.y, p.x - g.center.x)
        let deg = (g.orig.transform.rotation || 0) + ((a - g.a0) * 180) / Math.PI
        deg = ((deg % 360) + 540) % 360 - 180
        if (e.shiftKey) deg = Math.round(deg / 15) * 15
        else if (Math.abs(deg - Math.round(deg / 90) * 90) < 2) deg = Math.round(deg / 90) * 90
        if (!g.moved) {
          g.moved = true
          studio.get().checkpoint()
        }
        const rc = rot(g.c, deg)
        studio.patchLive(new Map([[g.id, { transform: { ...g.orig.transform, rotation: r3(deg), x: r3(g.center.x - rc.x), y: r3(g.center.y - rc.y) } }]]))
        setLiveLabel(`${deg.toFixed(0)}°`)
        return
      }
    }
  }

  const endGesture = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId)
    const g = gesture.current
    gesture.current = null
    setGuides([])
    setMarquee(null)
    setLiveLabel(null)
    setOriginLabel(null)
    if (!g) return
    if (g.kind === 'create') {
      setCreating(null)
      const b = aabb([g.start, g.cur])
      const small = Math.max(b.w, b.h) < 2
      if (g.tool === 'text') insertText(small ? g.start : { x: b.x, y: b.y }, small ? undefined : { w: b.w, h: b.h })
      else if (g.tool === 'line') {
        if (small) insertShape('line', g.start, { w: 40, h: 0 })
        else {
          const el = makeShape('line', g.start.x, g.start.y, maxZ(page!) + 1, 0, 0)
          if (el.type === 'shape') {
            el.props.points = [[0, 0], [r3(g.cur.x - g.start.x), r3(g.cur.y - g.start.y)]]
            el.props.w = Math.abs(g.cur.x - g.start.x)
            el.props.h = Math.abs(g.cur.y - g.start.y)
          }
          studio.addElements([el])
          useStudio.setState({ tool: 'select' })
        }
      } else insertShape(g.tool, small ? g.start : { x: b.x, y: b.y }, small ? undefined : { w: b.w, h: b.h })
    }
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const id = ((e.target as SVGElement).closest?.('[data-el-id]') as SVGElement | null)?.getAttribute('data-el-id') ?? null
    const el = id ? els.find((x) => x.id === id) : null
    if (el && (el.type === 'text' || el.type === 'flow_text')) {
      useStudio.setState({ selection: [el.id], editTextOf: el.id })
      onRequestTextEdit?.(el.id)
      return
    }
    if (!id) {
      const z = useStudio.getState().zoom
      if (Math.abs(z.zoom - MM_100) < 0.01) fit()
      else {
        const p = toWorld(e.clientX, e.clientY)
        const r = svgRef.current!.getBoundingClientRect()
        useStudio.getState().setZoom({ zoom: MM_100, panX: e.clientX - r.left - p.x * MM_100, panY: e.clientY - r.top - p.y * MM_100 })
      }
    }
  }

  // ---------------------------------------------------------------- bounds warnings
  const bounds = React.useMemo(() => {
    const m = new Map<string, { box: Box; outPaper: boolean; outWork: boolean }>()
    for (const el of els) {
      if (el.hidden) continue
      const box = elementAABB(el, paper)
      m.set(el.id, { box, outPaper: !contains(paperBox, box), outWork: !!work && !contains(work, box, 1) })
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [els, paper, work?.x, work?.y, work?.w, work?.h, useRender((s) => s.els)])

  // ---------------------------------------------------------------- page render overlays
  const pageRender = useRender((s) => s.page)
  const outIdx = outputIndex(pageRender.result, st.view.page, st.view.sub)
  const [travel, setTravel] = React.useState<string | null>(null)
  React.useEffect(() => {
    setTravel(null)
    if (!st.overlays.travel || !pageRender.result || outIdx == null) return
    let alive = true
    const o = originPoint(origin, pw, ph, cbox)
    pagePolylines(pageRender.result.rid, outIdx)
      .then((pl) => alive && setTravel(travelD(pl, o)))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [st.overlays.travel, pageRender.result, outIdx, origin, pw, ph, cbox?.x, cbox?.y, cbox?.w, cbox?.h]) // eslint-disable-line react-hooks/exhaustive-deps

  // pen position (live)
  const machine = useLive(useShallow((s) => ({ wpos: s.machine?.wpos, ok: !!s.machine?.connected && !!s.machine?.origin_valid })))
  let penPt: Pt | null = null
  if (machine.ok && machine.wpos) {
    const o = originPoint(origin, pw, ph, cbox)
    const ax = machineAxes(origin)
    penPt = { x: o.x + machine.wpos[0] * ax.x.x + machine.wpos[1] * ax.y.x, y: o.y + machine.wpos[0] * ax.x.y + machine.wpos[1] * ax.y.y }
  }

  // ---------------------------------------------------------------- selection overlay geometry
  let selOverlay: React.ReactNode = null
  let selBox: Box | null = null
  if (sel.length === 1) {
    const el = sel[0]
    const lb = localBox(el, paper, renderedBBox(el))
    const fb = frameBox(el.transform, lb)
    const cs = corners(el.transform, lb)
    selBox = aabb(cs)
    const scr = (q: Pt) => ({ x: sx(v, q.x), y: sy(v, q.y) })
    const toScr = (q: Pt) => {
      const r = rot(q, el.transform.rotation || 0)
      return scr({ x: el.transform.x + r.x, y: el.transform.y + r.y })
    }
    const pts = [toScr({ x: fb.x, y: fb.y }), toScr({ x: fb.x + fb.w, y: fb.y }), toScr({ x: fb.x + fb.w, y: fb.y + fb.h }), toScr({ x: fb.x, y: fb.y + fb.h })]
    const resizable = !el.locked && el.type !== 'flow_text'
    const tiny = fb.w * v.zoom < 24 || fb.h * v.zoom < 24
    const hs = resizable ? HANDLES.filter((h) => !(tiny && h.length === 1) && !(el.type === 'gcode' && h.length === 1)).map((h) => ({ h, p: toScr(handlePoint(fb, h)) })) : []
    const up = rot({ x: 0, y: -1 }, el.transform.rotation || 0)
    const topMid = toScr({ x: fb.x + fb.w / 2, y: fb.y })
    const rotateAt = resizable ? { x: topMid.x + up.x * 22, y: topMid.y + up.y * 22 } : null
    selOverlay = (
      <SelectionFrame pts={pts} handles={hs} rotate={resizable} rotateAt={rotateAt} touch={touch} rotation={el.transform.rotation || 0} label={liveLabel ?? undefined} dashed={el.locked} />
    )
  } else if (sel.length > 1) {
    const u = union(sel.map((e) => bounds.get(e.id)?.box ?? elementAABB(e, paper)))
    if (u) {
      selBox = u
      const pts = [{ x: u.x, y: u.y }, { x: u.x + u.w, y: u.y }, { x: u.x + u.w, y: u.y + u.h }, { x: u.x, y: u.y + u.h }].map((q) => ({ x: sx(v, q.x), y: sy(v, q.y) }))
      selOverlay = (
        <>
          {sel.map((e) => {
            const b = bounds.get(e.id)?.box
            return b ? <rect key={e.id} x={sx(v, b.x)} y={sy(v, b.y)} width={b.w * v.zoom} height={b.h * v.zoom} fill="none" stroke="rgb(var(--accent))" strokeWidth={0.75} opacity={0.6} className="pointer-events-none" /> : null
          })}
          <SelectionFrame pts={pts} handles={[]} rotate={false} rotateAt={null} touch={touch} rotation={0} dashed label={liveLabel ?? `已选 ${sel.length} 个`} />
        </>
      )
    }
  }

  const strokeW = (px: number) => px / v.zoom
  const cursor =
    st.tool === 'hand' || st.spaceHand
      ? gesture.current?.kind === 'pan'
        ? 'grabbing'
        : 'grab'
      : align
        ? st.bgCalib && st.bgCalib.step !== 'dist'
          ? 'crosshair'
          : bg?.locked
            ? 'grab'
            : 'move'
        : st.tool !== 'select'
          ? 'crosshair'
          : 'default'
  const flowEl = els.find((e) => e.type === 'flow_text')

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={hostRef}
          tabIndex={0}
          data-studio-canvas
          role="application"
          aria-roledescription="排版画布"
          aria-label={`第 ${st.view.page + 1} 页，${els.length} 个元素`}
          className="relative h-full w-full touch-none select-none overflow-hidden bg-canvas-desk outline-none"
        >
          <svg
            ref={svgRef}
            width={size.width}
            height={size.height}
            className="absolute inset-0 block"
            style={{ cursor }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
            onPointerLeave={() => setHover(null)}
            onDoubleClick={onDoubleClick}
          >
            <defs>
              <pattern id="pp-hatch-travel" width={4} height={4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1={0} y1={0} x2={0} y2={4} stroke="rgb(var(--travel))" strokeWidth={0.5} opacity={0.35} />
              </pattern>
              <pattern id="pp-hatch-red" width={2.5} height={2.5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1={0} y1={0} x2={0} y2={2.5} stroke="rgb(var(--red))" strokeWidth={0.6} opacity={0.45} />
              </pattern>
              <pattern id="pp-grid-minor" width={1} height={1} patternUnits="userSpaceOnUse">
                <path d="M1 0 L0 0 0 1" fill="none" stroke="rgb(var(--accent))" strokeOpacity={0.12} strokeWidth={strokeW(0.5)} />
              </pattern>
              <pattern id="pp-grid-major" width={10} height={10} patternUnits="userSpaceOnUse">
                {v.zoom > 3 ? <rect width={10} height={10} fill="url(#pp-grid-minor)" /> : null}
                <path d="M10 0 L0 0 0 10" fill="none" stroke="rgb(var(--accent))" strokeOpacity={0.28} strokeWidth={strokeW(0.6)} />
              </pattern>
              {work ? (
                <mask id="pp-out-work">
                  <rect x={-5000} y={-5000} width={10000} height={10000} fill="white" />
                  <rect x={work.x} y={work.y} width={work.w} height={work.h} fill="black" />
                </mask>
              ) : null}
            </defs>

            <g transform={`translate(${v.panX} ${v.panY}) scale(${v.zoom})`}>
              {/* travel-area hatch outside the machine reach */}
              {work && st.overlays.workArea ? <rect x={-5000} y={-5000} width={10000} height={10000} fill="url(#pp-hatch-travel)" mask="url(#pp-out-work)" className="pointer-events-none" /> : null}
              {/* paper */}
              <rect x={0} y={0} width={pw} height={ph} fill="rgb(var(--canvas-paper))" style={{ filter: 'drop-shadow(0 1px 3px rgb(0 0 0 / 0.14))' }} />
              {/* reference background (never printed) */}
              <BackgroundImage bg={bg} force={align} opacity={align ? Math.max(0.35, bg?.opacity ?? 0.5) : undefined} />
              {st.overlays.grid ? <rect x={0} y={0} width={pw} height={ph} fill="url(#pp-grid-major)" className="pointer-events-none" /> : null}
              <rect
                x={paper.margins.l}
                y={paper.margins.t}
                width={Math.max(0, pw - paper.margins.l - paper.margins.r)}
                height={Math.max(0, ph - paper.margins.t - paper.margins.b)}
                fill="none"
                stroke="rgb(var(--gray))"
                strokeOpacity={0.55}
                strokeDasharray="3 3"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                className="pointer-events-none"
              />
              {flowEl && st.view.sub === 0 && !flowEl.hidden ? <Ruling paper={paper} el={flowEl} /> : null}
              {/* elements */}
              <g opacity={align ? 0.35 : undefined} pointerEvents={align ? 'none' : undefined}>
              {els.map((el) =>
                st.view.sub > 0 && el.type !== 'flow_text' ? null : (
                  <ElementView
                    key={el.id}
                    el={el}
                    paper={paper}
                    zoom={v.zoom}
                    sub={st.view.sub}
                    dim={st.animate}
                    showSource={st.overlays.source}
                    outPaper={!!bounds.get(el.id)?.outPaper}
                    outWork={!!bounds.get(el.id)?.outWork}
                    hovered={hover === el.id && !st.selection.includes(el.id) && st.tool === 'select'}
                  />
                ),
              )}
              </g>
              {travel ? (
                <path d={travel} fill="none" stroke="rgb(var(--travel))" strokeWidth={0.8} strokeDasharray="3 2" vectorEffect="non-scaling-stroke" opacity={pageRender.version === useStudio.getState().version ? 0.9 : 0.4} className="pointer-events-none" />
              ) : null}
              {/* machine travel area */}
              {work && st.overlays.workArea ? (
                <rect x={work.x} y={work.y} width={work.w} height={work.h} fill="none" stroke="rgb(var(--travel))" strokeWidth={1.25} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" className="pointer-events-none" />
              ) : null}
              {penPt ? (
                <g transform={`translate(${penPt.x} ${penPt.y})`} className="pointer-events-none">
                  {!reduced ? <circle r={strokeW(10)} fill="rgb(var(--accent))" opacity={0.25} className="animate-ping origin-center [transform-box:fill-box]" /> : null}
                  <circle r={strokeW(4)} fill="rgb(var(--accent))" stroke="white" strokeWidth={strokeW(1.5)} />
                </g>
              ) : null}
            </g>

            {/* screen-space overlays */}
            {work && st.overlays.workArea ? (
              <text x={sx(v, work.x) + 6} y={sy(v, work.y + work.h) + 18} fontSize={12} fontWeight={500} fill="rgb(var(--travel))" className="pointer-events-none select-none" style={{ paintOrder: 'stroke', stroke: 'rgb(var(--canvas-desk))', strokeWidth: 3 }}>
                机器行程 {Math.round(workArea!.w_mm)}×{Math.round(workArea!.h_mm)}
              </text>
            ) : null}
            <text x={sx(v, pw)} y={sy(v, 0) - 8} textAnchor="end" fontSize={12} fill="rgb(var(--secondary-label) / var(--secondary-label-a))" className="pointer-events-none select-none">
              {paper.name} · {pw}×{ph} mm{st.view.sub > 0 ? ` · 第 ${st.view.page + 1} 页续 ${st.view.sub}（自动）` : ''}
            </text>
            {(st.overlays.origin || st.overlays.axes) && !align ? (
              <OriginOverlay
                v={v}
                origin={origin}
                paperW={pw}
                paperH={ph}
                content={cbox}
                showAxes={st.overlays.axes}
                showMarker={st.overlays.origin}
                draggable={!st.readOnly && st.view.sub === 0}
                touch={touch}
                dragging={gesture.current?.kind === 'origin' ? { snap: originLabel, where: parkText(origin, pw, ph, cbox, true) } : null}
              />
            ) : null}
            {align && bg ? <BgFrame v={v} bg={bg} touch={touch} label={liveLabel} calib={st.bgCalib} /> : null}
            {creating ? (
              creating.line ? (
                <line x1={sx(v, creating.line[0].x)} y1={sy(v, creating.line[0].y)} x2={sx(v, creating.line[1].x)} y2={sy(v, creating.line[1].y)} stroke="rgb(var(--accent))" strokeWidth={1.5} />
              ) : creating.tool === 'ellipse' ? (
                <ellipse cx={sx(v, creating.box.x + creating.box.w / 2)} cy={sy(v, creating.box.y + creating.box.h / 2)} rx={(creating.box.w * v.zoom) / 2} ry={(creating.box.h * v.zoom) / 2} fill="rgb(var(--accent) / 0.08)" stroke="rgb(var(--accent))" />
              ) : (
                <rect x={sx(v, creating.box.x)} y={sy(v, creating.box.y)} width={creating.box.w * v.zoom} height={creating.box.h * v.zoom} fill="rgb(var(--accent) / 0.08)" stroke="rgb(var(--accent))" strokeDasharray={creating.tool === 'text' ? '4 3' : undefined} />
              )
            ) : null}
            {Object.values(peers).filter((pr) => pr.page === st.view.page && st.view.sub === 0).flatMap((pr) =>
              pr.selection.map((id) => {
                const b = bounds.get(id)?.box
                if (!b) return null
                return (
                  <g key={`${pr.client}-${id}`} className="pointer-events-none">
                    <rect x={sx(v, b.x) - 3} y={sy(v, b.y) - 3} width={b.w * v.zoom + 6} height={b.h * v.zoom + 6} rx={3} fill="none" stroke={pr.color} strokeWidth={1.5} strokeDasharray="5 3" />
                    <rect x={sx(v, b.x) - 3} y={sy(v, b.y) - 22} width={pr.name.length * 12 + 56} height={18} rx={4} fill={pr.color} />
                    <text x={sx(v, b.x) + 3} y={sy(v, b.y) - 9} fontSize={12} fill="#fff">
                      {pr.name} 正在编辑
                    </text>
                  </g>
                )
              }),
            )}
            {selOverlay}
            {marquee ? (
              <rect x={sx(v, marquee.x)} y={sy(v, marquee.y)} width={marquee.w * v.zoom} height={marquee.h * v.zoom} fill="rgb(var(--accent) / 0.08)" stroke="rgb(var(--accent))" strokeWidth={1} className="pointer-events-none" />
            ) : null}
            <Guides v={v} lines={guides} />
            {st.overlays.rulers && !touch ? <Rulers v={v} highlight={selBox} /> : null}
          </svg>
          {st.animate && pageRender.result && outIdx != null ? <StrokeAnimation rid={pageRender.result.rid} index={outIdx} v={v} origin={originPoint(origin, pw, ph, cbox)} /> : null}
        </div>
      </ContextMenuTrigger>
      <CanvasMenu />
    </ContextMenu>
  )
}

const r3 = (v: number) => Math.round(v * 1000) / 1000

function renderedBBox(el: Element) {
  // read from the render cache through the shared key map
  const k = lastKeys.get(el.id)
  return k ? useRender.getState().els[k]?.bbox ?? null : null
}

/** Compute the element patch for a resize gesture. */
function resizePatch(g: Extract<Gesture, { kind: 'resize' }>, p: Pt, keepAspect: boolean, fromCenter: boolean): Partial<Element> {
  const el = g.orig
  const t = el.transform
  const f0 = g.frame
  const q = toFrame(t, p)
  const h = g.handle
  let x0 = f0.x
  let x1 = f0.x + f0.w
  let y0 = f0.y
  let y1 = f0.y + f0.h
  const cx = f0.x + f0.w / 2
  const cy = f0.y + f0.h / 2
  if (h.includes('e')) x1 = fromCenter ? q.x : q.x
  if (h.includes('w')) x0 = q.x
  if (h.includes('s')) y1 = q.y
  if (h.includes('n')) y0 = q.y
  if (fromCenter) {
    if (h.includes('e')) x0 = 2 * cx - x1
    if (h.includes('w')) x1 = 2 * cx - x0
    if (h.includes('s')) y0 = 2 * cy - y1
    if (h.includes('n')) y1 = 2 * cy - y0
  }
  const min = 1
  if (x1 - x0 < min) h.includes('w') ? (x0 = x1 - min) : (x1 = x0 + min)
  if (y1 - y0 < min && f0.h >= min) h.includes('n') ? (y0 = y1 - min) : (y1 = y0 + min)
  let fw = x1 - x0
  let fh = f0.h < 0.01 ? f0.h : y1 - y0
  if (keepAspect && f0.w > 0 && f0.h > 0.01) {
    const k = h.length === 2 ? Math.max(fw / f0.w, fh / f0.h) : h === 'e' || h === 'w' ? fw / f0.w : fh / f0.h
    fw = f0.w * k
    fh = f0.h * k
    if (h.includes('w')) x0 = fromCenter ? cx - fw / 2 : f0.x + f0.w - fw
    else if (h.includes('e')) x0 = fromCenter ? cx - fw / 2 : f0.x
    else x0 = cx - fw / 2
    if (h.includes('n')) y0 = fromCenter ? cy - fh / 2 : f0.y + f0.h - fh
    else if (h.includes('s')) y0 = fromCenter ? cy - fh / 2 : f0.y
    else y0 = cy - fh / 2
  }
  const { sx: Sx, sy: Sy } = scaleOf(t)
  const lb = g.lb
  const move = (nsx: number, nsy: number) => {
    const off = rot({ x: x0 - lb.x * nsx, y: y0 - lb.y * nsy }, t.rotation || 0)
    return { x: r3(t.x + off.x), y: r3(t.y + off.y) }
  }
  if (el.type === 'text') {
    const pos = move(Sx, Sy)
    return { transform: { ...t, ...pos }, props: { ...el.props, box: { w: r3(fw / Sx), h: r3(fh / Sy) } } } as Partial<Element>
  }
  if (el.type === 'shape') {
    const pr = el.props
    if ((pr.kind === 'line' || pr.kind === 'polygon') && pr.points?.length) {
      const kx = fw / Math.max(1e-6, f0.w)
      const ky = f0.h < 0.01 ? 1 : fh / Math.max(1e-6, f0.h)
      const pts = pr.points.map((pt) => [r3(lb.x + (pt[0] - lb.x) * kx), r3(lb.y + (pt[1] - lb.y) * ky)])
      return { transform: { ...t, ...move(Sx, Sy) }, props: { ...pr, points: pts, w: r3(lb.w * kx), h: r3(lb.h * ky) } } as Partial<Element>
    }
    return { transform: { ...t, ...move(Sx, Sy) }, props: { ...pr, w: r3(fw / Sx), h: r3(Math.max(0.01, fh / Sy)) } } as Partial<Element>
  }
  // scale-based (image / svg / dxf / gcode)
  let nsx = fw / Math.max(1e-6, lb.w)
  let nsy = fh / Math.max(1e-6, lb.h)
  if (el.type === 'gcode') nsy = nsx
  if (keepAspect) nsy = nsx * (Sy / Sx)
  const sc = t.scale || 1
  const pos = move(nsx, nsy)
  nsx = r3(nsx / sc)
  nsy = r3(nsy / sc)
  return { transform: { ...t, ...pos, sx: nsx, sy: nsy } }
}

/** Faint ruling lines of the letter (flow_text) layout inside the margin box. */
function Ruling({ paper, el }: { paper: PaperBase; el: Element }) {
  const { w, h } = paperDims(paper)
  const m = paper.margins
  const n = (el.type === 'flow_text' && el.props.line_num) || paper.ruling?.line_num || 0
  if (!n) return null
  const top = m.t + el.transform.y
  const bh = h - m.t - m.b
  const pitch = bh / n
  const lines = Array.from({ length: n }, (_, i) => top + pitch * (i + 1))
  return (
    <g className="pointer-events-none" stroke="rgb(var(--accent))" strokeOpacity={0.14} strokeWidth={0.75}>
      {lines.map((y) => (
        <line key={y} x1={m.l + el.transform.x} x2={w - m.r + el.transform.x} y1={y} y2={y} vectorEffect="non-scaling-stroke" />
      ))}
    </g>
  )
}

/** 对齐背景: frame, scale handles (corners), rotate handle, calibration points. Screen space. */
function BgFrame({ v, bg, touch, label, calib }: { v: Viewport; bg: PageBackground; touch: boolean; label: string | null; calib: ReturnType<typeof useStudio.getState>['bgCalib'] }) {
  const cs = bgCorners(bg).map((q) => ({ x: sx(v, q.x), y: sy(v, q.y) }))
  const hit = touch ? 44 : 18
  const top = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 }
  const rr = (bg.transform.rotation * Math.PI) / 180
  const up = { x: Math.sin(rr), y: -Math.cos(rr) }
  const rh = { x: top.x + up.x * 28, y: top.y + up.y * 28 }
  const pt = (q: number[] | { x: number; y: number } | undefined) => {
    if (!q) return null
    const pp = imgToPage(bg, Array.isArray(q) ? { x: q[0], y: q[1] } : q)
    return { x: sx(v, pp.x), y: sy(v, pp.y) }
  }
  const a = pt(calib?.a ?? (calib ? undefined : bg.calib?.a))
  const b = pt(calib?.b ?? (calib ? undefined : bg.calib?.b))
  const color = bg.locked ? 'rgb(var(--gray))' : 'rgb(var(--orange))'
  return (
    <g>
      <polygon points={cs.map((q) => `${q.x},${q.y}`).join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray={bg.locked ? '4 3' : undefined} className="pointer-events-none" />
      {!bg.locked && !calib ? (
        <>
          <line x1={top.x} y1={top.y} x2={rh.x} y2={rh.y} stroke={color} strokeWidth={1} className="pointer-events-none" />
          <g transform={`translate(${rh.x} ${rh.y})`} data-handle="bg-rotate" style={{ cursor: 'grab' }}>
            <circle r={hit / 2} fill="transparent" />
            <circle r={8} fill="rgb(var(--bg-elevated))" stroke={color} strokeWidth={1.5} />
            <path d="M-3.2 -1.2 A3.4 3.4 0 1 1 -2.4 2.4 M-3.6 -3.6 L-3.2 -1.2 L-0.9 -1.6" fill="none" stroke={color} strokeWidth={1.3} strokeLinecap="round" />
            <title>拖动旋转背景（接近 90° 时吸附，Shift 15° 步进）</title>
          </g>
          {cs.map((q, i) => (
            <g key={i} transform={`translate(${q.x} ${q.y}) rotate(${bg.transform.rotation})`} data-handle="bg-scale" style={{ cursor: i % 2 ? 'nesw-resize' : 'nwse-resize' }}>
              <rect x={-hit / 2} y={-hit / 2} width={hit} height={hit} fill="transparent" />
              <rect x={-5} y={-5} width={10} height={10} rx={2} fill="rgb(var(--bg-elevated))" stroke={color} strokeWidth={1.5} />
              <title>拖动缩放背景（等比）</title>
            </g>
          ))}
        </>
      ) : null}
      {a && b ? <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgb(var(--pink))" strokeWidth={2} strokeDasharray="5 3" className="pointer-events-none" /> : null}
      {[a, b].map((q, i) =>
        q ? (
          <g key={i} transform={`translate(${q.x} ${q.y})`} className="pointer-events-none">
            <circle r={9} fill="rgb(var(--pink) / 0.18)" stroke="rgb(var(--pink))" strokeWidth={1.5} />
            <line x1={-14} x2={14} y1={0} y2={0} stroke="rgb(var(--pink))" strokeWidth={1} />
            <line y1={-14} y2={14} x1={0} x2={0} stroke="rgb(var(--pink))" strokeWidth={1} />
            <text x={12} y={-10} fontSize={12} fontWeight={700} fill="rgb(var(--pink))" style={{ paintOrder: 'stroke', stroke: 'rgb(var(--canvas-paper))', strokeWidth: 3 }}>
              {i ? 'B' : 'A'}
            </text>
          </g>
        ) : null,
      )}
      {label ? (
        <g transform={`translate(${Math.max(...cs.map((q) => q.x)) + 8} ${Math.max(...cs.map((q) => q.y)) + 4})`} className="pointer-events-none">
          <rect x={0} y={0} width={label.length * 6.6 + 12} height={18} rx={5} fill="rgb(30 30 30 / 0.8)" />
          <text x={6} y={12.5} fontSize={11} fill="#fff" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {label}
          </text>
        </g>
      ) : null}
    </g>
  )
}

function CanvasMenu() {
  const sel = useStudio((s) => s.selection)
  const n = sel.length
  const locked = useStudio((s) => currentPage(s)?.elements.filter((e) => s.selection.includes(e.id)).every((e) => e.locked) ?? false)
  return (
    <ContextMenuContent className="min-w-48">
      {n ? (
        <>
          <ContextMenuItem onSelect={() => copySelection(true)}>剪切</ContextMenuItem>
          <ContextMenuItem onSelect={() => copySelection()}>拷贝</ContextMenuItem>
          <ContextMenuItem onSelect={() => paste()}>粘贴</ContextMenuItem>
          <ContextMenuItem onSelect={duplicateSelection}>再制</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => zOrder('top')}>置于顶层</ContextMenuItem>
          <ContextMenuItem onSelect={() => zOrder('up')}>上移一层</ContextMenuItem>
          <ContextMenuItem onSelect={() => zOrder('down')}>下移一层</ContextMenuItem>
          <ContextMenuItem onSelect={() => zOrder('bottom')}>置于底层</ContextMenuItem>
          <ContextMenuSeparator />
          {n > 1 ? (
            <>
              <ContextMenuItem onSelect={() => align('left')}>左对齐</ContextMenuItem>
              <ContextMenuItem onSelect={() => align('hcenter')}>水平居中</ContextMenuItem>
              <ContextMenuItem onSelect={() => align('top')}>顶对齐</ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : (
            <ContextMenuItem onSelect={() => align('hcenter')}>在版心水平居中</ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => toggleLock()}>{locked ? '解锁' : '锁定'}</ContextMenuItem>
          <ContextMenuItem onSelect={() => toggleHidden()}>隐藏 / 显示</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={deleteSelection} className="text-red">
            删除
          </ContextMenuItem>
        </>
      ) : (
        <>
          <ContextMenuItem onSelect={() => paste()}>粘贴</ContextMenuItem>
          <ContextMenuItem onSelect={selectAll}>全选</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => insertText()}>插入文本框</ContextMenuItem>
          <ContextMenuItem onSelect={() => insertShape('rect')}>插入矩形</ContextMenuItem>
          <ContextMenuItem onSelect={() => useStudio.getState().requestFit()}>适合页面</ContextMenuItem>
        </>
      )}
    </ContextMenuContent>
  )
}

export { useElementRender }
