/** Pen-order animation (笔顺) drawn on a canvas layer over the SVG, with a HUD (play/pause, scrub, speed). */
import { Pause, Play, RotateCcw, X } from 'lucide-react'
import * as React from 'react'
import type { Polylines } from '@/api/studio'
import { IconButton, Slider } from '@/components/ui'
import { useReducedMotion } from '@/lib/media'
import type { Pt } from '../geometry'
import { pagePolylines } from '../render-engine'
import { useStudio } from '../store'
import type { Viewport } from './overlays'

interface Prepared {
  lines: Polylines
  /** cumulative length at the start of each line (draw + travel) */
  starts: Float64Array
  lens: Float64Array
  total: number
}

function prepare(lines: Polylines, origin: Pt): Prepared {
  const starts = new Float64Array(lines.length)
  const lens = new Float64Array(lines.length)
  let acc = 0
  let px = origin.x
  let py = origin.y
  lines.forEach((l, k) => {
    acc += Math.hypot(l[0] - px, l[1] - py) * 0.35 // travel is fast: weight it lower
    starts[k] = acc
    let len = 0
    for (let i = 2; i < l.length; i += 2) len += Math.hypot(l[i] - l[i - 2], l[i + 1] - l[i - 1])
    lens[k] = len
    acc += len
    px = l[l.length - 2]
    py = l[l.length - 1]
  })
  return { lines, starts, lens, total: acc }
}

