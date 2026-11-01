/**
 * 位置预览: the physical paper, the origin + axis directions, the job bounding box and the frame path (plus the
 * machine travel area when one is configured). With origin.anchor='content' the origin is the drawing's corner, so
 * the paper is shown relative to where the pen is parked. Drag the job box to set a per-job placement offset
 * (design unchanged). Verdicts come from the backend placement endpoint (GET /render/{rid}/pages/{i}/placement)
 * once the page render is current; the drawing follows the drag locally.
 */
import { Crosshair, Move, RotateCcw, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { components } from '@/api/schema'
import { useLive } from '@/api/store'
import type { OriginSpec, PaperBase } from '@/api/studio'
import { Button, Dialog, DialogContent, DialogTitle, NumberField, Segmented } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { contentBox } from '../actions'
import { Help } from '../ext'
import type { Box } from '../geometry'
import { hasTravel, machineAxes, originAnchor, originPoint, pageToMachine, paperDims, workAreaRect } from '../model'
import { runFrame, type FrameMode } from '../print'
import { outputIndex, useRender } from '../render-engine'
import { currentPage, useStudio } from '../store'
import { BackgroundImage } from '../canvas/background-layer'
import { applyOriginOffsets, originSnapLines, originSnapPoints, parkText, useSvgOriginDrag } from '../origin-drag'

type PlacementInfo = components['schemas']['PlacementInfo']

export function PositionSheet({ open, onOpenChange, paper, origin, workArea: wa }: { open: boolean; onOpenChange: (o: boolean) => void; paper: PaperBase; origin: OriginSpec; workArea: { w_mm: number; h_mm: number } | null }) {
  const workArea = hasTravel(wa) ? wa : null
  const compact = useIsCompact()
  const placement = useStudio((s) => s.placement)
  const doc = useStudio((s) => s.doc)
  const view = useStudio((s) => s.view)
  useRender((s) => s.els)
  const machine = useLive((s) => s.machine)
  const [mode, setMode] = React.useState<FrameMode>('up')
  const [framing, setFraming] = React.useState(false)
  const svgRef = React.useRef<SVGSVGElement>(null)
  const drag = React.useRef<{ x: number; y: number; dx: number; dy: number; k: number } | null>(null)
  const page = currentPage({ doc, view })
  const { w: pw, h: ph } = paperDims(paper)
  const design: Box | null = page ? contentBox(page.elements, paper) : null
  const job: Box | null = design ? { ...design, x: design.x + placement.dx, y: design.y + placement.dy } : null
  const anchored = originAnchor(origin) === 'content'
  const work = workArea ? workAreaRect(origin, pw, ph, workArea.w_mm, workArea.h_mm, job) : null
  const o = originPoint(origin, pw, ph, job)
  const bg = page?.background ?? null
  const readOnly = useStudio((s) => s.readOnly)
  const odrag = useSvgOriginDrag({
    svg: svgRef, origin, w: pw, h: ph, content: job,
    snap: originSnapPoints(paper, job ? [{ box: job, label: '内容角' }] : [], bg), lines: originSnapLines(paper), disabled: readOnly || !open,
  })

  // backend truth for the verdicts (only when the page render matches the document)
  const pr = useRender((s) => s.page)
  const version = useStudio((s) => s.version)
  const idx = pr.version === version ? outputIndex(pr.result, view.page, view.sub) : null
  const rid = pr.version === version ? pr.result?.rid : undefined
  const info = useQuery({
    queryKey: ['placement', rid, idx, placement.dx, placement.dy],
    queryFn: () => api.get<PlacementInfo>(`/render/${rid}/pages/${idx}/placement`, { query: { dx_mm: placement.dx, dy_mm: placement.dy } }),
    enabled: open && !!rid && idx != null,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  })
  const server = info.data && info.data.offset_mm?.[0] === placement.dx && info.data.offset_mm?.[1] === placement.dy ? info.data : null
  const ax = machineAxes(origin)

  const x0 = Math.min(0, work?.x ?? 0, job?.x ?? 0) - 12
  const y0 = Math.min(0, work?.y ?? 0, job?.y ?? 0) - 34
  const x1 = Math.max(pw, work ? work.x + work.w : 0, job ? job.x + job.w : 0) + 12
  const y1 = Math.max(ph, work ? work.y + work.h : 0, job ? job.y + job.h : 0) + 22

  const dist = job
    ? {
        paper: { l: job.x, t: job.y, r: pw - (job.x + job.w), b: ph - (job.y + job.h) },
        work: work ? { l: job.x - work.x, t: job.y - work.y, r: work.x + work.w - (job.x + job.w), b: work.y + work.h - (job.y + job.h) } : null,
      }
    : null
  const outPaper = !job ? false : server ? !server.fits_paper : !!dist && Object.values(dist.paper).some((v) => v < -0.25)
  const outWork = !!workArea && (server ? server.out_of_work_area : !!dist?.work && Object.values(dist.work).some((v) => v < -1))

  const machineBBox = (): number[] | null => {
    if (server?.bbox) return server.bbox
    if (!job) return null
    const a = pageToMachine(origin, pw, ph, { x: job.x, y: job.y }, job)
    const b = pageToMachine(origin, pw, ph, { x: job.x + job.w, y: job.y + job.h }, job)
    return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]
  }
  const frame = async () => {
    const bb = machineBBox()
    if (!bb) return
    setFraming(true)
    await runFrame(bb, mode)
    setFraming(false)
  }

  const onDown = (e: React.PointerEvent) => {
    const svg = svgRef.current
    if (!svg) return
    const r = svg.getBoundingClientRect()
    const k = (x1 - x0) / r.width
    drag.current = { x: e.clientX, y: e.clientY, dx: placement.dx, dy: placement.dy, k: Math.max(k, (y1 - y0) / r.height) }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = Math.round(d.dx + (e.clientX - d.x) * d.k)
    const dy = Math.round(d.dy + (e.clientY - d.y) * d.k)
    useStudio.getState().setPlacement({ dx, dy })
  }
  const L = Math.max(20, (x1 - x0) * 0.08)
  const sw = (x1 - x0) / 400 // ~1px

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" onOpenAutoFocus={(e) => e.preventDefault()} className={cn(compact ? 'h-[100dvh] max-h-none w-screen max-w-none rounded-none' : 'h-[min(640px,calc(100dvh-32px))] max-w-[920px]')}>
        <div className="flex h-full min-h-0 flex-col">
          <div className="hairline-b flex shrink-0 items-center gap-2 px-5 py-3 pr-12">
            <DialogTitle>位置预览</DialogTitle>
            <Help topic="原点" />
            <span className="truncate text-footnote text-secondary-label">{anchored ? '笔停在要写内容的角上，纸张相对它的位置' : '纸张、原点和要写的范围'}</span>
          </div>
          <div className={cn('flex min-h-0 flex-1', compact && 'flex-col overflow-y-auto')}>
            <div className="relative min-h-[300px] min-w-0 flex-1 bg-canvas-desk p-3">
              <svg ref={svgRef} viewBox={`${x0} ${y0} ${x1 - x0} ${y1 - y0}`} className="h-full w-full touch-none" role="img" aria-label="位置预览图">
                <defs>
                  <pattern id="pos-hatch" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1={0} y1={0} x2={0} y2={6} stroke="rgb(var(--red))" strokeWidth={1.2} opacity={0.5} />
                  </pattern>
                </defs>
                {work ? (
                  <>
                    <rect x={work.x} y={work.y} width={work.w} height={work.h} fill="rgb(var(--travel) / 0.06)" stroke="rgb(var(--travel))" strokeWidth={sw * 1.5} strokeDasharray={`${sw * 6} ${sw * 4}`} />
                    <text x={work.x + sw * 6} y={work.y + work.h + sw * 16} fontSize={sw * 12} fill="rgb(var(--travel))" fontWeight={600}>
                      机器行程 {workArea!.w_mm}×{workArea!.h_mm} mm
                    </text>
                  </>
                ) : null}
                <rect x={0} y={0} width={pw} height={ph} fill="rgb(var(--canvas-paper))" style={{ filter: 'drop-shadow(0 1px 3px rgb(0 0 0 / 0.15))' }} />
                <BackgroundImage bg={bg} />
                <text x={pw - sw * 6} y={ph - sw * 8} textAnchor="end" fontSize={sw * 12} fill="rgb(var(--secondary-label) / var(--secondary-label-a))">
                  纸张 {pw}×{ph} mm
                </text>
                {job ? (
                  <g onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (drag.current = null)} onPointerCancel={() => (drag.current = null)} style={{ cursor: 'move' }}>
                    <rect x={job.x} y={job.y} width={job.w} height={job.h} fill={outWork ? 'url(#pos-hatch)' : 'rgb(var(--accent) / 0.12)'} stroke={outWork ? 'rgb(var(--red))' : outPaper ? 'rgb(var(--orange))' : 'rgb(var(--accent))'} strokeWidth={sw * 2} />
                    {/* frame path: corner order */}
                    {[
                      [job.x, job.y],
                      [job.x + job.w, job.y],
                      [job.x + job.w, job.y + job.h],
                      [job.x, job.y + job.h],
                    ].map(([x, y], i) => (
                      <g key={i}>
                        <circle cx={x} cy={y} r={sw * 7} fill="rgb(var(--accent))" />
                        <text x={x} y={y + sw * 4} textAnchor="middle" fontSize={sw * 10} fill="#fff" fontWeight={700}>
                          {i + 1}
                        </text>
                      </g>
                    ))}
                    <text x={job.x + job.w / 2} y={job.y + job.h / 2} textAnchor="middle" fontSize={sw * 12} fill="rgb(var(--accent))" fontWeight={600}>
                      要写的范围 {job.w.toFixed(0)}×{job.h.toFixed(0)}
                    </text>
                  </g>
                ) : null}
                {/* origin + axes */}
                <g transform={`translate(${o.x} ${o.y})`} pointerEvents="none">
                  <line x1={0} y1={0} x2={ax.x.x * L} y2={ax.x.y * L} stroke="rgb(var(--axis-x))" strokeWidth={sw * 2.5} />
                  <text x={ax.x.x * (L + sw * 10)} y={ax.x.y * (L + sw * 10) + sw * 4} fontSize={sw * 12} fill="rgb(var(--axis-x))" fontWeight={700} textAnchor="middle">
                    +X
                  </text>
                  <line x1={0} y1={0} x2={ax.y.x * L} y2={ax.y.y * L} stroke="rgb(var(--axis-y))" strokeWidth={sw * 2.5} />
                  <text x={ax.y.x * (L + sw * 10)} y={ax.y.y * (L + sw * 10) + sw * 4} fontSize={sw * 12} fill="rgb(var(--axis-y))" fontWeight={700} textAnchor="middle">
                    +Y
                  </text>
                  <circle r={sw * 6} fill="rgb(var(--bg))" stroke="rgb(var(--axis-origin))" strokeWidth={sw * 2} />
                  <text x={(origin.corner === 1 || origin.corner === 3 ? -1 : 1) * sw * 12} y={(origin.corner === 2 || origin.corner === 3 ? -1 : 1) * sw * 22} textAnchor={origin.corner === 1 || origin.corner === 3 ? 'end' : 'start'} fontSize={sw * 12} fill="rgb(var(--axis-origin))" fontWeight={600}>
                    {odrag.dragging ? `把笔停在这里，抬笔${odrag.label ? ` · 吸附 ${odrag.label}` : ''}` : anchored ? '原点 · 开始前笔停在这里（内容的角）' : '原点 · 开始前笔停在这里（纸张的角）'}
                  </text>
                </g>
                {!readOnly ? (
                  <circle cx={o.x} cy={o.y} r={sw * (compact ? 22 : 12)} fill="transparent" style={{ cursor: odrag.dragging ? 'grabbing' : 'grab' }} {...odrag.handlers} role="button" aria-label="拖动原点（开始前笔停的位置）">
                    <title>拖动原点：开始前把笔抬起停在这里</title>
                  </circle>
                ) : null}
              </svg>
              <p className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-1 rounded-md bg-bg/80 px-2 py-1 text-footnote text-secondary-label">
                <Move className="size-3.5" /> 拖动蓝框只调整这次打印的位置（不改设计）；拖动原点改开始前笔停的位置
              </p>
            </div>
            <aside className={cn('flex shrink-0 flex-col gap-3 p-4', compact ? 'hairline-t' : 'hairline-l w-72 overflow-y-auto')}>
              {outWork ? (
                <div className="flex items-start gap-2 rounded-lg bg-red/15 p-3 text-on-tint-red" role="alert">
                  <TriangleAlert className="mt-0.5 size-5 shrink-0" />
                  <div>
                    <div className="text-headline">超出机器行程</div>
                    <div className="text-footnote">写字机够不到的部分无法写出。移动范围或换小一点的纸。</div>
                  </div>
                </div>
              ) : outPaper ? (
                <div className="flex items-start gap-2 rounded-lg bg-orange/15 p-3 text-on-tint-orange" role="alert">
                  <TriangleAlert className="mt-0.5 size-5 shrink-0" />
                  <div>
                    <div className="text-headline">会写到纸外</div>
                    <div className="text-footnote">要写的范围超出了纸张边缘。</div>
                  </div>
                </div>
              ) : job ? (
                <div className="rounded-lg bg-green/15 p-3 text-headline text-on-tint-green">{workArea ? '放得下：在纸张和行程之内' : '放得下：在纸张之内'}</div>
              ) : (
                <p className="text-footnote text-secondary-label">本页还没有可写的内容。</p>
              )}
              <div className="flex flex-col gap-2 rounded-lg bg-blue/10 p-3">
                <div className="text-headline text-label">把笔停在这里，抬笔</div>
                <p className="text-footnote tabular-nums text-secondary-label">{parkText(origin, pw, ph, job, true)}</p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex items-center gap-1 text-footnote text-secondary-label">
                    偏移 X
                    <NumberField value={origin.offset_x_mm} onChange={(v) => applyOriginOffsets(origin, { offset_x_mm: v, offset_y_mm: origin.offset_y_mm }, false)} unit="mm" step={0.5} stepper={false} disabled={readOnly} className="min-w-0 flex-1" aria-label="原点偏移 X" />
                  </label>
                  <label className="flex items-center gap-1 text-footnote text-secondary-label">
                    Y
                    <NumberField value={origin.offset_y_mm} onChange={(v) => applyOriginOffsets(origin, { offset_x_mm: origin.offset_x_mm, offset_y_mm: v }, false)} unit="mm" step={0.5} stepper={false} disabled={readOnly} className="min-w-0 flex-1" aria-label="原点偏移 Y" />
                  </label>
                </div>
                <p className="text-caption text-tertiary-label">偏移自{anchored ? '内容' : '纸张'}的{['左上', '右上', '左下', '右下'][origin.corner]}角向内量；拖动左图的原点也可以。</p>
              </div>
              {job ? (
                <p className="rounded-lg bg-fill/60 p-3 text-footnote text-secondary-label">
                  开始前：把笔（抬起状态）停在{anchored ? `要写内容的${['左上', '右上', '左下', '右下'][origin.corner]}角` : `纸张${['左上', '右上', '左下', '右下'][origin.corner]}角`}
                  {origin.offset_x_mm || origin.offset_y_mm ? `（向内偏移 ${origin.offset_x_mm}, ${origin.offset_y_mm} mm）` : ''}。
                  {anchored ? '纸张不用对准机器，只要笔停的位置对。' : null}
                </p>
              ) : null}
              <div>
                <h3 className="mb-1 text-footnote font-semibold text-secondary-label">本次位置偏移（不改设计）</h3>
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex items-center gap-1 text-footnote text-secondary-label">
                    X
                    <NumberField value={placement.dx} onChange={(v) => useStudio.getState().setPlacement({ ...placement, dx: v })} unit="mm" step={1} stepper={false} className="min-w-0 flex-1" />
                  </label>
                  <label className="flex items-center gap-1 text-footnote text-secondary-label">
                    Y
                    <NumberField value={placement.dy} onChange={(v) => useStudio.getState().setPlacement({ ...placement, dy: v })} unit="mm" step={1} stepper={false} className="min-w-0 flex-1" />
                  </label>
                </div>
                {placement.dx || placement.dy ? (
                  <Button size="sm" variant="plain" icon={<RotateCcw />} className="mt-1 -ml-2" onClick={() => useStudio.getState().setPlacement({ dx: 0, dy: 0 })}>
                    归零
                  </Button>
                ) : null}
              </div>
              {dist ? (
                <>
                  <Distances title="距纸边" d={dist.paper} />
                  {dist.work ? <Distances title="距行程边界" d={dist.work} tol={1} /> : null}
                </>
              ) : null}
              <div className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-separator">
                <div className="flex items-center gap-1 text-headline">
                  走边框 <Help topic="走边框" />
                </div>
                <p className="text-footnote text-secondary-label">按 1→2→3→4 的顺序沿蓝框走一圈。</p>
                <Segmented value={mode} onValueChange={setMode} options={[{ value: 'up', label: '抬笔' }, { value: 'down_light', label: '轻画' }, { value: 'corners', label: '四角' }]} size="sm" block />
                <Button variant="tinted" icon={<Crosshair />} loading={framing} disabled={!machine?.connected || !!machine?.busy || !job} onClick={frame}>
                  {machine?.connected ? '走边框' : '先连接写字机'}
                </Button>
              </div>
            </aside>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Distances({ title, d, tol = 0.25 }: { title: string; d: { l: number; t: number; r: number; b: number }; tol?: number }) {
  const cell = (label: string, v: number) => (
    <div className={cn('flex flex-col items-center rounded-md py-1', v < -tol ? 'bg-red/15 text-on-tint-red' : 'bg-fill/50')}>
      <span className="text-footnote text-secondary-label">{label}</span>
      <span className="text-body font-medium tabular-nums">{v.toFixed(1)}</span>
    </div>
  )
  return (
    <div>
      <h3 className="mb-1 text-footnote font-semibold text-secondary-label">{title}（mm）</h3>
      <div className="grid grid-cols-4 gap-1">
        {cell('左', d.l)}
        {cell('上', d.t)}
        {cell('右', d.r)}
        {cell('下', d.b)}
      </div>
    </div>
  )
}
