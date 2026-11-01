/** Screen-space overlays: rulers, origin + axis arrows, selection frame & handles, guides. */
import type { OriginSpec } from '@/api/studio'
import type { Box, Pt, SnapLine } from '../geometry'
import { machineAxes, originAnchor, originPoint, type ContentBox } from '../model'

export interface Viewport {
  zoom: number
  panX: number
  panY: number
  width: number
  height: number
}

export const sx = (v: Viewport, x: number) => v.panX + x * v.zoom
export const sy = (v: Viewport, y: number) => v.panY + y * v.zoom

export const RULER = 20

function niceStep(zoom: number) {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500]
  return steps.find((s) => s * zoom >= 56) ?? 1000
}

export function Rulers({ v, highlight }: { v: Viewport; highlight: Box | null }) {
  const step = niceStep(v.zoom)
  const minor = step / (step % 5 === 0 || step === 1 ? 5 : 4)
  const ticksX: React.ReactNode[] = []
  const ticksY: React.ReactNode[] = []
  const labels: React.ReactNode[] = []
  const x0 = Math.floor(-v.panX / v.zoom / minor) * minor
  const x1 = (v.width - v.panX) / v.zoom
  for (let x = x0; x <= x1; x += minor) {
    const X = sx(v, x)
    if (X < RULER) continue
    const major = Math.abs(x / step - Math.round(x / step)) < 1e-6
    ticksX.push(<line key={`x${x.toFixed(2)}`} x1={X} x2={X} y1={major ? 9 : 15} y2={RULER} />)
    if (major) labels.push(<text key={`tx${x.toFixed(2)}`} x={X + 3} y={10}>{Math.round(x)}</text>)
  }
  const y0 = Math.floor(-v.panY / v.zoom / minor) * minor
  const y1 = (v.height - v.panY) / v.zoom
  for (let y = y0; y <= y1; y += minor) {
    const Y = sy(v, y)
    if (Y < RULER) continue
    const major = Math.abs(y / step - Math.round(y / step)) < 1e-6
    ticksY.push(<line key={`y${y.toFixed(2)}`} y1={Y} y2={Y} x1={major ? 9 : 15} x2={RULER} />)
    if (major)
      labels.push(
        <text key={`ty${y.toFixed(2)}`} x={10} y={Y + 3} transform={`rotate(-90 10 ${Y + 3})`} textAnchor="end">
          {Math.round(y)}
        </text>,
      )
  }
  return (
    <g className="pointer-events-none select-none" aria-hidden fontSize={10} style={{ fontVariantNumeric: 'tabular-nums' }}>
      <rect x={0} y={0} width={v.width} height={RULER} fill="rgb(var(--bg) / 0.86)" />
      <rect x={0} y={0} width={RULER} height={v.height} fill="rgb(var(--bg) / 0.86)" />
      {highlight ? (
        <>
          <rect x={sx(v, highlight.x)} y={0} width={highlight.w * v.zoom} height={RULER} fill="rgb(var(--accent) / 0.15)" />
          <rect x={0} y={sy(v, highlight.y)} width={RULER} height={highlight.h * v.zoom} fill="rgb(var(--accent) / 0.15)" />
        </>
      ) : null}
      <g stroke="rgb(var(--secondary-label) / var(--secondary-label-a))" strokeWidth={0.5}>
        {ticksX}
        {ticksY}
      </g>
      <g fill="rgb(var(--secondary-label) / var(--secondary-label-a))" stroke="none">
        {labels}
      </g>
      <line x1={0} x2={v.width} y1={RULER - 0.25} y2={RULER - 0.25} stroke="rgb(var(--separator) / var(--separator-a))" strokeWidth={0.5} />
      <line y1={0} y2={v.height} x1={RULER - 0.25} x2={RULER - 0.25} stroke="rgb(var(--separator) / var(--separator-a))" strokeWidth={0.5} />
      <rect x={0} y={0} width={RULER} height={RULER} fill="rgb(var(--bg))" />
      <text x={RULER / 2} y={RULER / 2 + 3.5} textAnchor="middle" fontSize={9} fill="rgb(var(--tertiary-label) / var(--tertiary-label-a))">
        mm
      </text>
    </g>
  )
}