export function StrokeAnimation({ rid, index, v, origin }: { rid: string; index: number; v: Viewport; origin: Pt }) {
  const reduced = useReducedMotion()
  const inkRef = React.useRef<HTMLCanvasElement>(null)
  const topRef = React.useRef<HTMLCanvasElement>(null)
  const [prep, setPrep] = React.useState<Prepared | null>(null)
  const [playing, setPlaying] = React.useState(!reduced)
  const [speed, setSpeed] = React.useState(1)
  const [t, setT] = React.useState(0) // 0..1
  const drawn = React.useRef({ upto: 0, key: '' })

  React.useEffect(() => {
    let alive = true
    pagePolylines(rid, index)
      .then((l) => alive && setPrep(prepare(l, origin)))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [rid, index, origin])

  // playback clock: ~10 s for the whole page at 1×
  React.useEffect(() => {
    if (!playing || !prep) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setT((x) => {
        const n = Math.min(1, x + (dt * speed) / 10)
        if (n >= 1) setPlaying(false)
        return n
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, prep])

  // draw
  React.useEffect(() => {
    const ink = inkRef.current
    const top = topRef.current
    if (!ink || !top || !prep) return
    const dpr = window.devicePixelRatio || 1
    const W = Math.round(v.width * dpr)
    const H = Math.round(v.height * dpr)
    const key = `${W}x${H}|${v.zoom}|${v.panX}|${v.panY}|${rid}|${index}`
    for (const c of [ink, top]) {
      if (c.width !== W || c.height !== H) {
        c.width = W
        c.height = H
      }
    }
    const ictx = ink.getContext('2d')!
    const tctx = top.getContext('2d')!
    const target = t * prep.total
    // find current line
    let k = 0
    while (k < prep.lines.length && prep.starts[k] + prep.lens[k] <= target) k++
    const css = getComputedStyle(document.documentElement)
    const rgb = (n: string) => `rgb(${css.getPropertyValue(n).trim().split(/\s+/).join(',')})`
    const setT_ = (ctx: CanvasRenderingContext2D) => ctx.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, dpr * v.panX, dpr * v.panY)
    if (drawn.current.key !== key || k < drawn.current.upto) {
      ictx.setTransform(1, 0, 0, 1, 0, 0)
      ictx.clearRect(0, 0, W, H)
      drawn.current = { upto: 0, key }
    }
    setT_(ictx)
    ictx.strokeStyle = rgb('--ink')
    ictx.lineWidth = Math.max(0.9, 0.3 * v.zoom) / v.zoom
    ictx.lineCap = 'round'
    ictx.lineJoin = 'round'
    ictx.beginPath()
    for (let i = drawn.current.upto; i < k; i++) {
      const l = prep.lines[i]
      ictx.moveTo(l[0], l[1])
      for (let j = 2; j < l.length; j += 2) ictx.lineTo(l[j], l[j + 1])
    }
    ictx.stroke()
    drawn.current.upto = k
    // current partial stroke + travel + pen
    tctx.setTransform(1, 0, 0, 1, 0, 0)
    tctx.clearRect(0, 0, W, H)
    setT_(tctx)
    tctx.lineCap = 'round'
    let pen: Pt = origin
    if (k < prep.lines.length) {
      const l = prep.lines[k]
      const prev = k > 0 ? prep.lines[k - 1] : null
      const from = prev ? { x: prev[prev.length - 2], y: prev[prev.length - 1] } : origin
      const into = target - prep.starts[k]
      if (into < 0) {
        // travelling
        const tl = prep.starts[k] - (k > 0 ? prep.starts[k - 1] + prep.lens[k - 1] : 0)
        const f = tl > 0 ? 1 + into / tl : 1
        pen = { x: from.x + (l[0] - from.x) * f, y: from.y + (l[1] - from.y) * f }
        tctx.strokeStyle = rgb('--travel')
        tctx.setLineDash([3 / v.zoom, 2 / v.zoom])
        tctx.lineWidth = 1 / v.zoom
        tctx.beginPath()
        tctx.moveTo(from.x, from.y)
        tctx.lineTo(pen.x, pen.y)
        tctx.stroke()
        tctx.setLineDash([])
      } else {
        tctx.strokeStyle = rgb('--accent')
        tctx.lineWidth = Math.max(1.4, 0.4 * v.zoom) / v.zoom
        tctx.beginPath()
        tctx.moveTo(l[0], l[1])
        let acc = 0
        pen = { x: l[0], y: l[1] }
        for (let j = 2; j < l.length; j += 2) {
          const seg = Math.hypot(l[j] - l[j - 2], l[j + 1] - l[j - 1])
          if (acc + seg >= into) {
            const f = seg > 0 ? (into - acc) / seg : 0
            pen = { x: l[j - 2] + (l[j] - l[j - 2]) * f, y: l[j - 1] + (l[j + 1] - l[j - 1]) * f }
            tctx.lineTo(pen.x, pen.y)
            break
          }
          acc += seg
          tctx.lineTo(l[j], l[j + 1])
          pen = { x: l[j], y: l[j + 1] }
        }
        tctx.stroke()
      }
    } else if (prep.lines.length) {
      const l = prep.lines[prep.lines.length - 1]
      pen = { x: l[l.length - 2], y: l[l.length - 1] }
    }
    tctx.fillStyle = rgb('--accent')
    tctx.beginPath()
    tctx.arc(pen.x, pen.y, 3.5 / v.zoom, 0, Math.PI * 2)
    tctx.fill()
  }, [t, prep, v.width, v.height, v.zoom, v.panX, v.panY, rid, index, origin])

  const done = Math.round(t * (prep?.lines.length ?? 0))
  return (
    <>
      <canvas ref={inkRef} className="pointer-events-none absolute inset-0" style={{ width: v.width, height: v.height }} aria-hidden />
      <canvas ref={topRef} className="pointer-events-none absolute inset-0" style={{ width: v.width, height: v.height }} aria-hidden />
      <div className="mat-hud absolute left-1/2 top-12 z-10 flex w-[min(420px,calc(100%-24px))] -translate-x-1/2 items-center gap-2 rounded-xl px-2 py-1.5 text-white shadow-md" role="group" aria-label="笔顺动画">
        <IconButton label={playing ? '暂停' : '播放'} size="sm" className="text-white hover:bg-white/15 hover:text-white" onClick={() => (t >= 1 ? (setT(0), setPlaying(true)) : setPlaying(!playing))}>
          {playing ? <Pause /> : t >= 1 ? <RotateCcw /> : <Play />}
        </IconButton>
        <Slider value={[t * 1000]} min={0} max={1000} step={1} onValueChange={([x]) => { setPlaying(false); setT(x / 1000) }} aria-label="进度" className="flex-1" />
        <span className="w-20 shrink-0 text-right text-caption tabular-nums text-white/80">
          {done}/{prep?.lines.length ?? '—'} 笔
        </span>
        <button type="button" className="press shrink-0 rounded-sm px-1.5 py-0.5 text-caption tabular-nums text-white/90 hover:bg-white/15" onClick={() => setSpeed((s) => (s >= 8 ? 0.5 : s * 2))} aria-label="播放速度">
          {speed}×
        </button>
        <IconButton label="关闭笔顺" size="sm" className="text-white hover:bg-white/15 hover:text-white" onClick={() => useStudio.getState().setAnimate(false)}>
          <X />
        </IconButton>
      </div>
    </>
  )
}
