import { ChevronDown, Frame, MousePointerClick } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { api } from '@/api/client'
import { qk } from '@/api/query'
import type { components } from '@/api/schema'
import { useJobActions, useJobs } from '@/api/jobs'
import { runAction } from './errors'
import { frameBox, moveTo, setPen } from '@/api/machine-control'
import { useLive } from '@/api/store'
import {
  Button, Card, CardHeader, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, FormRow, NumberField,
} from '@/components/ui'
import { confirm } from '@/lib/confirm'
import { formatNumber } from '@/lib/format'
import { HelpLink } from '@/features/help/HelpLink'
import type { MachineGate } from './gate'

type PaperSpec = components['schemas']['PaperSpec']

const CORNER_LABEL = ['左上', '右上', '左下', '右下']

/** Work-coordinate extent of the travel area for an origin corner (04 §9; machine space is y-up). */
function extent(corner: number, w: number, h: number) {
  const left = corner === 0 || corner === 2
  const top = corner === 0 || corner === 1
  return { xmin: left ? 0 : -w, xmax: left ? w : 0, ymin: top ? -h : 0, ymax: top ? 0 : h }
}

export function TravelMapCard({ gate, workW, workH, corner, feed }: { gate: MachineGate; workW: number; workH: number; corner: number; feed: number }) {
  const machine = useLive((s) => s.machine)
  const liveJob = useLive((s) => s.job)
  const queued = useJobs({ status: 'queued' })
  const { frame } = useJobActions()
  const [custom, setCustom] = React.useState(false)
  const svgRef = React.useRef<SVGSVGElement>(null)
  const [hover, setHover] = React.useState<[number, number] | null>(null)

  const e = extent(corner, workW, workH)
  const pad = Math.max(workW, workH) * 0.09
  const vb = `${-pad} ${-pad} ${workW + 2 * pad} ${workH + 2 * pad}`
  const sx = (x: number) => x - e.xmin
  const sy = (y: number) => e.ymax - y
  const pos = machine?.wpos ?? null
  const bbox = liveJob?.bbox ?? null
  const canClick = gate.canMove && !!machine?.origin_valid
  const grid = workW > 200 ? 50 : 20
  const axisLen = Math.min(workW, workH) * 0.12
  const tick = Math.max(workW, workH) / 42
  const paper = usePaper()

  const toWork = (ev: React.PointerEvent | React.MouseEvent): [number, number] | null => {
    const svg = svgRef.current
    if (!svg) return null
    const pt = svg.createSVGPoint()
    pt.x = ev.clientX
    pt.y = ev.clientY
    const m = svg.getScreenCTM()
    if (!m) return null
    const p = pt.matrixTransform(m.inverse())
    if (p.x < 0 || p.y < 0 || p.x > workW || p.y > workH) return null
    return [p.x + e.xmin, e.ymax - p.y]
  }

  const onClick = async (ev: React.MouseEvent) => {
    if (!canClick) return
    const w = toWork(ev)
    if (!w) return
    const [x, y] = w.map((v) => Math.round(v * 10) / 10)
    const ok = await confirm({ title: `移动到 X${x} Y${y}？`, description: '先抬笔，然后快速移动到该位置。', confirmLabel: '移动' })
    if (!ok) return
    await runAction('移动失败', async () => {
      await setPen('up')
      await moveTo(x, y)
    })
  }

  const frameables = (queued.data ?? []).filter((j) => j.bbox && j.bbox.length === 4)

  return (
    <Card className="flex flex-col">
      <CardHeader
        title={<span className="inline-flex items-center gap-1.5">行程图 <HelpLink topic="travel" /></span>}
        subtitle={`${workW} × ${workH} mm · 原点在${CORNER_LABEL[corner] ?? '左上'}角`}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="gray" icon={<Frame />} disabled={!gate.canMove}>
                走边框
                <ChevronDown className="-mr-1 size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-72">
              <DropdownMenuLabel>抬笔沿外框走一圈，再回到起点</DropdownMenuLabel>
              {frameables.length ? (
                frameables.slice(0, 8).map((j) => (
                  <DropdownMenuItem key={j.id} onSelect={() => frame.mutate(j.id)}>
                    <span className="truncate">{j.name}</span>
                  </DropdownMenuItem>
                ))
              ) : (
                <DropdownMenuItem disabled>队列中没有可走边框的任务</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCustom(true)}>自定义范围…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      <div className="relative flex-1 px-4 pb-4">
        <svg
          ref={svgRef}
          viewBox={vb}
          role="img"
          aria-label={`机器行程 ${workW}×${workH} 毫米，${pos ? `笔位置 X ${formatNumber(pos[0], 1)}，Y ${formatNumber(pos[1], 1)}` : '位置未知'}`}
          className={canClick ? 'w-full cursor-crosshair select-none' : 'w-full select-none'}
          style={{ maxHeight: 420 }}
          onClick={onClick}
          onPointerMove={(ev) => setHover(toWork(ev))}
          onPointerLeave={() => setHover(null)}
        >
          <rect x={0} y={0} width={workW} height={workH} rx={2} className="fill-canvas-paper stroke-separator" strokeWidth={0.6} />
          {Array.from({ length: Math.floor(workW / grid) - (workW % grid === 0 ? 1 : 0) }, (_, i) => (
            <line key={`gx${i}`} x1={(i + 1) * grid} x2={(i + 1) * grid} y1={0} y2={workH} className="stroke-separator" strokeWidth={0.4} />
          ))}
          {Array.from({ length: Math.floor(workH / grid) - (workH % grid === 0 ? 1 : 0) }, (_, i) => (
            <line key={`gy${i}`} y1={(i + 1) * grid} y2={(i + 1) * grid} x1={0} x2={workW} className="stroke-separator" strokeWidth={0.4} />
          ))}
          {paper ? (
            <g>
              <rect
                x={sx(e.xmin < 0 ? -paper.w : 0)}
                y={sy(e.ymin < 0 ? 0 : paper.h)}
                width={paper.w}
                height={paper.h}
                className="fill-bg-elevated stroke-secondary-label"
                strokeWidth={0.6}
                style={{ filter: 'drop-shadow(0 0.5px 1px rgb(0 0 0 / 0.15))' }}
              />
              <text
                x={sx(e.xmin < 0 ? -paper.w / 2 : paper.w / 2)}
                y={sy(e.ymin < 0 ? -paper.h / 2 : paper.h / 2)}
                textAnchor="middle"
                className="fill-secondary-label"
                style={{ fontSize: tick * 1.2 }}
              >
                {paper.name}
              </text>
            </g>
          ) : null}
          {Array.from({ length: Math.floor(workW / grid) + 1 }, (_, i) => (
            <text key={`tx${i}`} x={i * grid} y={workH + tick * 1.4} textAnchor="middle" className="fill-secondary-label" style={{ fontSize: tick }}>
              {i * grid}
            </text>
          ))}
          {Array.from({ length: Math.floor(workH / grid) + 1 }, (_, i) =>
            i === 0 ? null : (
              <text key={`ty${i}`} x={-tick * 0.5} y={i * grid + tick * 0.35} textAnchor="end" className="fill-secondary-label" style={{ fontSize: tick }}>
                {i * grid}
              </text>
            ),
          )}
          {bbox ? (
            <rect
              x={sx(bbox[0])}
              y={sy(bbox[3])}
              width={bbox[2] - bbox[0]}
              height={bbox[3] - bbox[1]}
              className="fill-accent/10 stroke-accent"
              strokeDasharray="3 2"
              strokeWidth={0.8}
            />
          ) : null}
          {/* origin + axes (arrows point into the drawable area) */}
          <g transform={`translate(${sx(0)} ${sy(0)})`}>
            <line x1={0} y1={0} x2={(e.xmin < 0 ? -1 : 1) * axisLen} y2={0} className="stroke-axis-x" strokeWidth={1.4} strokeLinecap="round" />
            <line x1={0} y1={0} x2={0} y2={(e.ymin < 0 ? 1 : -1) * axisLen} className="stroke-axis-y" strokeWidth={1.4} strokeLinecap="round" />
            <circle r={2.4} className="fill-axis-origin" />
            <text x={(e.xmin < 0 ? -1 : 1) * (axisLen + 2)} y={2.5} textAnchor={e.xmin < 0 ? 'end' : 'start'} className="fill-axis-x" style={{ fontSize: axisLen * 0.32, fontWeight: 600 }}>
              {e.xmin < 0 ? '← X' : 'X →'}
            </text>
            <text x={3} y={(e.ymin < 0 ? 1 : -1) * (axisLen + 2) + (e.ymin < 0 ? axisLen * 0.3 : 0)} className="fill-axis-y" style={{ fontSize: axisLen * 0.32, fontWeight: 600 }}>
              {e.ymin < 0 ? '↓ 纸张向下' : '↑ 纸张向上'}
            </text>
          </g>
          {pos ? (
            <g transform={`translate(${sx(pos[0])} ${sy(pos[1])})`}>
              <circle r={6} className="fill-accent/20" />
              <circle r={2.6} className={machine?.pen === 'down' ? 'fill-accent' : 'fill-bg-elevated stroke-accent'} strokeWidth={1.2} />
            </g>
          ) : null}
          {hover && canClick ? (
            <g transform={`translate(${sx(hover[0])} ${sy(hover[1])})`} pointerEvents="none">
              <line x1={-5} x2={5} className="stroke-secondary-label" strokeWidth={0.5} />
              <line y1={-5} y2={5} className="stroke-secondary-label" strokeWidth={0.5} />
            </g>
          ) : null}
        </svg>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-footnote text-secondary-label">
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-accent" />笔位置</span>
          {paper ? <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-[2px] border border-secondary-label bg-bg-elevated" />默认纸张 {paper.name}</span> : null}
          {bbox ? <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-[2px] border border-dashed border-accent" />当前任务范围</span> : null}
          <span className="ml-auto flex items-center gap-1 tabular-nums">
            {hover && canClick ? (
              <>
                <MousePointerClick className="size-3" /> X {hover[0].toFixed(1)} · Y {hover[1].toFixed(1)}
              </>
            ) : canClick ? (
              '点击图中位置可移动到该处'
            ) : null}
          </span>
        </div>
      </div>
      <CustomFrameDialog open={custom} onOpenChange={setCustom} workW={workW} workH={workH} corner={corner} feed={feed} />
    </Card>
  )
}

function CustomFrameDialog({ open, onOpenChange, workW, workH, corner, feed }: { open: boolean; onOpenChange: (o: boolean) => void; workW: number; workH: number; corner: number; feed: number }) {
  const [x, setX] = React.useState(0)
  const [y, setY] = React.useState(0)
  const [w, setW] = React.useState(Math.min(150, workW))
  const [h, setH] = React.useState(Math.min(200, workH))
  const [busy, setBusy] = React.useState(false)
  const sxs = corner === 1 || corner === 3 ? -1 : 1
  const sys = corner === 0 || corner === 1 ? -1 : 1
  const run = async () => {
    const xs = [x * sxs, (x + w) * sxs]
    const ys = [y * sys, (y + h) * sys]
    setBusy(true)
    const ok = await runAction('走边框失败', () => frameBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], feed))
    setBusy(false)
    if (ok) onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>自定义走边框</DialogTitle>
          <DialogDescription>从原点向纸内量取（毫米）。笔保持抬起。</DialogDescription>
        </DialogHeader>
        <DialogBody className="-mx-4">
          <FormRow label="距原点 X"><NumberField value={x} onChange={setX} min={0} max={workW} step={1} unit="mm" /></FormRow>
          <FormRow label="距原点 Y"><NumberField value={y} onChange={setY} min={0} max={workH} step={1} unit="mm" /></FormRow>
          <FormRow label="宽"><NumberField value={w} onChange={setW} min={1} max={workW} step={1} unit="mm" /></FormRow>
          <FormRow label="高"><NumberField value={h} onChange={setH} min={1} max={workH} step={1} unit="mm" /></FormRow>
        </DialogBody>
        <DialogFooter>
          <Button variant="gray" onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="filled" icon={<Frame />} loading={busy} onClick={run}>走边框</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Default paper (设置 › 偏好 default_paper) to draw on the map; null if unavailable. */
function usePaper(): { name: string; w: number; h: number } | null {
  const settings = useQuery({ queryKey: qk.settings, queryFn: () => api.get<{ default_paper?: string }>('/settings'), staleTime: 60_000 })
  const id = settings.data?.default_paper ?? 'a4-normal'
  const papers = useQuery({ queryKey: qk.papers.list(), queryFn: () => api.get<PaperSpec[]>('/papers'), staleTime: 60_000 })
  const list = Array.isArray(papers.data) ? papers.data : []
  const p = list.find((x) => x.id === id)
  if (!p) return null
  const land = p.orientation === 'landscape'
  return { name: p.name, w: land ? p.height_mm : p.width_mm, h: land ? p.width_mm : p.height_mm }
}
