import * as React from 'react'
import { usePapers, useProject, type Project } from '@/api/projects'
import { cn } from '@/lib/cn'

type El = { type?: string; hidden?: boolean; transform?: { x?: number; y?: number }; props?: Record<string, unknown> }

interface ThumbModel {
  w: number
  h: number
  margins: { l: number; t: number; r: number; b: number }
  texts: { x: number; y: number; size: number; lines: string[]; flow: boolean }[]
  grids: { x: number; y: number; w: number; h: number; rows: number; cols: number; style?: string }[]
  shapes: number
}

/** Paper size + first text lines + grid shapes from the project doc (05-review §2.5). */
function model(p: Project, papers: { id: string; width_mm: number; height_mm: number; orientation?: string; margins?: Record<string, number | undefined> }[]): ThumbModel {
  const doc = p.doc
  const page = doc.pages?.[0]
  const ref = page?.paper ?? doc.paper
  const spec = (ref?.spec ?? papers.find((x) => x.id === (ref?.paper_id ?? 'a4-normal'))) as
    | { width_mm: number; height_mm: number; orientation?: string; margins?: Record<string, number | undefined> }
    | undefined
  let w = spec?.width_mm ?? 209
  let h = spec?.height_mm ?? 296
  if (spec?.orientation === 'landscape') [w, h] = [h, w]
  const m = spec?.margins ?? {}
  const margins = { l: m.l ?? 20, t: m.t ?? 20, r: m.r ?? 20, b: m.b ?? 20 }
  const texts: ThumbModel['texts'] = []
  const grids: ThumbModel['grids'] = []
  let shapes = 0
  for (const e of ((page?.elements ?? []) as El[]).filter((x) => !x.hidden)) {
    const x = e.transform?.x ?? 0
    const y = e.transform?.y ?? 0
    const pr = e.props ?? {}
    if ((e.type === 'flow_text' || e.type === 'text') && typeof pr.text === 'string' && pr.text.trim()) {
      const flow = e.type === 'flow_text'
      const size = flow ? (h - margins.t - margins.b) / 22 : Number(pr.size_mm ?? 8)
      const lines = pr.text.replace(/\{\{(\w+)\}\}/g, '「$1」').split('\n').slice(0, flow ? 14 : 4)
      texts.push({ x: flow ? margins.l + x : x, y: flow ? margins.t + y : y, size, lines, flow })
    } else if (e.type === 'shape' && pr.kind === 'grid') {
      grids.push({ x, y, w: Number(pr.w ?? 100), h: Number(pr.h ?? 20), rows: Number(pr.rows ?? 1), cols: Number(pr.cols ?? 5), style: pr.grid_style as string | undefined })
    } else shapes++
  }
  return { w, h, margins, texts, grids, shapes }
}

/**
 * Project thumbnail. Server thumbnail when present; otherwise the real paper ratio with the first
 * lines of text and grid shapes drawn from the project doc (fetched lazily when the card scrolls into view).
 */
export function ProjectThumb({
  id, name, url, template, className, eager,
}: { id: string; name: string; url?: string | null; template?: boolean; className?: string; eager?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [visible, setVisible] = React.useState(!!eager)
  const [failed, setFailed] = React.useState(false)
  React.useEffect(() => {
    if (visible || !ref.current || typeof IntersectionObserver === 'undefined') {
      if (typeof IntersectionObserver === 'undefined') setVisible(true)
      return
    }
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: '200px' })
    io.observe(ref.current)
    return () => io.disconnect()
  }, [visible])
  const useServer = !!url && !failed
  const proj = useProject(visible && !useServer ? id : null)
  const papers = usePapers()
  const mdl = React.useMemo(() => (proj.data ? model(proj.data, papers.data ?? []) : null), [proj.data, papers.data])
  const w = mdl?.w ?? 209
  const h = mdl?.h ?? 296
  const empty = mdl && !mdl.texts.length && !mdl.grids.length && !mdl.shapes

  return (
    <div ref={ref} className={cn('relative flex items-center justify-center overflow-hidden rounded-md bg-canvas-desk', className)}>
      {useServer ? (
        <img src={url!} alt="" loading="lazy" onError={() => setFailed(true)} className="h-[86%] w-auto rounded-[2px] bg-canvas-paper object-contain shadow-paper" />
      ) : (
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className={cn('rounded-[2px] bg-canvas-paper shadow-paper', w > h ? 'h-auto w-[86%]' : 'h-[86%] w-auto')}
          aria-hidden
        >
          {mdl ? (
            <>
              {mdl.grids.map((g, i) => (
                <g key={i} className="stroke-guide" fill="none" strokeWidth={0.6}>
                  <rect x={g.x} y={g.y} width={g.w} height={g.h} />
                  {Array.from({ length: g.cols - 1 }, (_, c) => (
                    <line key={`c${c}`} x1={g.x + ((c + 1) * g.w) / g.cols} x2={g.x + ((c + 1) * g.w) / g.cols} y1={g.y} y2={g.y + g.h} />
                  ))}
                  {Array.from({ length: g.rows - 1 }, (_, r) => (
                    <line key={`r${r}`} y1={g.y + ((r + 1) * g.h) / g.rows} y2={g.y + ((r + 1) * g.h) / g.rows} x1={g.x} x2={g.x + g.w} />
                  ))}
                </g>
              ))}
              {mdl.texts.map((t, i) => (
                <text key={i} x={t.x} y={t.y} fontSize={t.size * 0.8} className={template ? 'fill-accent' : 'fill-ink'} style={{ fontFamily: '"Kaiti SC","STKaiti","KaiTi",serif' }}>
                  {t.lines.map((l, j) => (
                    <tspan key={j} x={t.x} dy={j ? t.size * 1.25 : t.size}>
                      {l.length > 40 ? `${l.slice(0, 40)}…` : l || ' '}
                    </tspan>
                  ))}
                </text>
              ))}
              {empty ? (
                <text x={w / 2} y={h / 2} textAnchor="middle" fontSize={w / 14} className="fill-tertiary-label">
                  空白
                </text>
              ) : null}
            </>
          ) : (
            <rect x={w * 0.15} y={h * 0.12} width={w * 0.5} height={h * 0.035} rx={2} className="fill-quaternary-fill motion-safe:animate-pulse" />
          )}
        </svg>
      )}
      <span className="sr-only">{name} 缩略图</span>
    </div>
  )
}
