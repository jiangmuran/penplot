import { Gauge, Play } from 'lucide-react'
import { runAction } from './errors'
import { realtime, runMacro } from '@/api/machine-control'
import { useLive } from '@/api/store'
import { Button, Card, CardHeader, Segmented, Tooltip } from '@/components/ui'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import type { MachineGate } from './gate'

/** GRBL 1.1 realtime override bytes. */
const FEED = { reset: '0x90', plus10: '0x91', minus10: '0x92', plus1: '0x93', minus1: '0x94' }
const RAPID: Record<string, string> = { '100': '0x95', '50': '0x96', '25': '0x97' }

export function OverridesCard({ gate }: { gate: MachineGate }) {
  const ov = useLive((s) => s.machine?.ov) ?? [100, 100, 100]
  const feed = ov[0] ?? 100
  const rapid = String(ov[1] ?? 100)
  const disabled = !gate.connected || gate.leaseBlocked
  const send = (b: string) => runAction('调整倍率失败', () => realtime(b))
  return (
    <Card>
      <CardHeader title="倍率" subtitle="实时生效，可在任务进行中调节" />
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="flex items-center gap-3">
          <Gauge className="size-4 shrink-0 text-secondary-label" aria-hidden />
          <span className="text-subheadline text-label">进给</span>
          <span className={cn('ml-auto font-mono text-title3 tabular-nums', feed !== 100 ? 'text-orange' : 'text-label')} aria-live="polite">
            {feed}%
          </span>
        </div>
        <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="进给倍率">
          {[
            ['−10', FEED.minus10, '进给 −10%'],
            ['−1', FEED.minus1, '进给 −1%'],
            ['100%', FEED.reset, '进给恢复 100%'],
            ['+1', FEED.plus1, '进给 +1%'],
            ['+10', FEED.plus10, '进给 +10%'],
          ].map(([l, b, a]) => (
            <Button key={b} size="sm" variant={b === FEED.reset ? 'tinted' : 'gray'} aria-label={a} disabled={disabled} onClick={() => send(b)} className="px-0">
              {l}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-subheadline text-label">快速移动</span>
          <Segmented
            size="sm"
            className="ml-auto"
            aria-label="快速移动倍率"
            value={RAPID[rapid] ? rapid : '100'}
            onValueChange={(v) => send(RAPID[v])}
            options={['25', '50', '100'].map((v) => ({ value: v, label: `${v}%`, disabled }))}
          />
        </div>
      </div>
    </Card>
  )
}

export function MacrosCard({ macros, gate }: { macros: string[]; gate: MachineGate }) {
  const any = macros.some((m) => m.trim())
  return (
    <Card>
      <CardHeader title="宏" subtitle={any ? '在 设置 › 机器配置 中编辑' : '尚未配置宏（设置 › 机器配置 › 宏）'} />
      <div className="grid grid-cols-3 gap-2 px-4 pb-4">
        {macros.map((m, i) => {
          const n = (i + 1) as 1 | 2 | 3
          const first = m.trim().split('\n')[0] ?? ''
          const name = /^\s*\(([^)]+)\)|^\s*;\s*(.+)$/.exec(first)
          const label = name ? (name[1] ?? name[2]).trim().slice(0, 10) : `宏 ${n}`
          return (
            <Tooltip key={n} content={m.trim() ? <span className="whitespace-pre font-mono">{m.trim().slice(0, 200)}</span> : '未配置'}>
              <span>
                <Button
                  block
                  variant="gray"
                  icon={<Play />}
                  disabled={!m.trim() || !gate.canMove}
                  onClick={async () => {
                    const ok = await confirm({ title: `运行「${label}」？`, description: m.trim().slice(0, 300), confirmLabel: '运行' })
                    if (ok) await runAction('运行宏失败', () => runMacro(n), `已运行 ${label}`)
                  }}
                >
                  <span className="truncate">{label}</span>
                </Button>
              </span>
            </Tooltip>
          )
        })}
      </div>
    </Card>
  )
}
