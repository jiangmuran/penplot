/**
 * Synthetic plot G-code for FakeGrbl: `segments` short pen-down strokes on a 10-column grid.
 * At PENPLOT_FAKE_TIME_SCALE=0.05, ~100 segments take ~3 s; use 600+ when a test needs time to act.
 */
export function plotGcode(segments: number, opts: { size?: number; feed?: number; extra?: string[] } = {}) {
  const size = opts.size ?? 4
  const feed = opts.feed ?? 1500
  const lines = ['G21', 'G90', 'G0 Z0']
  for (let i = 0; i < segments; i++) {
    const x = (i % 10) * (size + 1)
    const y = -(Math.floor(i / 10) % 40) * (size + 1)
    lines.push(`G0 X${x} Y${y}`, 'G1 Z8 F5000', `G1 X${x + size} Y${y - size} F${feed}`, 'G1 Z0 F5000')
    if (opts.extra && i === Math.floor(segments / 2)) lines.push(...opts.extra)
  }
  lines.push('G0 X0 Y0')
  return lines.join('\n') + '\n'
}
