import { Unplug, ArrowDownToLine, ArrowUpFromLine, ChevronDown, Crosshair, House, LockOpen, Moon, RotateCcw, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { runAction } from './errors'
import { gotoOrigin, machineAction, setPen, setZero } from '@/api/machine-control'
import { disconnectMachine } from '@/api/machine'
import { useLive } from '@/api/store'
import {
  Badge, Button, Card, CardHeader, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger, Segmented, StatusPill, Tooltip,
} from '@/components/ui'
import { useLiveStatus } from '@/app/use-live-status'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { formatNumber } from '@/lib/format'
import { HelpLink } from '@/features/help/HelpLink'
import type { MachineGate } from './gate'

const AXES = ['X', 'Y', 'Z'] as const

export const PEN_LABEL = { up: '抬起', down: '落下', unknown: '未知' } as const

/** Set origin with a safety confirmation; Z / XYZ require the pen to be up (Z 原点 = 抬笔位). */
export async function zeroWithConfirm(axes: 'xy' | 'z' | 'xyz', pen: 'up' | 'down' | 'unknown' | undefined) {
  if (axes !== 'xy' && pen === 'down') {
    const ok = await confirm({
      title: '笔现在是落下的',
      description: '抬笔位就是 Z 的原点。先抬笔，确认笔尖离开纸面后再设。',
      confirmLabel: '先抬笔',
    })
    if (ok) await runAction('抬笔失败', () => setPen('up'))
    return
  }
  const title = axes === 'xy' ? '把笔现在的位置设为原点？' : axes === 'z' ? '把现在的笔高设为抬笔位？' : '把现在的位置设为原点，并把笔高设为抬笔位？'
  const ok = await confirm({
    title,
    description:
      axes === 'xy'
        ? '原点是开始写字时笔所在的位置：把笔（抬起状态）停在要写内容的左上角再设。之后的任务都从这里开始。'
        : pen === 'unknown'
          ? '笔的状态未知：确认笔尖已经离开纸面（必要时先用 Z− 点动抬起）再设。'
          : '确认笔尖已离开纸面。设好后，Z 0 = 抬笔，数字越大压得越深。',
    confirmLabel: axes === 'z' ? '设为抬笔位' : '设为原点',
  })
  if (ok) await runAction('设原点失败', () => setZero(axes), axes === 'z' ? '已设抬笔位' : '已设为原点')
}

export async function homeWithConfirm() {
  await runAction('回原点失败', () => gotoOrigin())
}

export function DroCard({ gate, compact }: { gate: MachineGate; compact?: boolean }) {
  const { machine, view } = useLiveStatus()
  const [space, setSpace] = React.useState<'w' | 'm'>('w')
  const pos = (space === 'w' ? machine?.wpos : machine?.mpos) ?? null
  const pen = machine?.pen ?? 'unknown'
  const disabled = !gate.canMove

  return (
    <Card className="flex flex-col">
      <CardHeader
        title="位置"
        actions={
          <Segmented<'w' | 'm'>
            size="sm"
            aria-label="坐标系"
            value={space}
            onValueChange={setSpace}
            options={[
              { value: 'w', label: '工件' },
              { value: 'm', label: '机器' },
            ]}
          />
        }
      />
      <div className="flex flex-1 flex-col gap-3 px-4 pb-4">
        <div className={cn('grid grid-cols-3 gap-2', !gate.connected && 'opacity-40')} aria-live="off">
          {AXES.map((a, i) => (
            <div key={a} className="flex flex-col rounded-md bg-quaternary-fill px-2.5 py-2">
              <span className={cn('text-caption font-semibold', a === 'X' ? 'text-axis-x' : a === 'Y' ? 'text-axis-y' : 'text-secondary-label')}>{a}</span>
              <span className={cn('font-mono tabular-nums text-label', compact ? 'text-title3' : 'text-title2')} aria-label={`${a} ${pos ? formatNumber(pos[i]) : '未知'} 毫米`}>
                {pos ? formatNumber(pos[i]) : '—'}
              </span>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-footnote text-secondary-label">
          <StatusPill tone={view.tone} icon={view.icon} spin={view.spin}>
            {view.label}
          </StatusPill>
          <Badge tone={pen === 'down' ? 'blue' : pen === 'up' ? 'gray' : 'orange'} icon={pen === 'down' ? ArrowDownToLine : ArrowUpFromLine}>
            笔 {PEN_LABEL[pen]}
          </Badge>
          {machine?.connected && machine.feed ? <span className="tabular-nums">F {Math.round(machine.feed)}</span> : null}
          {machine?.connected && !machine.origin_valid ? (
            <Badge tone="orange" icon={TriangleAlert}>
              原点无效
            </Badge>
          ) : null}
        </div>
        {machine?.connected && !machine.origin_valid ? (
          <p className="rounded-md bg-orange/10 px-2.5 py-2 text-footnote text-on-tint-orange">
            控制板复位过，坐标已丢失：先抬笔（必要时用 Z− 点动），把笔移到要写内容的左上角，再在「更多」里设原点和抬笔位。
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <Button size="lg" variant={pen === 'up' ? 'tinted' : 'gray'} icon={<ArrowUpFromLine />} disabled={disabled} onClick={() => runAction('抬笔失败', () => setPen('up'))}>
            抬笔
          </Button>
          <Button size="lg" variant={pen === 'down' ? 'tinted' : 'gray'} icon={<ArrowDownToLine />} disabled={disabled} onClick={() => runAction('落笔失败', () => setPen('down'))}>
            落笔
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Button variant="tinted" icon={<Crosshair />} disabled={disabled} onClick={() => zeroWithConfirm('xy', pen)}>
            设为原点
          </Button>
          <HelpLink topic="origin" className="self-center" />
          <Tooltip content="先抬笔，再移动到原点">
            <Button variant="gray" icon={<House />} disabled={disabled || !machine?.origin_valid} onClick={homeWithConfirm}>
              回到原点
            </Button>
          </Tooltip>
          {gate.alarm ? (
            <Button
              variant="filled"
              icon={<LockOpen />}
              disabled={!gate.connected || gate.leaseBlocked}
              onClick={() => runAction('解锁失败', () => machineAction('unlock'), '已解锁')}
            >
              解锁
            </Button>
          ) : null}
          <MoreActions gate={gate} pen={pen} />
        </div>
        {gate.reason && gate.connected ? <p className="text-footnote text-secondary-label">{gate.reason}</p> : null}
      </div>
    </Card>
  )
}

function MoreActions({ gate, pen }: { gate: MachineGate; pen: 'up' | 'down' | 'unknown' }) {
  const job = useLive((s) => s.job)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="gray" disabled={!gate.connected || gate.leaseBlocked}>
          更多
          <ChevronDown className="-mr-1 size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>原点</DropdownMenuLabel>
        <DropdownMenuItem disabled={!gate.canMove} onSelect={() => zeroWithConfirm('z', pen)}>
          把现在的笔高设为抬笔位
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!gate.canMove} onSelect={() => zeroWithConfirm('xyz', pen)}>
          设为原点并设抬笔位（XYZ）
        </DropdownMenuItem>
        {!gate.alarm ? (
          <DropdownMenuItem icon={<LockOpen />} disabled={gate.jobActive} onSelect={() => runAction('解锁失败', () => machineAction('unlock'), '已解锁')}>
            解锁（$X）
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={<RotateCcw />}
          disabled={!!job}
          onSelect={async () => {
            const ok = await confirm({
              title: '软复位控制板？',
              description: '控制板会清空缓存的动作。正在移动时复位会丢失坐标，之后需要重新设原点。',
              confirmLabel: '复位',
              destructive: true,
            })
            if (ok) await runAction('复位失败', () => machineAction('reset'), '已复位')
          }}
        >
          软复位
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Moon />}
          disabled={!gate.canMove}
          onSelect={async () => {
            const ok = await confirm({ title: '休眠后坐标可能不准', description: '电机断电后可以用手推动笔架；唤醒需要软复位，之后请重新设原点。', confirmLabel: '休眠' })
            if (ok) await runAction('休眠失败', () => machineAction('sleep'), '已休眠')
          }}
        >
          休眠（释放电机）
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={<Unplug />}
          destructive
          disabled={gate.jobActive}
          onSelect={async () => {
            const ok = await confirm({
              title: '断开后坐标会丢失',
              description: '再次连接时控制板会复位，需要重新设原点。',
              confirmLabel: '断开',
              destructive: true,
            })
            if (ok) await runAction('断开失败', () => disconnectMachine())
          }}
        >
          断开连接…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
