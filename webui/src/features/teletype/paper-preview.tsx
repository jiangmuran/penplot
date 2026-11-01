import { Maximize2, ScanLine } from 'lucide-react'
import * as React from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PaperGeo, TeletypePreview } from '@/api/teletype'
import { Button, IconButton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useTeletype, type Char } from './store'

/** Paper is always light, so ink colours are fixed (demo palette). */
const ZOOM = 1.7
const QUEUED = '#b4ae9f'
const SENT = '#1d2a5a'
const SAMPLE = '#6b7489'

const NUM_PAIR = /(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g
/** Cell-local glyph path (server-made, same strokes as the G-code) → paper mm. */
function placed(d: string, ox: number, oy: number) {
  return d.replace(NUM_PAIR, (_, x: string, y: string) => `${(+x + ox).toFixed(2)} ${(+y + oy).toFixed(2)}`)
}

/** Per-char placed path, memoised on the (immutable) char object + its glyph string. */
const pathCache = new WeakMap<Char, { d: string; src: string }>()
function charPath(c: Char, g: PaperGeo, glyphs: Map<string, string>) {
  const src = glyphs.get(c.gk)
  if (src == null) return ''
  const hit = pathCache.get(c)
  if (hit && hit.src === src) return hit.d
  const d = placed(src, g.margin + c.col * g.cw, g.margin + c.row * g.lh)
  pathCache.set(c, { d, src })
  return d
}

/**
 * Live sheet preview (demo parity): queued chars gray, chars the controller acknowledged dark ink, red ring =
 * live pen position (filled while the pen is down). "跟随" magnifies a window that follows the cursor.
 * Glyphs come from the server (exactly the strokes the pen draws, any font). Without a session, `sample` shows
 * the chosen font / size / spacing on an empty sheet.
 */
export function PaperPreview({
  onNewSheet, canControl, className, sample,
}: { onNewSheet: () => void; canControl: boolean; className?: string; sample?: TeletypePreview | null }) {
  const { paper, chars, glyphs, pen, cfg, message, active } = useTeletype(
    useShallow((s) => ({ paper: s.paper, chars: s.chars, glyphs: s.glyphs, rev: s.rev, pen: s.pen, cfg: s.cfg, message: s.needPaperMessage, active: s.active })),
  )
  const [follow, setFollow] = React.useState(true)
  const g = !active && sample ? sample.geo : paper.geo
  const boxRef = React.useRef<HTMLDivElement>(null)
  const [aspect, setAspect] = React.useState(1.3)
  React.useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (el.clientWidth > 0) setAspect(Math.max(0.3, (el.clientHeight - 24) / (el.clientWidth - 24)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { queued, sent, done } = React.useMemo(() => {
    let q = ''
    let s = ''
    let n = 0
    for (const c of chars.values()) {
      const d = charPath(c, g, glyphs)
      if (c.st === 'ok') {
        s += d
        n++
      } else q += d
    }
    return { queued: q, sent: s, done: n }
  }, [chars, g, glyphs])

  const samplePath = React.useMemo(() => {
    if (active || !sample) return ''
    let d = ''
    for (const [, , row, col, , , gk] of sample.chars) {
      const src = gk ? sample.glyphs[gk] : undefined
      if (src) d += placed(src, sample.geo.margin + col * sample.geo.cw, sample.geo.margin + row * sample.geo.lh)
    }
    return d
  }, [active, sample])

  const row = active ? paper.row : 0
  const col = active ? paper.col : 0
  const viewBox = React.useMemo(() => {
    if (!follow) return `0 0 ${g.paper_w} ${g.paper_h}`
    // magnified window shaped like the box, following the carriage
    const w = g.paper_w / ZOOM
    const h = Math.min(g.paper_h, w * aspect)
    const x = Math.max(0, Math.min(g.paper_w - w, g.margin + col * g.cw - w * 0.6))
    const y = Math.max(0, Math.min(g.paper_h - h, g.margin + row * g.lh - h * 0.7))
    return `${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`
  }, [follow, g, row, col, aspect])

  const sw = Math.max(0.22, g.h * 0.07)
  const penDown = pen && cfg ? pen.z > (cfg.z_down + cfg.z_up) / 2 : false
  const summary = active
    ? `第 ${paper.page} 页，${g.cols} 列 × ${g.rows} 行；本页 ${chars.size} 字，已写 ${done} 字；光标在第 ${paper.row + 1} 行第 ${paper.col + 1} 列${paper.need_paper ? '；等待换纸' : ''}`
    : `预览：${g.cols} 列 × ${g.rows} 行`

  return (
    <div className={cn('relative flex min-h-0 flex-col', className)}>
      <div ref={boxRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-canvas-desk p-3">
        <svg viewBox={viewBox} role="img" aria-label={summary} preserveAspectRatio="xMidYMid meet" className="size-full" data-testid="tt-paper">
          <rect x={0} y={0} width={g.paper_w} height={g.paper_h} rx={0.8} className="fill-canvas-paper" style={{ filter: 'drop-shadow(0 1px 2px rgb(0 0 0 / 0.18))' }} />
          <rect x={g.margin} y={g.margin} width={g.paper_w - 2 * g.margin} height={g.paper_h - 2 * g.margin} fill="none" className="stroke-guide" strokeWidth={0.25} strokeDasharray="1 1" opacity={0.6} />
          <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth={sw}>
            {samplePath ? <path d={samplePath} stroke={SAMPLE} opacity={0.55} data-testid="tt-sample" /> : null}
            {queued ? <path d={queued} stroke={QUEUED} data-testid="tt-ink-queued" /> : null}
            {sent ? <path d={sent} stroke={SENT} data-testid="tt-ink-sent" /> : null}
          </g>
          {active ? (
            <rect
              x={g.margin + paper.col * g.cw}
              y={g.margin + paper.row * g.lh + g.h * 1.08}
              width={g.cw * 0.9}
              height={Math.max(0.35, g.h * 0.12)}
              className="fill-accent motion-safe:animate-pulse"
              opacity={0.7}
            />
          ) : null}
          {active && pen ? (
            <circle cx={pen.x} cy={pen.y} r={Math.max(1.2, g.h * 0.4)} className={penDown ? 'fill-red/60 stroke-red' : 'fill-none stroke-red'} strokeWidth={0.4} />
          ) : null}
        </svg>
        {active && paper.need_paper ? (
          <div role="alert" className="mat-thick absolute inset-x-4 bottom-4 flex flex-wrap items-center gap-3 rounded-lg px-4 py-3 shadow-md">
            <span className="min-w-0 flex-1 text-callout text-label">
              {message || `第 ${paper.page} 页写满了`}：笔回到原点后，换上新纸、左上角对准原来的位置，再点「已换纸」。之后的输入会先缓存。
              {paper.overflow ? <span className="text-secondary-label">（已缓存 {paper.overflow} 个字）</span> : null}
            </span>
            <Button variant="filled" disabled={!canControl} onClick={onNewSheet}>
              已换纸，继续
            </Button>
          </div>
        ) : null}
        {!active && sample ? (
          <div className="mat-thin pointer-events-none absolute bottom-4 left-4 rounded-md px-2.5 py-1 text-caption text-secondary-label">
            预览 · {sample.font.name}
          </div>
        ) : null}
      </div>
      <div className="mt-2 flex items-center gap-3 whitespace-nowrap px-1 text-caption text-secondary-label">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded" style={{ background: QUEUED }} />等待书写</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-3 rounded" style={{ background: SENT }} />已写</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-full border border-red" />笔位置</span>
        <span className="ml-auto truncate tabular-nums max-md:hidden">
          {active ? `第 ${paper.page} 页 · ` : ''}
          {g.cols} 列 × {g.rows} 行
        </span>
        <IconButton label={follow ? '显示整页' : '放大并跟随光标'} size="sm" className="max-md:ml-auto" onClick={() => setFollow(!follow)}>
          {follow ? <Maximize2 /> : <ScanLine />}
        </IconButton>
      </div>
    </div>
  )
}
