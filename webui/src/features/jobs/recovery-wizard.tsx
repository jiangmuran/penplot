import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronsUp, LifeBuoy, LockOpen, PlugZap, X } from 'lucide-react'
import * as React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useJobActions } from '@/api/jobs'
import { connectMachine } from '@/api/machine'
import { runAction } from '@/features/machine/errors'
import { jog, machineAction, setPen, setZero } from '@/api/machine-control'
import { useLive } from '@/api/store'
import type { Job } from '@/api/types'
import { reasonText } from '@/app/live-effects'
import {
  Button, Card, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, IconButton, NumberField, Segmented,
} from '@/components/ui'
import { useMachineGate } from '@/features/machine/gate'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'

/** Reasons after which the physical state is uncertain and a guided recovery makes sense. */
export function isRecoverable(j: Job | null | undefined): j is Job {
  if (!j || (j.status !== 'failed' && j.status !== 'aborted')) return false
  const r = j.reason ?? ''
  return r.startsWith('alarm') || ['serial_lost', 'process_crash', 'estop', 'shutdown', 'gcode_error', 'alarm_locked'].includes(r)
}

const DISMISS_KEY = 'penplot.recoveryDismissed'

/** Banner on /jobs offering the wizard for the most recent interrupted job (last 24 h, dismissible). */
export function RecoveryBanner({ jobs }: { jobs: Job[] | undefined }) {
  const [dismissed, setDismissed] = React.useState(() => localStorage.getItem(DISMISS_KEY) ?? '')
  const [open, setOpen] = React.useState(false)
  const last = (jobs ?? [])
    .filter((j) => j.finished_at && j.status !== 'queued')
    .sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0))[0]
  if (!isRecoverable(last) || last.id === dismissed || Date.now() / 1000 - (last.finished_at ?? 0) > 86400) return null
  return (
    <Card className="flex flex-wrap items-center gap-3 border-l-4 border-orange px-4 py-3">
      <LifeBuoy className="size-5 shrink-0 text-orange" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-headline text-label">「{last.name}」被中断：{reasonText(last.reason)}</p>
        <p className="text-footnote text-secondary-label">
          停在第 {(last.can_retry_from ?? last.acked_line ?? 0).toLocaleString()} 行。按步骤抬笔、确认原点，然后从中断处续写。
        </p>
      </div>
      <Button variant="filled" onClick={() => setOpen(true)}>
        恢复向导…
      </Button>
      <IconButton
        label="忽略"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, last.id)
          setDismissed(last.id)
        }}
      >
        <X />
      </IconButton>
      <RecoveryWizard job={last} open={open} onOpenChange={setOpen} />
    </Card>
  )
}

const STEPS = ['机器就绪', '抬笔', '确认原点', '续写'] as const

export function RecoveryWizard({ job, open, onOpenChange }: { job: Job; open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">{open ? <Wizard job={job} onDone={() => onOpenChange(false)} /> : null}</DialogContent>
    </Dialog>
  )
}

