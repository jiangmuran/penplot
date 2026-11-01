import * as React from 'react'
import { cn } from '@/lib/cn'

/** Bounding box of an SVG path made of M/L absolute commands (what the glyph endpoint returns). */
export function pathBBox(d: string): [number, number, number, number] | null {
  const nums = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi)
  if (!nums || nums.length < 2) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = Number(nums[i])
    const y = Number(nums[i + 1])
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return [x0, y0, x1, y1]
}

/**
 * A single-line glyph, centred in a square box. All glyphs of a font share the same scale (based on
 * the font's `ref_size`) unless the glyph is larger, so relative sizes stay visible in the grid.
 */
export function GlyphSvg({
  d, refSize, className, strokeWidth = 1.4, title,
}: { d: string; refSize: number; className?: string; strokeWidth?: number; title?: string }) {
  const vb = React.useMemo(() => {
    const bb = pathBBox(d)
    const side0 = refSize * 0.72
    if (!bb) return `${-side0 / 2} ${-side0 / 2} ${side0} ${side0}`
    const [x0, y0, x1, y1] = bb
    const side = Math.max(side0, (x1 - x0) * 1.15, (y1 - y0) * 1.15)
    const cx = (x0 + x1) / 2
    const cy = (y0 + y1) / 2
    return `${cx - side / 2} ${cy - side / 2} ${side} ${side}`
  }, [d, refSize])
  return (
    <svg viewBox={vb} className={cn('block', className)} role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export function cpLabel(cp: number) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`
}
