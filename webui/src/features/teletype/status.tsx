import { CirclePause, CircleAlert, FilePlus2, Loader2, PenLine, Unplug, WifiOff } from 'lucide-react'
import * as React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useLive } from '@/api/store'
import { Card } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useTeletype } from './store'

type Tone = 'green' | 'blue' | 'orange' | 'red' | 'gray'

export interface TeletypePhase {
  tone: Tone
  title: string
  detail: string
  icon: React.ReactNode
}

/** chars/s from the ack timestamps of the last 5 s */
function useRate() {
  const acks = useTeletype((s) => s.acks)
  const [, tick] = React.useReducer((x: number) => x + 1, 0)
  React.useEffect(() => {
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [])
  const now = performance.now()
  return acks.filter((t) => now - t < 5000).length / 5
}

const GRBL_TEXT: Record<string, string> = {
  Idle: '空闲', Run: '运动中', Hold: '暂停保持', Jog: '点动', Alarm: '报警', Door: '安全门', Check: '检查模式', Home: '回零', Sleep: '休眠',
}
function grblText(st: string) {
  const base = st.split(':')[0]
  return GRBL_TEXT[base] ?? (st || '—')
}

/** One status, in priority order: what the user should know first. */
export function useTeletypePhase(): TeletypePhase {
  const conn = useLive((s) => s.conn)
  const s = useTeletype(
    useShallow((x) => ({
      machineConnected: x.machineConnected, machineState: x.machineState, originOk: x.originOk, needPaper: x.paper.need_paper,
      page: x.paper.page, paused: x.paused, pending: x.pending, queued: x.queued,
    })),
  )
  if (conn !== 'open')
    return { tone: 'gray', title: '与服务器的连接中断', detail: '正在重连，下面的状态可能已过期', icon: <WifiOff /> }
  if (!s.machineConnected) return { tone: 'red', title: '写字机未连接', detail: '串口断开，检查数据线后重新连接', icon: <Unplug /> }
  if (s.machineState.startsWith('Alarm')) return { tone: 'red', title: '机器报警', detail: '先在「控制」页解锁', icon: <CircleAlert /> }
  if (!s.originOk) return { tone: 'red', title: '原点已失效', detail: '抬笔，把笔点动回本页左上角，再设为原点', icon: <CircleAlert /> }
  if (s.needPaper) return { tone: 'orange', title: `第 ${s.page} 页写满，等待换纸`, detail: '换好纸后点「已换纸，继续」', icon: <FilePlus2 /> }
  if (s.paused) return { tone: 'orange', title: '已暂停', detail: s.queued > 0 ? `还有 ${s.queued} 个字等待书写` : '点「继续」恢复书写', icon: <CirclePause /> }
  if (s.pending > 0 || s.machineState.startsWith('Run'))
    return { tone: 'blue', title: '正在书写', detail: s.queued > 0 ? `还有 ${s.queued} 个字等待书写` : '正在写完最后一笔', icon: <Loader2 className="motion-safe:animate-spin" /> }
  return { tone: 'green', title: '就绪', detail: '等待输入，每个字都会立刻写到纸上', icon: <PenLine /> }
}

const TONE: Record<Tone, string> = {
  green: 'bg-green/15 text-on-tint-green',
  blue: 'bg-blue/15 text-on-tint-blue',
  orange: 'bg-orange/15 text-on-tint-orange',
  red: 'bg-red/15 text-on-tint-red',
  gray: 'bg-fill text-secondary-label',
}

function Item({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-caption text-secondary-label">{label}</dt>
      <dd className="truncate text-subheadline font-medium tabular-nums text-label" data-testid={testId}>{children}</dd>
    </div>
  )
}

/**
 * Session status (HIG-style summary card): one prominent state line, then the facts in a grid. Everything here
 * comes from the teletype store, which is kept in step with GET /teletype/state and the WS `teletype` events.
 */
export function TeletypeStatus() {
  const phase = useTeletypePhase()
  const rate = useRate()
  const s = useTeletype(
    useShallow((x) => ({
      mode: x.mode, font: x.font, nextFont: x.nextFont, paper: x.paper, queued: x.queued, written: x.written, pending: x.pending,
      pen: x.pen, cfg: x.cfg, machineState: x.machineState, missing: x.missing, chars: x.chars, rev: x.rev,
    })),
  )
  const onPage = s.chars.size
  const penDown = s.pen && s.cfg ? s.pen.z > (s.cfg.z_down + s.cfg.z_up) / 2 : null
  return (
    <Card className="overflow-hidden" data-testid="tt-status">
      <div className="flex items-center gap-3 px-4 py-3" role="status" aria-live="polite">
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-full [&_svg]:size-[18px]', TONE[phase.tone])}>{phase.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-headline text-label" data-testid="tt-phase">{phase.title}</div>
          <div className="truncate text-footnote text-secondary-label">{phase.detail}</div>
        </div>
      </div>
      <dl className="hairline-t grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-3 xl:grid-cols-6">
        <Item label="模式">{s.mode === 'term' ? '终端模式' : '打字模式'}</Item>
        <Item label="字体" testId="tt-font">
          <span title={s.nextFont ? `下一页改用 ${s.nextFont.name}` : undefined}>
            {s.mode === 'term' ? '内置等宽（终端）' : s.font?.name ?? '—'}
            {s.nextFont ? <span className="text-secondary-label"> → {s.nextFont.name}</span> : null}
          </span>
        </Item>
        <Item label="位置">{`第 ${s.paper.page} 页 · ${s.paper.row + 1} 行 ${s.paper.col + 1} 列`}</Item>
        <Item label="等待书写" testId="tt-queued">
          {`${s.queued} 字`}
          {s.pending > 0 ? <span className="font-normal text-secondary-label">{` · ${s.pending} 行指令`}</span> : null}
        </Item>
        <Item label="已写" testId="tt-written">
          {`${s.written} 字`}
          <span className="font-normal text-secondary-label">{rate > 0 ? ` · ${rate.toFixed(1)} 字/秒` : ` · 本页 ${onPage}`}</span>
        </Item>
        <Item label="笔">
          {s.pen ? (
            <span title={`X ${s.pen.x.toFixed(1)}  Y ${(-s.pen.y).toFixed(1)}  Z ${s.pen.z.toFixed(1)} · ${grblText(s.machineState)}`}>
              {penDown == null ? '' : penDown ? '落笔' : '抬笔'}
              <span className="font-normal text-secondary-label">{` · ${s.pen.x.toFixed(1)}, ${s.pen.y.toFixed(1)} mm`}</span>
            </span>
          ) : (
            '—'
          )}
        </Item>
      </dl>
      {s.missing.length ? (
        <div className="hairline-t flex items-start gap-2 px-4 py-2.5 text-footnote text-on-tint-orange" data-testid="tt-missing">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            当前字体里没有这些字，已画成方框：<span className="font-medium">{s.missing.slice(0, 40).join(' ')}</span>
            {s.missing.length > 40 ? ` 等 ${s.missing.length} 个` : ''}。可以在「书写设置」里换一款覆盖更全的字体。
          </span>
        </div>
      ) : null}
    </Card>
  )
}
