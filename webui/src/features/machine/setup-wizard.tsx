/**
 * 首次上机向导 (review §1.1 / §3.1): 连接 → 方向确认 → 落笔深度 → 设原点 → 试画 10 mm 方块.
 * Results are stored as a 「本机名片」 in the active machine configuration (`doc.setup_card`, unknown keys are kept).
 */
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronsDown, ChevronsUp, Crosshair, PenLine, PlugZap } from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'
import { api } from '@/api/client'
import { connectMachine } from '@/api/machine'
import { jog, profileNumbers, setZero, type Profile } from '@/api/machine-control'
import { qk } from '@/api/query'
import { useLive } from '@/api/store'
import {
  Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, IconButton, Segmented,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { formatNumber } from '@/lib/format'
import { runAction } from './errors'
import { useMachineGate } from './gate'

const STEPS = ['连接', '方向', '落笔深度', '原点', '试画'] as const

export interface SetupCard {
  checked_at: number
  x_dir_ok: boolean | null
  y_dir_ok: boolean | null
  z_on: number | null
  work_w: number
  work_h: number
  square_ok: boolean | null
}

async function sendLines(lines: string[]) {
  for (const line of lines) await api.post('/machine/command', { line, timeout_s: 30 }, { idempotencyKey: true, timeoutMs: 40_000 })
}

export function SetupWizard({ open, onOpenChange, profile }: { open: boolean; onOpenChange: (o: boolean) => void; profile: Profile | null }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">{open ? <Body profile={profile} onDone={() => onOpenChange(false)} /> : null}</DialogContent>
    </Dialog>
  )
}