function Arrow({ len, color, label, angle }: { len: number; color: string; label: string; angle: number }) {
  const head = 7
  return (
    <g style={{ transform: `rotate(${angle}deg)`, transition: 'transform var(--dur-base) var(--ease-standard)' }}>
      <line x1={0} y1={0} x2={len - head + 1} y2={0} stroke={color} strokeWidth={1.75} strokeLinecap="round" />
      <path d={`M${len} 0 L${len - head} ${-head / 2.1} L${len - head} ${head / 2.1} Z`} fill={color} />
      <g style={{ transform: `translate(${len + 9}px, 0) rotate(${-angle}deg)`, transition: 'transform var(--dur-base) var(--ease-standard)' }}>
        <text x={0} y={3.5} textAnchor="middle" fontSize={11} fontWeight={600} fill={color}>
          {label}
        </text>
      </g>
    </g>
  )
}

export function OriginOverlay({ v, origin, paperW, paperH, showAxes, showMarker, content, draggable, touch, dragging }: {
  v: Viewport
  origin: OriginSpec
  paperW: number
  paperH: number
  showAxes: boolean
  showMarker: boolean
  content?: ContentBox
  /** marker can be dragged (canvas handles `data-handle="origin"`) */
  draggable?: boolean
  touch?: boolean
  /** while dragging: snap label + physical distances */
  dragging?: { snap: string | null; where: string } | null
}) {
  const o = originPoint(origin, paperW, paperH, content)
  const ax = machineAxes(origin)
  const X = sx(v, o.x)
  const Y = sy(v, o.y)
  const len = Math.max(36, 24 * v.zoom)
  const angX = (Math.atan2(ax.x.y, ax.x.x) * 180) / Math.PI
  const angY = (Math.atan2(ax.y.y, ax.y.x) * 180) / Math.PI
  // label offset: away from the page interior
  const right = origin.corner === 1 || origin.corner === 3
  const bottom = origin.corner === 2 || origin.corner === 3
  const anchored = originAnchor(origin) === 'content' && !!content
  return (
    <>
    {anchored && showMarker ? (
      <rect
        x={sx(v, content.x)}
        y={sy(v, content.y)}
        width={content.w * v.zoom}
        height={content.h * v.zoom}
        fill="none"
        stroke="rgb(var(--axis-origin))"
        strokeWidth={1}
        strokeDasharray="4 3"
        opacity={0.55}
        className="pointer-events-none"
      />
    ) : null}
    <g transform={`translate(${X} ${Y})`} className="pointer-events-none select-none" role="img" aria-label={anchored ? '原点（内容左上角）与坐标轴' : '原点与坐标轴'}>
      {showAxes ? (
        <>
          <Arrow len={len} color="rgb(var(--axis-x))" label="+X" angle={angX} />
          <Arrow len={len} color="rgb(var(--axis-y))" label="+Y" angle={angY} />
        </>
      ) : null}
      {showMarker ? (
        <g>
          <circle r={6} fill="rgb(var(--bg) / 0.9)" stroke="rgb(var(--axis-origin))" strokeWidth={1.5} />
          <line x1={-9} x2={9} y1={0} y2={0} stroke="rgb(var(--axis-origin))" strokeWidth={1.25} />
          <line y1={-9} y2={9} x1={0} x2={0} stroke="rgb(var(--axis-origin))" strokeWidth={1.25} />
          <text
            x={right ? -12 : 12}
            y={bottom ? 20 : -10}
            textAnchor={right ? 'end' : 'start'}
            fontSize={11}
            fontWeight={500}
            fill="rgb(var(--axis-origin))"
            style={{ paintOrder: 'stroke', stroke: anchored ? 'rgb(var(--canvas-paper))' : 'rgb(var(--canvas-desk))', strokeWidth: 3 }}
          >
            {anchored ? '原点 · 开始前笔停这里' : '原点 (0,0)'}
          </text>
        </g>
      ) : null}
    </g>
    {showMarker && draggable ? (
      <g transform={`translate(${X} ${Y})`} data-handle="origin" style={{ cursor: dragging ? 'grabbing' : 'grab' }} role="button" aria-label="拖动原点：设定开始前笔停的位置">
        <circle r={touch ? 22 : 11} fill="transparent" />
        <title>拖动原点（写字起点）：开始前把笔抬起停在这里。按住 ⌘/Ctrl 不吸附</title>
      </g>
    ) : null}
    {dragging ? (
      <g transform={`translate(${X + (right ? -14 : 14)} ${Y + (bottom ? -58 : 16)})`} className="pointer-events-none">
        <rect x={right ? -250 : 0} y={0} width={250} height={dragging.snap ? 58 : 42} rx={7} fill="rgb(30 30 30 / 0.86)" />
        <text x={right ? -240 : 10} y={17} fontSize={12} fontWeight={600} fill="#fff">把笔停在这里，抬笔</text>
        <text x={right ? -240 : 10} y={34} fontSize={11} fill="#fff" style={{ fontVariantNumeric: 'tabular-nums' }}>{dragging.where}</text>
        {dragging.snap ? <text x={right ? -240 : 10} y={50} fontSize={11} fill="rgb(var(--pink))">吸附：{dragging.snap}</text> : null}
      </g>
    ) : null}
    </>
  )
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const CURSOR: Record<Handle, string> = { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' }

/** Point on a frame (rotation-frame box) for a handle. */
export function handlePoint(b: Box, h: Handle): Pt {
  const x = h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : b.x + b.w / 2
  const y = h.includes('n') ? b.y : h.includes('s') ? b.y + b.h : b.y + b.h / 2
  return { x, y }
}

export function SelectionFrame({
  pts, handles, rotate, rotateAt, touch, rotation, label, dashed,
}: {
  /** 4 screen-space corners (nw, ne, se, sw) */
  pts: Pt[]
  handles: { h: Handle; p: Pt }[]
  rotate: boolean
  rotateAt: Pt | null
  touch: boolean
  rotation: number
  label?: string
  dashed?: boolean
}) {
  const hit = touch ? 44 : 16
  const vis = 8
  return (
    <g>
      <polygon
        points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke="rgb(var(--accent))"
        strokeWidth={1}
        strokeDasharray={dashed ? '4 3' : undefined}
        className="pointer-events-none"
      />
      {rotate && rotateAt ? (
        <>
          <line x1={(pts[0].x + pts[1].x) / 2} y1={(pts[0].y + pts[1].y) / 2} x2={rotateAt.x} y2={rotateAt.y} stroke="rgb(var(--accent))" strokeWidth={1} className="pointer-events-none" />
          <g transform={`translate(${rotateAt.x} ${rotateAt.y})`} data-handle="rotate" style={{ cursor: 'grab' }}>
            <circle r={hit / 2} fill="transparent" />
            <circle r={7} fill="rgb(var(--bg-elevated))" stroke="rgb(var(--accent))" strokeWidth={1} />
            <path d="M-3.2 -1.2 A3.4 3.4 0 1 1 -2.4 2.4 M-3.6 -3.6 L-3.2 -1.2 L-0.9 -1.6" fill="none" stroke="rgb(var(--accent))" strokeWidth={1.2} strokeLinecap="round" />
            <title>旋转（Shift 15° 步进）</title>
          </g>
        </>
      ) : null}
      {handles.map(({ h, p }) => (
        <g key={h} transform={`translate(${p.x} ${p.y}) rotate(${rotation})`} data-handle={h} style={{ cursor: `${CURSOR[h]}-resize` }}>
          <rect x={-hit / 2} y={-hit / 2} width={hit} height={hit} fill="transparent" />
          <rect x={-vis / 2} y={-vis / 2} width={vis} height={vis} rx={1.5} fill="rgb(var(--bg-elevated))" stroke="rgb(var(--accent))" strokeWidth={1} />
        </g>
      ))}
      {label ? (
        <g transform={`translate(${Math.max(...pts.map((p) => p.x)) + 8} ${Math.max(...pts.map((p) => p.y)) + 4})`} className="pointer-events-none">
          <rect x={0} y={0} width={label.length * 6.2 + 10} height={18} rx={5} fill="rgb(30 30 30 / 0.8)" />
          <text x={5} y={12.5} fontSize={11} fill="#fff" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {label}
          </text>
        </g>
      ) : null}
    </g>
  )
}

export function Guides({ v, lines }: { v: Viewport; lines: SnapLine[] }) {
  return (
    <g className="pointer-events-none">
      {lines.map((l, i) =>
        l.axis === 'x' ? (
          <g key={i}>
            <line x1={sx(v, l.at)} x2={sx(v, l.at)} y1={0} y2={v.height} stroke="rgb(var(--guide))" strokeWidth={1} />
            <text x={sx(v, l.at) + 4} y={RULER + 14} fontSize={12} fill="rgb(var(--guide))">
              {l.label ? `${l.label} · ` : ''}
              {l.at.toFixed(1)} mm
            </text>
          </g>
        ) : (
          <g key={i}>
            <line y1={sy(v, l.at)} y2={sy(v, l.at)} x1={0} x2={v.width} stroke="rgb(var(--guide))" strokeWidth={1} />
            <text y={sy(v, l.at) - 4} x={RULER + 6} fontSize={12} fill="rgb(var(--guide))">
              {l.label ? `${l.label} · ` : ''}
              {l.at.toFixed(1)} mm
            </text>
          </g>
        ),
      )}
    </g>
  )
}
