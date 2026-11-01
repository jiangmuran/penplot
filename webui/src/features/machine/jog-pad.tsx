import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronsDown, ChevronsUp, House, Octagon } from 'lucide-react'
import * as React from 'react'
import { Card, CardHeader, Segmented, Switch, Tooltip } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useShortcut } from '@/lib/shortcuts'
import { useJogButton, useJogger, type JogVec } from './use-jog'

const STEPS = ['0.1', '1', '10', '50'] as const
type StepKey = (typeof STEPS)[number]

function loadStep(): StepKey {
  const v = localStorage.getItem('penplot.jogStep')
  return (STEPS as readonly string[]).includes(v ?? '') ? (v as StepKey) : '1'
}

function JogButton({
  jogger, vec, size, continuous, label, children, className, disabled,
}: {
  jogger: ReturnType<typeof useJogger>
  vec: JogVec
  size: number
  continuous: boolean
  label: string
  children: React.ReactNode
  className?: string
  disabled?: boolean
}) {
  const handlers = useJogButton(jogger, vec, size, continuous)
  const active = jogger.holding && jogger.holding.x === vec.x && jogger.holding.y === vec.y && jogger.holding.z === vec.z
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        {...handlers}
        className={cn(
          'press focus-ring flex touch-none select-none items-center justify-center rounded-lg bg-fill text-label transition-colors',
          'hover:bg-secondary-fill active:bg-accent/20 disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-6',
          active && 'bg-accent text-white hover:bg-accent',
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  )
}

/**
 * Jog pad (02-ux §3.7): XY cross + Z column, step sizes, optional press-and-hold continuous jog.
 * Keyboard: arrows = XY, PgUp/PgDn = Z (Shift ×10, Alt ×0.1).
 */
export function JogPad({
  feed, zFeed, zStep, enabled, reason, onHome, compact,
}: {
  feed: number
  zFeed: number
  zStep: number
  enabled: boolean
  reason: string | null
  onHome: () => void
  compact?: boolean
}) {
  const [stepKey, setStepKey] = React.useState<StepKey>(loadStep)
  const [continuous, setContinuous] = React.useState(() => localStorage.getItem('penplot.jogContinuous') === '1')
  const step = Number(stepKey)
  const jogger = useJogger({ feed, zFeed, enabled })
  const holdKey = React.useRef<string | null>(null)

  React.useEffect(() => localStorage.setItem('penplot.jogStep', stepKey), [stepKey])
  React.useEffect(() => localStorage.setItem('penplot.jogContinuous', continuous ? '1' : '0'), [continuous])

  const keyJog = (vec: JogVec, mult: number) => (e: KeyboardEvent) => {
    if (!enabled) return false
    if (e.repeat) return // swallow auto-repeat (hold is handled explicitly)
    if (continuous) {
      const code = e.code
      holdKey.current = code
      jogger.startHold(vec)
      const up = (ev: KeyboardEvent) => {
        if (ev.code !== code) return
        window.removeEventListener('keyup', up, true)
        holdKey.current = null
        jogger.stopHold()
      }
      window.addEventListener('keyup', up, true)
    } else {
      void jogger.step(vec, (vec.z ? zStep : step) * mult)
    }
  }
  const G = '控制 · 点动'
  const dirs: [string, JogVec, string][] = [
    ['arrowup', { x: 0, y: 1, z: 0 }, 'Y+'],
    ['arrowdown', { x: 0, y: -1, z: 0 }, 'Y−'],
    ['arrowleft', { x: -1, y: 0, z: 0 }, 'X−'],
    ['arrowright', { x: 1, y: 0, z: 0 }, 'X+'],
    ['pageup', { x: 0, y: 0, z: -1 }, 'Z− 抬起'],
    ['pagedown', { x: 0, y: 0, z: 1 }, 'Z+ 落下'],
  ]
  /* eslint-disable react-hooks/rules-of-hooks -- fixed-length list */
  for (const [k, v, l] of dirs) {
    useShortcut(k, keyJog(v, 1), { description: `点动 ${l}`, group: G, enabled })
    useShortcut(`shift+${k}`, keyJog(v, 10), { hidden: true, enabled })
    useShortcut(`alt+${k}`, keyJog(v, 0.1), { hidden: true, enabled })
  }

  const pad = compact ? 'size-16' : 'size-14'
  const common = { jogger, continuous, disabled: !enabled }
  return (
    <Card className="flex flex-col">
      <CardHeader
        title="点动"
        subtitle={enabled ? (compact ? `${feed} mm/min` : `${feed} mm/min · 方向键 / PgUp PgDn`) : reason}
        actions={
          <label className="flex items-center gap-2 text-footnote text-secondary-label">
            按住连续
            <Switch checked={continuous} onCheckedChange={setContinuous} aria-label="按住连续点动" />
          </label>
        }
      />
      <div className="flex flex-1 flex-col items-center gap-4 px-4 pb-4">
        <div className="flex items-center gap-5">
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="XY 点动">
            <span />
            <JogButton {...common} vec={{ x: 0, y: 1, z: 0 }} size={step} label={`Y+ ${step} mm`} className={pad}>
              <ArrowUp />
            </JogButton>
            <span />
            <JogButton {...common} vec={{ x: -1, y: 0, z: 0 }} size={step} label={`X− ${step} mm`} className={pad}>
              <ArrowLeft />
            </JogButton>
            <Tooltip content={jogger.holding ? '停止点动' : '回到原点（先抬笔）'}>
              <button
                type="button"
                aria-label={jogger.holding ? '停止点动' : '回到原点'}
                disabled={!enabled}
                onClick={() => (jogger.holding ? jogger.stopHold() : onHome())}
                className={cn(
                  'press focus-ring flex items-center justify-center rounded-lg bg-tertiary-fill text-secondary-label hover:bg-secondary-fill disabled:opacity-35 [&_svg]:size-5',
                  pad,
                )}
              >
                {jogger.holding ? <Octagon className="text-red" /> : <House />}
              </button>
            </Tooltip>
            <JogButton {...common} vec={{ x: 1, y: 0, z: 0 }} size={step} label={`X+ ${step} mm`} className={pad}>
              <ArrowRight />
            </JogButton>
            <span />
            <JogButton {...common} vec={{ x: 0, y: -1, z: 0 }} size={step} label={`Y− ${step} mm`} className={pad}>
              <ArrowDown />
            </JogButton>
            <span />
          </div>
          <div className="flex flex-col items-center gap-2" role="group" aria-label="Z 点动">
            <JogButton {...common} vec={{ x: 0, y: 0, z: -1 }} size={zStep} label={`Z− 抬起 ${zStep} mm`} className={cn(pad, 'flex-col gap-0.5')}>
              <ChevronsUp />
            </JogButton>
            <span className="text-caption font-semibold text-secondary-label">Z</span>
            <JogButton {...common} vec={{ x: 0, y: 0, z: 1 }} size={zStep} label={`Z+ 落下 ${zStep} mm`} className={pad}>
              <ChevronsDown />
            </JogButton>
          </div>
        </div>
        <div className="flex w-full max-w-xs flex-col gap-1.5">
          <Segmented<StepKey>
            block
            aria-label="步长"
            value={stepKey}
            onValueChange={setStepKey}
            options={STEPS.map((s) => ({ value: s, label: `${s}` }))}
          />
          <p className="text-center text-footnote text-secondary-label">步长 mm · Z 步长 {zStep} mm · Shift ×10 · Alt ×0.1</p>
        </div>
      </div>
    </Card>
  )
}