function Body({ profile, onDone }: { profile: Profile | null; onDone: () => void }) {
  const qc = useQueryClient()
  const machine = useLive((s) => s.machine)
  const gate = useMachineGate()
  const n = profileNumbers(profile)
  const [step, setStep] = React.useState(machine?.connected ? 1 : 0)
  const [xOk, setXOk] = React.useState<boolean | null>(null)
  const [yOk, setYOk] = React.useState<boolean | null>(null)
  const [zOn, setZOn] = React.useState<number | null>(null)
  const [zBase, setZBase] = React.useState(false)
  const [originSet, setOriginSet] = React.useState(false)
  const [drawn, setDrawn] = React.useState(false)
  const [squareOk, setSquareOk] = React.useState<boolean | null>(null)
  const [stepMm, setStepMm] = React.useState<'1' | '10'>('10')
  const [busy, setBusy] = React.useState(false)
  const z = machine?.wpos?.[2] ?? null
  const can = gate.canMove
  const mv = (dx: number, dy: number, dz = 0) => runAction('点动失败', () => jog({ dx, dy, dz }, dz ? Math.min(n.zSpeed, 1000) : n.jogSpeed))

  const saveZ = async () => {
    if (!profile || z == null || z <= 0) return
    const v = Number(z.toFixed(2))
    if (await runAction('保存落笔深度失败', () => api.patch(`/profiles/${profile.id}`, { doc: { grbl: { zOn: v } } }), `落笔深度已设为 ${v} mm`)) {
      setZOn(v)
      await runAction('抬笔失败', () => jog({ dz: -v }, Math.min(n.zSpeed, 1000)))
      void qc.invalidateQueries({ queryKey: qk.profiles.all })
    }
  }

  const drawSquare = async () => {
    const ok = await confirm({ title: '试画一个 10 mm 方块？', description: '笔会在当前位置落下，画一个边长 10 mm 的方块，然后抬笔回到起点。', confirmLabel: '开始试画' })
    if (!ok) return
    const down = zOn ?? n.zOn
    setBusy(true)
    const done = await runAction('试画失败', () =>
      sendLines(['G91', `G1 Z${down.toFixed(2)} F${Math.round(n.zSpeed)}`, `G1 X10 F${Math.round(n.feedRate)}`, 'G1 Y-10', 'G1 X-10', 'G1 Y10', `G1 Z-${down.toFixed(2)} F${Math.round(n.zSpeed)}`, 'G90']),
    )
    setBusy(false)
    if (done) setDrawn(true)
  }

  const finish = async () => {
    if (profile) {
      const card: SetupCard = { checked_at: Date.now() / 1000, x_dir_ok: xOk, y_dir_ok: yOk, z_on: zOn ?? n.zOn, work_w: n.workW, work_h: n.workH, square_ok: squareOk }
      await runAction('保存本机名片失败', () => api.patch(`/profiles/${profile.id}`, { doc: { setup_card: card } }), '上机检查完成')
      void qc.invalidateQueries({ queryKey: qk.profiles.all })
    }
    onDone()
  }

  const nextDisabled =
    (step === 0 && !machine?.connected) ||
    (step === 1 && (xOk == null || yOk == null)) ||
    (step === 3 && !originSet)

  const pad = (
    <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="XY 点动">
      <span />
      <IconButton variant="gray" size="lg" label={`向上（Y+）${stepMm} mm`} disabled={!can} onClick={() => mv(0, Number(stepMm))}><ArrowUp /></IconButton>
      <span />
      <IconButton variant="gray" size="lg" label={`向左（X−）${stepMm} mm`} disabled={!can} onClick={() => mv(-Number(stepMm), 0)}><ArrowLeft /></IconButton>
      <span />
      <IconButton variant="gray" size="lg" label={`向右（X+）${stepMm} mm`} disabled={!can} onClick={() => mv(Number(stepMm), 0)}><ArrowRight /></IconButton>
      <span />
      <IconButton variant="gray" size="lg" label={`向下（Y−）${stepMm} mm`} disabled={!can} onClick={() => mv(0, -Number(stepMm))}><ArrowDown /></IconButton>
      <span />
    </div>
  )

  return (
    <>
      <DialogHeader>
        <DialogTitle>上机向导</DialogTitle>
        <DialogDescription>第一次使用、换笔或搬动过写字机后，花两分钟走一遍。</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <ol className="grid grid-cols-5 gap-1.5" aria-label="步骤">
          {STEPS.map((t, i) => (
            <li
              key={t}
              aria-current={i === step ? 'step' : undefined}
              className={cn(
                'flex items-center justify-center gap-1 rounded-md px-1 py-1.5 text-center text-footnote',
                i === step ? 'bg-accent/15 font-medium text-accent' : i < step ? 'bg-green/10 text-on-tint-green' : 'bg-quaternary-fill text-secondary-label',
              )}
            >
              {i < step ? <Check className="size-3.5 shrink-0" /> : <span className="tabular-nums">{i + 1}</span>}
              <span className="truncate">{t}</span>
            </li>
          ))}
        </ol>
        {gate.connected && gate.reason && step > 0 ? <p className="rounded-md bg-orange/10 px-3 py-2 text-footnote text-on-tint-orange">{gate.reason}</p> : null}

        {step === 0 ? (
          <div className="flex flex-col gap-3 text-callout text-secondary-label">
            <p>用 USB 线把写字机接到这台设备，打开写字机电源，然后点「连接」。</p>
            {machine?.connected ? (
              <p className="flex items-center gap-2 text-on-tint-green"><Check className="size-4" />已连接（Grbl {machine.firmware}）</p>
            ) : (
              <Button variant="filled" icon={<PlugZap />} className="self-start" loading={!!machine?.connecting} onClick={() => runAction('连接失败', () => connectMachine())}>
                连接
              </Button>
            )}
            {machine?.error ? <p className="text-footnote text-red">{machine.error}</p> : null}
            <p className="text-footnote">连不上？检查 USB 线是否插好、写字机是否通电，或者是否被别的软件占用了串口。</p>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="flex flex-col gap-4 text-callout text-secondary-label">
            <p>先把笔抬起，放在纸张中间附近。分别点下面两个按钮，看笔往哪边走。</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                { label: '向右走 10 mm（X+）', expect: '笔应该向右走', move: () => mv(10, 0), ok: xOk, set: setXOk },
                { label: '向上走 10 mm（Y+）', expect: '笔应该朝纸张上方（远离你）走', move: () => mv(0, 10), ok: yOk, set: setYOk },
              ].map((d) => (
                <div key={d.label} className="flex flex-col gap-2 rounded-lg bg-quaternary-fill p-3">
                  <Button variant="gray" disabled={!can} onClick={d.move}>{d.label}</Button>
                  <p className="text-footnote">{d.expect}。方向对吗？</p>
                  <Segmented
                    aria-label={`${d.label} 方向`}
                    value={d.ok == null ? 'none' : d.ok ? 'yes' : 'no'}
                    onValueChange={(v) => d.set(v === 'none' ? null : v === 'yes')}
                    options={[
                      { value: 'none', label: '还没看' },
                      { value: 'yes', label: '对' },
                      { value: 'no', label: '反了' },
                    ]}
                  />
                </div>
              ))}
            </div>
            {xOk === false || yOk === false ? (
              <p className="rounded-md bg-orange/10 px-3 py-2 text-footnote text-on-tint-orange">
                方向反了需要改控制板的方向设置（GRBL 参数 $3）。可以先完成向导，再到{' '}
                <Link to="/console?tab=grbl" className="underline" onClick={onDone}>调试 › GRBL 参数</Link> 修改。
              </p>
            ) : null}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="flex flex-col gap-3 text-callout text-secondary-label">
            {!zBase ? (
              <>
                <p>1. 用 Z− 把笔尖抬到离开纸面约 1 mm，然后把这个高度设为抬笔位。</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="gray" icon={<ChevronsUp />} disabled={!can} onClick={() => mv(0, 0, -1)}>Z− 1</Button>
                  <Button variant="gray" disabled={!can} onClick={() => mv(0, 0, -0.2)}>Z− 0.2</Button>
                  <Button variant="gray" disabled={!can} onClick={() => mv(0, 0, 0.2)}>Z+ 0.2</Button>
                  <Button
                    variant="filled"
                    disabled={!can}
                    onClick={async () => {
                      if (await runAction('设抬笔位失败', () => setZero('z'))) setZBase(true)
                    }}
                  >
                    设为抬笔位
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p>2. 一点点往下压，直到笔尖刚好接触纸面，然后保存。</p>
                <div className="flex items-center gap-4">
                  <span className="font-mono text-title1 tabular-nums text-label" aria-live="polite">Z {z == null ? '—' : z.toFixed(2)}</span>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="gray" disabled={!can} onClick={() => mv(0, 0, -0.1)}>−0.1</Button>
                    <Button variant="gray" disabled={!can} onClick={() => mv(0, 0, 0.1)}>+0.1</Button>
                    <Button variant="tinted" icon={<ChevronsDown />} disabled={!can} onClick={() => mv(0, 0, 0.5)}>+0.5</Button>
                  </div>
                </div>
                <Button variant="filled" className="self-start" disabled={!can || z == null || z <= 0} onClick={saveZ}>
                  笔尖刚碰到纸，保存为落笔深度
                </Button>
                {zOn != null ? <p className="flex items-center gap-2 text-on-tint-green"><Check className="size-4" />落笔深度 {zOn} mm，笔已抬起</p> : null}
              </>
            )}
            <p className="text-footnote">现在的落笔深度是 {formatNumber(n.zOn, 1)} mm。不想改可以直接下一步。</p>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="flex flex-col gap-3 text-callout text-secondary-label">
            <p>放好纸，把笔（保持抬起）移到要写内容的左上角，然后设为原点。纸角被纸夹挡住也没关系。</p>
            <div className="flex flex-wrap items-center gap-4">
              {pad}
              <div className="flex flex-col gap-2">
                <Segmented size="sm" aria-label="步长" value={stepMm} onValueChange={setStepMm} options={[{ value: '1', label: '1 mm' }, { value: '10', label: '10 mm' }]} />
                <span className="font-mono text-footnote tabular-nums text-label">X {formatNumber(machine?.wpos?.[0])} · Y {formatNumber(machine?.wpos?.[1])}</span>
                <Button
                  variant="filled"
                  icon={<Crosshair />}
                  disabled={!can}
                  onClick={async () => {
                    if (await runAction('设原点失败', () => setZero('xy'), '已设为原点')) setOriginSet(true)
                  }}
                >
                  设为原点
                </Button>
              </div>
            </div>
            {originSet ? <p className="flex items-center gap-2 text-on-tint-green"><Check className="size-4" />原点已设好</p> : null}
          </div>
        ) : null}

        {step === 4 ? (
          <div className="flex flex-col gap-3 text-callout text-secondary-label">
            <p>在原点附近试画一个 10 mm 的方块，检查落笔深度和尺寸。</p>
            <Button variant="filled" icon={<PenLine />} className="self-start" loading={busy} disabled={!can} onClick={drawSquare}>
              试画方块
            </Button>
            {drawn ? (
              <div className="flex flex-col gap-2">
                <p>用尺子量一下：线条清楚、边长正好 10 mm 吗？</p>
                <Segmented
                  aria-label="试画结果"
                  value={squareOk == null ? 'none' : squareOk ? 'yes' : 'no'}
                  onValueChange={(v) => setSquareOk(v === 'none' ? null : v === 'yes')}
                  options={[{ value: 'none', label: '还没量' }, { value: 'yes', label: '正好' }, { value: 'no', label: '不对' }]}
                />
                {squareOk === false ? (
                  <p className="text-footnote text-on-tint-orange">线太淡或断续：回到上一步把落笔深度加深 0.2–0.5 mm。尺寸不对：需要校准控制板的「每毫米步数」（$100/$101）。</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {step > 0 ? (
          <Button variant="gray" className="mr-auto" onClick={() => setStep(step - 1)}>
            上一步
          </Button>
        ) : null}
        <Button variant="gray" onClick={onDone}>以后再说</Button>
        {step < STEPS.length - 1 ? (
          <Button variant="filled" disabled={nextDisabled} onClick={() => setStep(step + 1)}>
            下一步
          </Button>
        ) : (
          <Button variant="filled" onClick={finish}>
            完成
          </Button>
        )}
      </DialogFooter>
    </>
  )
}