function Wizard({ job, onDone }: { job: Job; onDone: () => void }) {
  const machine = useLive(useShallow((s) => s.machine))
  const gate = useMachineGate()
  const { retry, start } = useJobActions()
  const [step, setStep] = React.useState(0)
  const [jogStep, setJogStep] = React.useState<'0.1' | '1' | '10'>('1')
  const [from, setFrom] = React.useState(Math.max(1, (job.can_retry_from ?? job.acked_line ?? 1) - 5))
  const [penLifted, setPenLifted] = React.useState(false)
  const connected = !!machine?.connected
  const alarm = gate.alarm
  const ready = connected && !alarm
  const d = Number(jogStep)
  const mv = (dx: number, dy: number, dz = 0) => runAction('点动失败', () => jog({ dx, dy, dz }))

  const finish = async (startNow: boolean) => {
    retry.mutate(
      { id: job.id, from_line: from },
      {
        onSuccess: async (nj) => {
          toast.success(`已创建续写任务（从第 ${from} 行）`)
          if (startNow && (await confirm({ title: '现在开始续写？', description: '请确认纸张没有移动、笔已抬起。', confirmLabel: '开始' }))) {
            start.mutate({ id: nj.id })
          }
          onDone()
        },
      },
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>恢复中断的任务</DialogTitle>
        <DialogDescription>
          「{job.name}」· {reasonText(job.reason)} · 已完成 {(job.acked_line ?? 0).toLocaleString()} / {job.total_lines.toLocaleString()} 行
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <ol className="grid grid-cols-4 gap-1.5" aria-label="步骤">
          {STEPS.map((t, i) => (
            <li
              key={t}
              aria-current={i === step ? 'step' : undefined}
              className={cn(
                'flex items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-center text-footnote',
                i === step ? 'bg-accent/15 font-medium text-accent' : i < step ? 'bg-green/10 text-on-tint-green' : 'bg-quaternary-fill text-secondary-label',
              )}
            >
              {i < step ? <Check className="size-3.5" /> : null}
              {t}
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <div className="flex flex-col gap-3 text-callout text-secondary-label">
            <Check2 ok={connected} label={connected ? '机器已连接' : '机器未连接（串口断开或服务重启后需要重新连接）'} />
            {!connected ? (
              <Button variant="filled" icon={<PlugZap />} className="self-start" onClick={() => runAction('连接失败', () => connectMachine())}>
                连接机器
              </Button>
            ) : null}
            <Check2 ok={connected && !alarm} label={alarm ? '机器处于报警锁定' : '没有报警'} />
            {connected && alarm ? (
              <Button variant="filled" icon={<LockOpen />} className="self-start" onClick={() => runAction('解锁失败', () => machineAction('unlock'), '已解锁')}>
                解锁（$X）
              </Button>
            ) : null}
            {gate.leaseBlocked ? <p className="text-footnote text-orange">{gate.reason}</p> : null}
          </div>
        ) : null}

        {step === 1 ? (
          <div className="flex flex-col gap-3 text-callout text-secondary-label">
            {machine?.origin_valid ? (
              <>
                <p>原点仍然有效，可以直接抬笔。</p>
                <Button variant="filled" icon={<ChevronsUp />} className="self-start" onClick={async () => setPenLifted(await runAction('抬笔失败', () => setPen('up')))}>
                  抬笔
                </Button>
              </>
            ) : (
              <>
                <p>坐标已丢失，抬笔命令不可靠。请用 Z− 点动，直到笔尖离开纸面约 1 mm：</p>
                <div className="flex gap-2">
                  <Button variant="gray" onClick={() => mv(0, 0, -0.5)}>Z− 0.5</Button>
                  <Button variant="gray" onClick={() => mv(0, 0, -1)}>Z− 1</Button>
                  <Button variant="gray" onClick={() => mv(0, 0, 0.5)}>Z+ 0.5</Button>
                </div>
                <label className="flex items-center gap-2 text-label">
                  <input type="checkbox" className="size-4 accent-[rgb(var(--accent))]" checked={penLifted} onChange={(e) => setPenLifted(e.currentTarget.checked)} />
                  笔尖已离开纸面
                </label>
              </>
            )}
            {penLifted ? <Check2 ok label="笔已抬起" /> : null}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="flex flex-col gap-3 text-callout text-secondary-label">
            {machine?.origin_valid ? (
              <Check2 ok label="原点有效（与原任务相同），不用重新设原点" />
            ) : (
              <>
                <p>把笔移回原任务的原点（要写内容的左上角起笔处，纸不要动），然后设为原点。位置偏差会让续写的笔画错位。</p>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="XY 点动">
                    <span />
                    <IconButton variant="gray" size="lg" label={`Y+ ${d}`} onClick={() => mv(0, d)}><ArrowUp /></IconButton>
                    <span />
                    <IconButton variant="gray" size="lg" label={`X− ${d}`} onClick={() => mv(-d, 0)}><ArrowLeft /></IconButton>
                    <span />
                    <IconButton variant="gray" size="lg" label={`X+ ${d}`} onClick={() => mv(d, 0)}><ArrowRight /></IconButton>
                    <span />
                    <IconButton variant="gray" size="lg" label={`Y− ${d}`} onClick={() => mv(0, -d)}><ArrowDown /></IconButton>
                    <span />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Segmented size="sm" aria-label="步长" value={jogStep} onValueChange={setJogStep} options={['0.1', '1', '10'].map((v) => ({ value: v as '1', label: `${v} mm` }))} />
                    <span className="font-mono text-footnote tabular-nums text-label">
                      X {formatNumber(machine?.wpos?.[0])} · Y {formatNumber(machine?.wpos?.[1])}
                    </span>
                  </div>
                </div>
                <Button variant="filled" className="self-start" onClick={() => runAction('设原点失败', () => setZero('xyz'), '已设为原点')}>
                  笔已在原点上方，设为原点
                </Button>
              </>
            )}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="flex flex-col gap-3 text-callout text-secondary-label">
            <p>从哪一行继续？默认比中断处提前 5 行，保证笔画完整（会先抬笔移动到该行起点）。</p>
            <div className="flex items-center gap-3">
              <NumberField aria-label="起始行" value={from} onChange={setFrom} min={1} max={job.total_lines} step={1} className="w-40" />
              <span className="text-footnote">/ {job.total_lines.toLocaleString()}</span>
            </div>
            {!machine?.origin_valid ? <p className="text-footnote text-orange">原点无效：先完成上一步「设为原点」。</p> : null}
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {step > 0 ? (
          <Button variant="gray" className="mr-auto" onClick={() => setStep(step - 1)}>
            上一步
          </Button>
        ) : null}
        <Button variant="gray" onClick={onDone}>取消</Button>
        {step < 3 ? (
          <Button
            variant="filled"
            disabled={(step === 0 && (!ready || gate.leaseBlocked)) || (step === 1 && !penLifted) || (step === 2 && !machine?.origin_valid)}
            onClick={() => setStep(step + 1)}
          >
            下一步
          </Button>
        ) : (
          <>
            <Button variant="tinted" loading={retry.isPending} disabled={!machine?.origin_valid} onClick={() => finish(false)}>
              加入队列
            </Button>
            <Button variant="filled" loading={retry.isPending} disabled={!machine?.origin_valid} onClick={() => finish(true)}>
              续写
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  )
}

function Check2({ ok, label }: { ok: boolean; label: string }) {
  return (
    <p className={cn('flex items-center gap-2', ok ? 'text-on-tint-green' : 'text-on-tint-orange')}>
      <span className={cn('flex size-5 items-center justify-center rounded-full', ok ? 'bg-green/15' : 'bg-orange/15')}>
        {ok ? <Check className="size-3.5" /> : <X className="size-3.5" />}
      </span>
      {label}
    </p>
  )
}
