import { useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsDown, ChevronsUp, Ruler } from 'lucide-react'
import * as React from 'react'
import { api, errorMessage } from '@/api/client'
import { runAction } from './errors'
import { jog, setPen, setZero, type Profile } from '@/api/machine-control'
import { qk } from '@/api/query'
import { useLive } from '@/api/store'
import {
  Button, Card, CardHeader, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { HelpLink } from '@/features/help/HelpLink'
import type { MachineGate } from './gate'

/** Z calibration helper (01 §10 M6): lower in small steps until the tip touches, then save as zOn. */
export function ZCalibrationCard({ profile, gate, zOn, zOff, zFeed }: { profile: Profile | null; gate: MachineGate; zOn: number; zOff: number; zFeed: number }) {
  const [open, setOpen] = React.useState(false)
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex items-center gap-1.5">落笔深度 {formatNumber(zOn, 1)} mm <HelpLink topic="pen" /></span>}
        subtitle="Z 0 = 笔抬起的静止位置；数字越大压得越深" 
        actions={
          <Button variant="tinted" icon={<Ruler />} disabled={!gate.canMove || !profile} onClick={() => setOpen(true)}>
            校准
          </Button>
        }
      />
      <div className="px-4 pb-4">
        <ZScale zOn={zOn} zOff={zOff} />
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">{open ? <Wizard profile={profile!} zOn={zOn} zFeed={zFeed} onDone={() => setOpen(false)} /> : null}</DialogContent>
      </Dialog>
    </Card>
  )
}

function ZScale({ zOn, zOff }: { zOn: number; zOff: number }) {
  const z = useLive((s) => s.machine?.wpos?.[2] ?? null)
  const max = Math.max(zOn * 1.25, 10)
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`
  return (
    <div className="relative mb-4 mt-1 h-6" aria-hidden>
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-fill" />
      <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent/30" style={{ left: pct(zOff), width: `calc(${pct(zOn)} - ${pct(zOff)})` }} />
      <span className="absolute top-full -translate-x-1/2 text-footnote tabular-nums text-secondary-label" style={{ left: pct(zOff) }}>{formatNumber(zOff, 0)}</span>
      <span className="absolute top-full -translate-x-1/2 whitespace-nowrap text-footnote tabular-nums text-secondary-label" style={{ left: pct(zOn) }}>{formatNumber(zOn, 1)} mm</span>
      {z != null ? <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-bg-grouped-secondary" style={{ left: pct(z) }} /> : null}
    </div>
  )
}

function Wizard({ profile, zOn, zFeed, onDone }: { profile: Profile; zOn: number; zFeed: number; onDone: () => void }) {
  const qc = useQueryClient()
  const machine = useLive((s) => s.machine)
  const z = machine?.wpos?.[2] ?? null
  const [step, setStep] = React.useState<0 | 1>(machine?.origin_valid && machine.pen === 'up' ? 1 : 0)
  const [saving, setSaving] = React.useState(false)
  const move = (dz: number) => runAction('Z 点动失败', () => jog({ dz }, Math.min(zFeed, 1000)))

  const save = async () => {
    if (z == null) return
    setSaving(true)
    try {
      await api.patch(`/profiles/${profile.id}`, { doc: { grbl: { zOn: Number(z.toFixed(2)) } } })
      await qc.invalidateQueries({ queryKey: qk.profiles.all })
      toast.success(`落笔高度已设为 Z${z.toFixed(2)} mm`)
      await setPen('up').catch(() => undefined)
      onDone()
    } catch (e) {
      toast.error('保存失败', { description: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>校准落笔高度</DialogTitle>
        <DialogDescription>先确定抬笔位（Z 0），再一点点往下压，直到笔尖刚好碰到纸面。</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <ol className="flex gap-2 text-footnote">
          {['设抬笔位', '下探并保存'].map((t, i) => (
            <li key={t} className={cn('flex flex-1 items-center gap-1.5 rounded-md px-2 py-1.5', i === step ? 'bg-accent/15 text-accent' : 'bg-quaternary-fill text-secondary-label')}>
              <span className="flex size-4 items-center justify-center rounded-full bg-current/15 text-caption font-semibold">{i < step ? <Check className="size-3" /> : i + 1}</span>
              {t}
            </li>
          ))}
        </ol>
        {step === 0 ? (
          <div className="flex flex-col gap-3 text-callout text-secondary-label">
            <p>先把笔抬到静止位：如果笔状态未知，用 Z− 点动直到笔尖离开纸面约 1 mm，然后把这里设为抬笔位。</p>
            <div className="flex gap-2">
              <Button variant="gray" icon={<ChevronsUp />} onClick={() => move(-0.5)}>Z− 0.5</Button>
              <Button variant="gray" onClick={() => runAction('抬笔失败', () => setPen('up'))}>抬笔</Button>
            </div>
            <Button
              variant="filled"
              onClick={async () => {
                if (await runAction('设抬笔位失败', () => setZero('z'))) setStep(1)
              }}
            >
              笔尖已离开纸面，设为抬笔位
            </Button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="text-center">
              <div className="font-mono text-large-title tabular-nums text-label" aria-live="polite">
                Z {z == null ? '—' : z.toFixed(2)}
              </div>
              <div className="text-footnote text-secondary-label">当前设置 Z{zOn.toFixed(2)} mm</div>
            </div>
            <div className="grid w-full grid-cols-4 gap-2">
              <Button variant="gray" onClick={() => move(-0.5)} aria-label="抬起 0.5 毫米">−0.5</Button>
              <Button variant="gray" onClick={() => move(-0.1)} aria-label="抬起 0.1 毫米">−0.1</Button>
              <Button variant="gray" onClick={() => move(0.1)} aria-label="落下 0.1 毫米">+0.1</Button>
              <Button variant="tinted" icon={<ChevronsDown />} onClick={() => move(0.5)} aria-label="落下 0.5 毫米">+0.5</Button>
            </div>
            <p className="text-footnote text-secondary-label">每次下探 0.5 mm，接近纸面后改用 0.1 mm。笔尖刚接触纸面时点「保存」。</p>
          </div>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="gray" onClick={onDone}>取消</Button>
        {step === 1 ? (
          <Button variant="filled" loading={saving} disabled={z == null || z <= 0} onClick={save}>
            保存为落笔高度{z != null && z > 0 ? `（Z${formatNumber(z)}）` : ''}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  )
}
