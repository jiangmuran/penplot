/** Inline SVG illustrations for the setup wizard (theme-aware: currentColor + CSS variables). */
import { cn } from '@/lib/cn'

const ink = 'var(--color-label)'
const muted = 'var(--color-tertiary-label)'
const accent = 'var(--color-accent)'
const paper = 'var(--color-canvas-paper)'
const desk = 'var(--color-canvas-desk)'

function Frame({ children, className, label, vb = '0 0 320 200' }: { children: React.ReactNode; className?: string; label: string; vb?: string }) {
  return (
    <svg viewBox={vb} role="img" aria-label={label} className={cn('h-auto w-full select-none', className)} fill="none" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  )
}

/** The plotter writing on a sheet. */
export function PlotterArt({ className }: { className?: string }) {
  return (
    <Frame className={className} label="写字机在纸上写字">
      <rect x="10" y="20" width="300" height="170" rx="14" fill={desk} />
      {/* rails */}
      <rect x="28" y="34" width="264" height="10" rx="5" fill="var(--color-gray4)" />
      <rect x="28" y="34" width="10" height="142" rx="5" fill="var(--color-gray4)" />
      {/* paper */}
      <g style={{ filter: 'drop-shadow(0 2px 4px rgb(0 0 0 / 0.12))' }}>
        <rect x="70" y="62" width="180" height="116" rx="3" fill={paper} />
      </g>
      <path d="M92 92c8-10 14 6 22-2s10-8 16 0 12 2 18-4M92 112c12-4 20 2 30-2s16 4 26 0M92 132c10-6 18 2 28-2" stroke={ink} strokeWidth="2.2" />
      <path d="M150 128c6-6 10 2 16-2" stroke={accent} strokeWidth="2.4" strokeDasharray="0" className="animate-[pulse_2s_ease-in-out_infinite]" />
      {/* gantry + pen */}
      <rect x="150" y="30" width="28" height="22" rx="5" fill="var(--color-gray3)" />
      <rect x="160" y="50" width="8" height="64" rx="3" fill="var(--color-gray2)" />
      <path d="M164 114l-5 10h10z" fill={accent} />
      <circle cx="164" cy="126" r="2.4" fill={accent} />
    </Frame>
  )
}

/** USB cable from controller box to the plotter. */
export function ConnectArt({ connected, className }: { connected?: boolean; className?: string }) {
  const c = connected ? 'var(--color-green)' : muted
  return (
    <Frame className={className} label="用 USB 线连接控制盒和写字机">
      <rect x="20" y="70" width="84" height="60" rx="10" fill="var(--color-gray5)" stroke={muted} strokeWidth="1.5" />
      <circle cx="40" cy="118" r="4" fill={connected ? 'var(--color-green)' : 'var(--color-gray3)'} />
      <text x="62" y="104" textAnchor="middle" fontSize="11" fill={ink} fontFamily="system-ui">控制盒</text>
      <rect x="216" y="60" width="90" height="80" rx="12" fill="var(--color-gray5)" stroke={muted} strokeWidth="1.5" />
      <path d="M232 84h58M232 84v40" stroke="var(--color-gray3)" strokeWidth="6" />
      <text x="262" y="132" textAnchor="middle" fontSize="11" fill={ink} fontFamily="system-ui">写字机</text>
      <path d="M104 100c40 0 40 -30 70 -30s20 30 42 30" stroke={c} strokeWidth="4" strokeDasharray={connected ? '0' : '6 6'} />
      <rect x="98" y="94" width="10" height="12" rx="2" fill={c} />
      <rect x="208" y="94" width="10" height="12" rx="2" fill={c} />
      {connected ? (
        <g>
          <circle cx="160" cy="44" r="14" fill="var(--color-green)" />
          <path d="M153 44l5 5 9-10" stroke="white" strokeWidth="3" />
        </g>
      ) : null}
    </Frame>
  )
}

/** Side view: pen above the paper, Z0 = up, Z grows downward; the touch point. */
export function PenZArt({ z, touchZ, downZ, className }: { z: number; touchZ?: number; downZ?: number; className?: string }) {
  // map z (0..12 mm) to y px; paper surface at y=150 ↔ touchZ (or 8)
  const surf = touchZ ?? 8
  const k = 9
  const tipY = 150 - (surf - z) * k
  return (
    <Frame className={className} label={`笔的侧视图：当前 Z ${z.toFixed(1)} 毫米`}>
      <rect x="0" y="150" width="320" height="40" fill={desk} />
      <rect x="40" y="146" width="240" height="6" rx="1" fill={paper} stroke={muted} strokeWidth="1" />
      {/* scale */}
      <path d="M250 40v110" stroke={muted} strokeWidth="1" />
      {[0, 2, 4, 6, 8, 10, 12].map((v) => {
        const y = 150 - (surf - v) * k
        if (y < 20 || y > 175) return null
        return (
          <g key={v}>
            <path d={`M246 ${y}h8`} stroke={muted} />
            <text x="260" y={y + 4} fontSize="10" fill={muted} fontFamily="system-ui">Z{v}</text>
          </g>
        )
      })}
      {/* Z0 marker */}
      <path d={`M120 ${150 - surf * k}h120`} stroke={accent} strokeDasharray="4 4" />
      <text x="124" y={150 - surf * k - 6} fontSize="10" fill={accent} fontFamily="system-ui">Z0 抬笔（停放）</text>
      {downZ != null ? (
        <>
          <path d={`M120 ${150 - (surf - downZ) * k}h120`} stroke="var(--color-orange)" strokeDasharray="4 4" />
          <text x="124" y={150 - (surf - downZ) * k + 14} fontSize="10" fill="var(--color-orange)" fontFamily="system-ui">落笔 Z{downZ.toFixed(1)}</text>
        </>
      ) : null}
      {/* pen */}
      <g style={{ transition: 'transform 200ms var(--ease-standard, ease)' }} transform={`translate(0 ${tipY - 150})`}>
        <rect x="74" y="40" width="22" height="92" rx="5" fill="var(--color-gray2)" />
        <rect x="74" y="40" width="22" height="18" rx="5" fill={accent} />
        <path d="M74 132h22l-11 18z" fill="var(--color-gray4)" />
        <path d="M82 144l3 6 3-6" fill={ink} />
      </g>
      <path d="M58 70v40m-6-6l6 8 6-8" stroke={muted} strokeWidth="1.5" />
      <text x="40" y="64" fontSize="10" fill={muted} fontFamily="system-ui">Z+ 向下</text>
    </Frame>
  )
}

