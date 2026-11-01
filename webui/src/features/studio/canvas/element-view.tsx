import * as React from 'react'
import { api } from '@/api/client'
import type { Element, PaperBase } from '@/api/studio'
import { type Box, localBox, svgTransform } from '../geometry'
import { lastKeys } from '../actions'
import { useRender, type ElRender } from '../render-engine'

/** Last successful render per element id, shown (dimmed) while a new version renders — avoids flicker while typing. */
const lastGood = new Map<string, ElRender>()

export function useElementRender(el: Element): { r: ElRender | undefined; stale: boolean } {
  const key = lastKeys.get(el.id)
  const r = useRender((s) => (key ? s.els[key] : undefined))
  if (r?.status === 'ok') {
    lastGood.set(el.id, r)
    return { r, stale: false }
  }
  const prev = lastGood.get(el.id)
  if (prev && r?.status !== 'error') return { r: prev, stale: true }
  return { r, stale: false }
}

export const ElementView = React.memo(function ElementView({
  el, paper, zoom, sub, dim, showSource, outPaper, outWork, hovered,
}: {
  el: Element
  paper: PaperBase
  zoom: number
  sub: number
  dim: boolean
  showSource: boolean
  outPaper: boolean
  outWork: boolean
  hovered: boolean
}) {
  const { r, stale } = useElementRender(el)
  const lb = localBox(el, paper, r?.bbox)
  const strokeW = Math.max(0.9, 0.3 * zoom)
  const d = el.type === 'flow_text' ? r?.pages?.[sub]?.d ?? (sub === 0 ? r?.d : '') : r?.d
  const isSourceImage = el.type === 'image' && (showSource || !d)
  return (
    <g transform={svgTransform(el.transform)} opacity={el.hidden ? 0.3 : 1} data-el={el.id}>
      {isSourceImage && el.type === 'image' ? (
        <image
          href={api.url(`/files/${el.props.file_id}/content`)}
          x={0}
          y={0}
          width={lb.w}
          height={lb.h}
          preserveAspectRatio="none"
          opacity={d ? 0.35 : 0.6}
          style={{ pointerEvents: 'none' }}
        />
      ) : null}
      {d ? (
        <path
          d={d}
          fill="none"
          stroke="rgb(var(--ink))"
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          opacity={dim ? 0.18 : stale ? 0.45 : 1}
          style={{ pointerEvents: 'none' }}
        />
      ) : null}
      {!d && (!r || r.status === 'pending') && sub === 0 ? <Placeholder box={lb} label={r?.progress ? `渲染中 ${Math.round(r.progress * 100)}%` : '渲染中…'} /> : null}
      {r?.status === 'error' && sub === 0 ? <Placeholder box={lb} label={r.error ?? '渲染失败'} error /> : null}
      {outPaper || outWork ? (
        <rect
          x={lb.x}
          y={lb.y}
          width={lb.w}
          height={lb.h}
          fill={outWork ? 'url(#pp-hatch-red)' : 'none'}
          stroke={outWork ? 'rgb(var(--red))' : 'rgb(var(--orange))'}
          strokeWidth={1.25}
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: 'none' }}
        />
      ) : null}
      {hovered ? (
        <rect x={lb.x} y={lb.y} width={lb.w} height={lb.h} fill="none" stroke="rgb(var(--accent))" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={0.7} style={{ pointerEvents: 'none' }} />
      ) : null}
      {/* hit area */}
      <rect
        x={lb.x}
        y={lb.y}
        width={Math.max(lb.w, 2 / zoom)}
        height={Math.max(lb.h, 2 / zoom)}
        fill="transparent"
        data-el-id={el.locked || sub > 0 ? undefined : el.id}
        style={{ pointerEvents: el.locked || sub > 0 ? 'none' : 'all', cursor: 'move' }}
      />
    </g>
  )
})

function Placeholder({ box, label, error }: { box: Box; label: string; error?: boolean }) {
  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        fill={error ? 'rgb(var(--red) / 0.06)' : 'rgb(var(--gray) / 0.06)'}
        stroke={error ? 'rgb(var(--red))' : 'rgb(var(--gray))'}
        strokeDasharray="4 3"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <text
        x={box.x + 1}
        y={box.y + Math.min(3, box.h * 0.4) + 0.6}
        fontSize={Math.min(3, box.h * 0.4)}
        fill={error ? 'rgb(var(--red))' : 'rgb(var(--gray))'}
      >
        <title>{label}</title>
        {label.length > box.w / 2.6 ? `${label.slice(0, Math.max(2, Math.floor(box.w / 2.6) - 1))}…` : label}
      </text>
    </g>
  )
}
