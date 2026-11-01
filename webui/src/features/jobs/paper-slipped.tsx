/**
 * 「纸滑了…」 (review §1.6): while paused, nudge the pen back onto a reference mark on the paper (the end of
 * the last stroke) and re-register XY so the remaining strokes line up again, then continue.
 */
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Crosshair, Play } from 'lucide-react'
import * as React from 'react'
import { api } from '@/api/client'
import { resumeJob } from '@/api/machine'
import { jog, setPen } from '@/api/machine-control'
import { useLive } from '@/api/store'
import type { Job } from '@/api/types'
import {
  Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, IconButton, Segmented,
} from '@/components/ui'
import { runAction } from '@/features/machine/errors'
import { formatNumber } from '@/lib/format'

export function PaperSlipped({ job, disabled }: { job: Job; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-orange/10 px-3 py-2">
        <p className="min-w-0 flex-1 text-footnote text-on-tint-orange">纸被碰歪了？可以重新对准后接着写；或者停止后从第 {(job.acked_line ?? 0).toLocaleString()} 行续写。</p>
        <Button size="sm" variant="gray" disabled={disabled} onClick={() => setOpen(true)}>
          纸滑了…
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">{open ? <Realign job={job} onDone={() => setOpen(false)} /> : null}</DialogContent>
      </Dialog>
    </>
  )
}

function Realign({ job, onDone }: { job: Job; onDone: () => void }) {
  const machine = useLive((s) => s.machine)
  // Reference = where the pen stopped (end of the last stroke), in the job's own coordinates.
  const [ref] = React.useState<[number, number] | null>(() => (machine?.wpos ? [machine.wpos[0], machine.wpos[1]] : null))
  const [step, setStep] = React.useState<'0.1' | '1'>('1')
  const [aligned, setAligned] = React.useState(false)
  const d = Number(step)
  const mv = (dx: number, dy: number) => runAction('点动失败', () => jog({ dx, dy }))

  const register = async () => {
    if (!ref) return
    const ok = await runAction('重新对准失败', () =>
      api.post('/machine/command', { line: `G10 L20 P0 X${ref[0].toFixed(3)} Y${ref[1].toFixed(3)}`, timeout_s: 10 }, { idempotencyKey: true }),
    )
    if (ok) setAligned(true)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>纸滑了，重新对准</DialogTitle>
        <DialogDescription>任务暂停在这里，笔停在上一笔的终点上方。</DialogDescription>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3 text-callout text-secondary-label">
        <p>1. 确认笔已经抬起。{machine?.pen !== 'up' ? <Button size="sm" variant="plain" onClick={() => runAction('抬笔失败', () => setPen('up'))}>抬笔</Button> : null}</p>
        <p>2. 在纸上找到最后写的那一笔的终点，用方向键把笔尖移到它正上方。</p>
        <div className="flex items-center gap-4">
          <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="微调位置">
            <span />
            <IconButton variant="gray" size="lg" label={`向上 ${d} mm`} onClick={() => mv(0, d)}><ArrowUp /></IconButton>
            <span />
            <IconButton variant="gray" size="lg" label={`向左 ${d} mm`} onClick={() => mv(-d, 0)}><ArrowLeft /></IconButton>
            <span />
            <IconButton variant="gray" size="lg" label={`向右 ${d} mm`} onClick={() => mv(d, 0)}><ArrowRight /></IconButton>
            <span />
            <IconButton variant="gray" size="lg" label={`向下 ${d} mm`} onClick={() => mv(0, -d)}><ArrowDown /></IconButton>
            <span />
          </div>
          <div className="flex flex-col gap-2">
            <Segmented size="sm" aria-label="步长" value={step} onValueChange={setStep} options={[{ value: '0.1', label: '0.1 mm' }, { value: '1', label: '1 mm' }]} />
            <span className="font-mono text-footnote tabular-nums text-label">
              偏移 X {ref && machine?.wpos ? formatNumber(machine.wpos[0] - ref[0], 1) : '—'} · Y {ref && machine?.wpos ? formatNumber(machine.wpos[1] - ref[1], 1) : '—'}
            </span>
          </div>
        </div>
        <p>3. 对准后点「就是这里」，剩下的笔画会以新位置为准。</p>
        {aligned ? <p className="text-on-tint-green">已重新对准，可以继续了。</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button variant="gray" onClick={onDone}>取消</Button>
        {aligned ? (
          <Button
            variant="filled"
            icon={<Play />}
            onClick={async () => {
              if (await runAction('继续失败', () => resumeJob(job))) onDone()
            }}
          >
            继续写
          </Button>
        ) : (
          <Button variant="filled" icon={<Crosshair />} disabled={!ref} onClick={register}>
            就是这里
          </Button>
        )}
      </DialogFooter>
    </>
  )
}