/** Top view of a sheet: origin at the top-left of the content (not the paper corner), X right, Y down, frame outline. */
export function PaperOriginArt({ framing, className }: { framing?: boolean; className?: string }) {
  return (
    <Frame className={className} label="原点在要写内容的左上角，X 向右，Y 向下">
      <rect x="10" y="10" width="300" height="180" rx="14" fill={desk} />
      <rect x="80" y="30" width="160" height="150" rx="2" fill={paper} style={{ filter: 'drop-shadow(0 2px 4px rgb(0 0 0 / 0.12))' }} />
      {/* tape */}
      {[
        [72, 26, -35],
        [232, 26, 35],
        [72, 172, 35],
        [232, 172, -35],
      ].map(([x, y, r], i) => (
        <rect key={i} x={x} y={y} width="18" height="8" rx="1" fill="var(--color-yellow)" opacity="0.55" transform={`rotate(${r} ${x + 9} ${y + 4})`} />
      ))}
      {/* the content to be written starts at the origin (inside the paper, away from the clips) */}
      {[0, 1, 2, 3].map((i) => (
        <path key={`l${i}`} d={`M100 ${60 + i * 16}h${[110, 96, 116, 60][i]}`} stroke={muted} strokeWidth="3" strokeLinecap="round" opacity="0.45" />
      ))}
      {framing ? <rect x="96" y="46" width="128" height="96" fill="none" stroke={accent} strokeWidth="2" strokeDasharray="6 5" className="animate-[pulse_1.6s_ease-in-out_infinite]" /> : null}
      {/* axes */}
      <path d="M96 46h52m-6-5l6 5-6 5" stroke="var(--color-axis-x)" strokeWidth="2" />
      <path d="M96 46v46m-5-6l5 6 5-6" stroke="var(--color-axis-y)" strokeWidth="2" />
      <text x="154" y="50" fontSize="11" fill="var(--color-axis-x)" fontFamily="system-ui">X</text>
      <text x="92" y="106" fontSize="11" fill="var(--color-axis-y)" fontFamily="system-ui">Y</text>
      <circle cx="96" cy="46" r="7" fill="none" stroke={accent} strokeWidth="2" />
      <circle cx="96" cy="46" r="2.5" fill={accent} />
      <text x="20" y="40" fontSize="11" fill={ink} fontFamily="system-ui">原点</text>
      <path d="M46 40c20 0 30 2 40 4" stroke={muted} strokeWidth="1" />
    </Frame>
  )
}

/** Expected test result: 20 mm square and「你好」. */
export function TestSheetArt({ className }: { className?: string }) {
  return (
    <Frame className={className} label="试写效果：一个 2 厘米方块和你好两个字" vb="0 0 90 40">
      <rect x="0" y="0" width="90" height="40" rx="2" fill={paper} />
      <rect x="5" y="5" width="20" height="20" stroke={ink} strokeWidth="0.5" />
      <path d="M5 30h20M5 28.5v3M25 28.5v3" stroke={muted} strokeWidth="0.3" />
      <text x="15" y="35.5" textAnchor="middle" fontSize="3.4" fill={muted} fontFamily="system-ui">20 mm</text>
      <text x="32" y="21" fontSize="13" fill={ink} fontFamily="'Kaiti SC','STKaiti','KaiTi',serif">你好</text>
    </Frame>
  )
}

export function DoneArt({ className }: { className?: string }) {
  return (
    <Frame className={className} label="设置完成" vb="0 0 200 140">
      <circle cx="100" cy="70" r="46" fill="var(--color-green)" opacity="0.15" />
      <circle cx="100" cy="70" r="32" fill="var(--color-green)" />
      <path d="M86 70l10 10 19-21" stroke="white" strokeWidth="6" />
      {[
        [30, 30, 'var(--color-orange)'],
        [168, 34, 'var(--color-blue)'],
        [40, 112, 'var(--color-pink)'],
        [164, 108, 'var(--color-yellow)'],
        [100, 12, 'var(--color-purple)'],
      ].map(([x, y, c], i) => (
        <circle key={i} cx={x as number} cy={y as number} r="4" fill={c as string} />
      ))}
    </Frame>
  )
}
