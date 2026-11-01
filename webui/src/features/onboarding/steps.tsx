/** The six wizard steps. Each is self-contained; the frame (index.tsx) handles navigation. */
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BookOpen, Check, ChevronsDown, ChevronsUp, CircleAlert, Crosshair, Frame as FrameIcon, LayoutGrid, Lightbulb,
  Minus, PenLine, Play, Plug, Plus, RefreshCw, Square, Usb,
} from 'lucide-react'
import * as React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { startJobGuarded } from '@/api/job-guard'
import { ApiError, api, errorMessage } from '@/api/client'
import { useActiveProfile } from '@/api/machine-control'
import { patchProfile, useAppSettings, useFontsLite } from '@/api/profiles'
import { queryClient, qk } from '@/api/query'
import { useLive } from '@/api/store'
import type { Job } from '@/api/types'
import { Badge, Button, ProgressBar, Segmented, Select, Spinner } from '@/components/ui'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { HelpLink } from '@/features/help/HelpLink'
import { ConnectArt, DoneArt, PaperOriginArt, PenZArt, PlotterArt, TestSheetArt } from './illustrations'
import { machineActions, preferredPort, usePortList, useStatus, type Mode } from './machine'
import { useOnboarding } from './state'

export interface StepProps {
  mode: Mode
  /** Allow/forbid「下一步」(defaults to allowed). */
  setReady: (ready: boolean) => void
}

// ------------------------------------------------------------------ building blocks
export function StepHeader({ title, lead, art }: { title: string; lead: React.ReactNode; art?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      {art ? <div className="mx-auto w-full max-w-[420px]">{art}</div> : null}
      <div>
        <h1 className="text-title1 font-bold text-label">{title}</h1>
        <p className="mt-1.5 text-body leading-relaxed text-secondary-label">{lead}</p>
      </div>
    </div>
  )
}

function Task({ n, title, done, children, help }: { n: number; title: React.ReactNode; done?: boolean; children?: React.ReactNode; help?: string }) {
  return (
    <section className="flex gap-3 rounded-xl bg-bg-grouped-secondary p-4 shadow-sm">
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full text-footnote font-semibold transition-colors',
          done ? 'bg-green text-white' : 'bg-fill text-secondary-label',
        )}
        aria-label={done ? '已完成' : `第 ${n} 步`}
      >
        {done ? <Check className="size-3.5" strokeWidth={3} /> : n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <h2 className="flex items-center gap-1.5 text-headline text-label">
          {title}
          {help ? <HelpLink topic={help} /> : null}
        </h2>
        {children}
      </div>
    </section>
  )
}

function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok'; children: React.ReactNode }) {
  const Icon = tone === 'warn' ? CircleAlert : tone === 'ok' ? Check : Lightbulb
  return (
    <div
      className={cn(
        'flex gap-2 rounded-lg px-3 py-2.5 text-callout',
        tone === 'warn' && 'bg-orange/15 text-on-tint-orange',
        tone === 'ok' && 'bg-green/15 text-on-tint-green',
        tone === 'info' && 'bg-accent/10 text-label',
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'info' && 'text-accent')} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function useAct() {
  const [busy, setBusy] = React.useState<string | null>(null)
  const run = React.useCallback(async (key: string, title: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key)
    try {
      await fn()
      if (success) toast.success(success)
      return true
    } catch (e) {
      const hint = e instanceof ApiError && e.code === 'machine_busy' ? '机器正在执行任务，等它结束或先停止任务。' : e instanceof ApiError && e.code === 'port_busy' ? '端口被别的程序占用（例如电传打字机演示）。' : undefined
      toast.error(title, { description: hint ? `${hint}（${errorMessage(e)}）` : errorMessage(e), key: title })
      return false
    } finally {
      setBusy(null)
    }
  }, [])
  return { busy, run }
}

function DemoBadge({ mode }: { mode: Mode }) {
  if (mode !== 'demo') return null
  return (
    <Note tone="warn">
      <strong>演示模式</strong>：没有连上后台服务，下面的操作只在页面里模拟，不会动机器。
    </Note>
  )
}

// ------------------------------------------------------------------ 1 欢迎
export function WelcomeStep({ onStart, onLater }: { onStart: () => void; onLater: () => void }) {
  const items: [React.ComponentType<{ className?: string }>, string, string][] = [
    [Usb, '连接写字机', '选好端口，确认固件正常'],
    [PenLine, '认识你的笔', '找到笔尖刚好接触纸的高度'],
    [Crosshair, '放纸与原点', '把纸固定好，告诉机器从哪里开始写'],
    [Square, '试写', '写一个 2 cm 方块和「你好」，看看效果'],
  ]
  return (
    <div className="flex flex-col gap-6">
      <StepHeader
        title="欢迎使用写字机工作台"
        lead="接下来几步会带你把机器调好，并写出第一张纸。大约需要 10 分钟。每一步都可以跳过，随时可以回来继续。"
        art={<PlotterArt />}
      />
      <ul className="grid gap-2 sm:grid-cols-2">
        {items.map(([Icon, t, d]) => (
          <li key={t} className="flex gap-3 rounded-xl bg-bg-grouped-secondary p-3.5 shadow-sm">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Icon className="size-4" />
            </span>
            <span>
              <span className="block text-headline text-label">{t}</span>
              <span className="block text-footnote text-secondary-label">{d}</span>
            </span>
          </li>
        ))}
      </ul>
      <Note>
        准备好：写字机和控制盒通电、一支笔、几张 A4 纸、一卷胶带。
      </Note>
      <div className="flex flex-wrap gap-2">
        <Button variant="filled" size="lg" onClick={onStart} icon={<Play />}>
          开始设置
        </Button>
        <Button variant="plain" size="lg" onClick={onLater}>
          以后再说
        </Button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 2 连接
export function ConnectStep({ mode, setReady }: StepProps) {
  const status = useStatus(mode)
  const ports = usePortList(mode)
  const { data, update } = { data: useOnboarding((s) => s.s.data), update: useOnboarding((s) => s.update) }
  const [picked, setPort] = React.useState<string | undefined>(data.port)
  const port = picked ?? preferredPort(ports.data, status?.port)
  const { busy, run } = useAct()
  const act = machineActions(mode)
  const connected = !!status?.connected
  const fw = status?.firmware ?? null
  const fwOk = !!fw && /^1\.1/.test(fw)
  React.useEffect(() => setReady(connected), [connected, setReady])

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        title="连接写字机"
        lead="用 USB 线把写字机接到控制盒上，打开写字机电源。然后在下面选择端口并连接。"
        art={<ConnectArt connected={connected} />}
      />
      <DemoBadge mode={mode} />
      <Task n={1} title="选择端口" done={!!port}>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="min-w-0 flex-1 sm:max-w-[360px]"
            aria-label="串口"
            value={port}
            onValueChange={setPort}
            placeholder={ports.isPending ? '正在查找…' : '没有找到端口'}
            options={(ports.data ?? []).map((p) => ({
              value: p.by_id ?? p.path,
              label: (
                <span className="flex items-center gap-2">
                  <span className="truncate">{p.path === 'fake' ? '模拟器（开发用）' : p.description && p.description !== 'n/a' ? p.description : p.path}</span>
                  <span className="truncate text-footnote text-tertiary-label">{p.path === 'fake' ? '' : p.path}</span>
                  {p.busy_pid ? <Badge tone="orange">被占用</Badge> : null}
                </span>
              ),
            }))}
          />
          <Button variant="gray" icon={<RefreshCw />} onClick={() => void ports.refetch()} loading={ports.isFetching}>
            刷新
          </Button>
        </div>
        <p className="text-footnote text-secondary-label">一般选名字里带「USB Serial」或「CH340」的那一个。拔插一次 USB 再刷新，新出现的就是它。</p>
      </Task>
      <Task n={2} title="连接" done={connected}>
        {connected ? (
          <Note tone="ok">
            已连接{status?.port ? `：${status.port}` : ''}。状态：{status?.state_text || '空闲'}
            {status?.fake ? '（模拟器）' : ''}
          </Note>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="filled"
              icon={<Plug />}
              disabled={!port}
              loading={busy === 'connect' || !!status?.connecting}
              onClick={() =>
                void run('connect', '连接失败', async () => {
                  await act.connect(port)
                  update({ data: { port } })
                  void queryClient.invalidateQueries({ queryKey: qk.machine.status })
                })
              }
            >
              连接
            </Button>
            {status?.error ? <span className="text-footnote text-red">{status.error}</span> : null}
          </div>
        )}
      </Task>
      <Task n={3} title="检查固件" done={connected && fwOk}>
        {!connected ? (
          <p className="text-callout text-secondary-label">连接后会自动读取固件版本。</p>
        ) : fwOk ? (
          <Note tone="ok">固件 GRBL {fw}，和本软件兼容。</Note>
        ) : fw ? (
          <Note tone="warn">固件版本是 {fw}。本软件按 GRBL 1.1 测试，其他版本可能有部分功能不可用。</Note>
        ) : (
          <Note tone="warn">
            没有读到固件版本。常见原因：波特率不是 115200，或主板还在启动。等 3 秒后断开重连试试。
            <Link to="/help/troubleshooting#cannot-connect" className="ml-1 text-accent">
              查看排查方法
            </Link>
          </Note>
        )}
      </Task>
    </div>
  )
}

// ------------------------------------------------------------------ 3 笔
async function savePen(mode: Mode, profileId: string | undefined, v: { type: 'Stepper' | 'Servo'; down?: number; up?: number }) {
  if (mode === 'demo' || !profileId) return
  const grbl: Record<string, unknown> = { type: v.type }
  const pd: Record<string, unknown> = {}
  if (v.down != null) {
    grbl.zOn = v.down
    pd.pen_down_z = v.down
  }
  if (v.up != null) {
    grbl.zOff = v.up
    pd.pen_up_z = v.up
  }
  await patchProfile(profileId, { doc: { grbl, print_defaults: pd } })
  await queryClient.invalidateQueries({ queryKey: qk.profiles.all })
}

export function PenStep({ mode, setReady }: StepProps) {
  const status = useStatus(mode)
  const { profile } = useActiveProfile()
  const data = useOnboarding((s) => s.s.data)
  const update = useOnboarding((s) => s.update)
  const profType = (profile?.doc?.grbl as { type?: string } | undefined)?.type
  const [type, setType] = React.useState<'Stepper' | 'Servo'>(data.penType ?? (profType === 'Servo' ? 'Servo' : 'Stepper'))
  const [zeroed, setZeroed] = React.useState(false)
  const [extra, setExtra] = React.useState('0.5')
  const [saved, setSaved] = React.useState(false)
  const { busy, run } = useAct()
  const act = machineActions(mode)
  const z = Array.isArray(status?.wpos) ? (status.wpos[2] ?? 0) : 0
  const connected = !!status?.connected
  const touch = data.touchZ
  const down = touch != null ? Math.round((touch + Number(extra)) * 10) / 10 : undefined
  React.useEffect(() => setReady(saved || type === 'Servo'), [saved, type, setReady])

  const jogZ = (dz: number) => {
    if (z + dz < -0.01) return toast.info('已经在 Z0（抬笔位置）了', { key: 'z0' })
    if (z + dz > 20) return toast.info('最多只能下探到 Z20', { key: 'z20' })
    void run('jog', '移动失败', () => act.jog({ dz }))
  }

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        title="认识你的笔"
        lead={
          <>
            笔压决定了线条好不好看：太轻会断线，太重会划纸。这一步找到笔尖<strong className="text-label">刚好接触纸面</strong>的高度。
          </>
        }
      />
      <DemoBadge mode={mode} />
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-callout text-secondary-label">笔的类型</span>
        <Segmented
          aria-label="笔的类型"
          value={type}
          onValueChange={(v) => {
            setType(v)
            update({ data: { penType: v } })
          }}
          options={[
            { value: 'Stepper', label: 'Z 轴步进笔' },
            { value: 'Servo', label: '舵机笔' },
          ]}
        />
      </div>

      {!connected ? <Note tone="warn">还没有连接写字机。可以先回到上一步连接，或者跳过这一步，以后在「控制」页调整。</Note> : null}

      {type === 'Servo' ? (
        <Task n={1} title="测试抬笔和落笔" help="pen">
          <p className="text-callout text-secondary-label">舵机笔只有「抬」和「落」两个位置。点下面两个按钮，确认方向是对的：落笔时笔尖碰到纸，抬笔时离开纸面。方向反了到 设置 → 机器配置 里交换两个角度。</p>
          <div className="flex gap-2">
            <Button variant="gray" icon={<ChevronsUp />} disabled={!connected} onClick={() => void run('pen', '抬笔失败', () => act.pen('up'))}>
              抬笔
            </Button>
            <Button variant="gray" icon={<ChevronsDown />} disabled={!connected} onClick={() => void run('pen', '落笔失败', () => act.pen('down'))}>
              落笔
            </Button>
            <Button variant="tinted" onClick={() => void run('save', '保存失败', () => savePen(mode, profile?.id, { type: 'Servo' }), '已保存')}>
              保存为舵机笔
            </Button>
          </div>
        </Task>
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
            <div className="flex flex-col gap-3">
              <Task n={1} title="确认笔停在抬起的位置" done={zeroed} help="pen">
                <p className="text-callout text-secondary-label">
                  本机 <strong className="text-label">Z0 = 抬笔</strong>（停放位置），Z 往正方向走笔就往下压。先用手把笔推到最上面（或确认它悬空、离纸 3–5 mm），再点按钮把这里记为 Z0。
                </p>
                <Button variant={zeroed ? 'gray' : 'filled'} icon={<Crosshair />} disabled={!connected} loading={busy === 'zero'} onClick={() => void run('zero', '设置失败', async () => {
                  await act.zero('z')
                  setZeroed(true)
                })}>
                  {zeroed ? '已设为 Z0' : '笔现在是抬起的，设为 Z0'}
                </Button>
              </Task>
              <Task n={2} title="慢慢往下，直到笔尖碰到纸" done={touch != null}>
                <p className="text-callout text-secondary-label">先用 1 mm 快速接近，快碰到时改用 0.1 mm。笔尖刚刚碰到纸、还没压弯的时候停下。</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="gray" icon={<Minus />} disabled={!connected || !zeroed} onClick={() => jogZ(-0.5)} aria-label="上升 0.5 毫米">
                    上 0.5
                  </Button>
                  <Button variant="gray" icon={<Minus />} disabled={!connected || !zeroed} onClick={() => jogZ(-0.1)} aria-label="上升 0.1 毫米">
                    上 0.1
                  </Button>
                  <span className="min-w-[88px] rounded-md bg-fill px-3 py-1 text-center font-mono text-title3 tabular-nums text-label" aria-live="polite">
                    Z {z.toFixed(1)}
                  </span>
                  <Button variant="gray" icon={<Plus />} disabled={!connected || !zeroed} onClick={() => jogZ(0.1)} aria-label="下降 0.1 毫米">
                    下 0.1
                  </Button>
                  <Button variant="gray" icon={<Plus />} disabled={!connected || !zeroed} onClick={() => jogZ(0.5)} aria-label="下降 0.5 毫米">
                    下 0.5
                  </Button>
                  <Button variant="gray" icon={<ArrowDown />} disabled={!connected || !zeroed} onClick={() => jogZ(1)} aria-label="下降 1 毫米">
                    下 1
                  </Button>
                </div>
                <Button
                  variant={touch != null ? 'gray' : 'filled'}
                  className="self-start"
                  disabled={!connected || !zeroed || z <= 0}
                  icon={<Check />}
                  onClick={() => update({ data: { touchZ: Math.round(z * 10) / 10 } })}
                >
                  {touch != null ? `已记录：Z${touch.toFixed(1)} 刚好接触` : '就是这里，刚好碰到纸'}
                </Button>
              </Task>
              <Task n={3} title="选择笔压，保存" done={saved}>
                <p className="text-callout text-secondary-label">在刚好接触的位置上再多压一点，线条才连贯。圆珠笔、中性笔 0.5 mm；软头笔、毛笔 1 mm；很细的针管笔 0.3 mm。</p>
                <Segmented
                  aria-label="多压多少"
                  value={extra}
                  onValueChange={setExtra}
                  options={[
                    { value: '0.3', label: '轻 +0.3' },
                    { value: '0.5', label: '适中 +0.5' },
                    { value: '1', label: '重 +1.0' },
                  ]}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="filled"
                    disabled={down == null}
                    loading={busy === 'save'}
                    onClick={() =>
                      void run('save', '保存失败', async () => {
                        await savePen(mode, profile?.id, { type: 'Stepper', down, up: 0 })
                        update({ data: { penDownZ: down, penUpZ: 0, penType: 'Stepper' } })
                        await act.pen('up', down).catch(() => act.jog({ dz: -z }))
                        setSaved(true)
                      }, `已保存：落笔 Z${down?.toFixed(1)}，抬笔 Z0`)
                    }
                  >
                    保存{down != null ? `：落笔 Z${down.toFixed(1)}` : ''}，抬笔
                  </Button>
                  {profile ? <span className="text-footnote text-tertiary-label">写入机器配置「{profile.name}」</span> : null}
                </div>
              </Task>
            </div>
            <div className="lg:sticky lg:top-4 lg:self-start">
              <div className="rounded-xl bg-bg-grouped-secondary p-3 shadow-sm">
                <PenZArt z={Math.max(0, z)} touchZ={touch ?? 8} downZ={down} />
                <p className="mt-1 text-center text-footnote text-secondary-label">侧面看：Z 越大，笔越往下</p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ 4 放纸与原点
const PAPERS = [
  { value: 'test', label: '试写区 90×40', w: 90, h: 40 },
  { value: 'postcard', label: '明信片 148×100', w: 148, h: 100 },
  { value: 'a5', label: 'A5 148×210', w: 148, h: 210 },
  { value: 'a4', label: 'A4 210×297', w: 210, h: 297 },
]

export function PaperStep({ mode, setReady }: StepProps) {
  const status = useStatus(mode)
  const { profile } = useActiveProfile()
  const data = useOnboarding((s) => s.s.data)
  const update = useOnboarding((s) => s.update)
  const [step, setStep] = React.useState('10')
  const [zeroed, setZeroed] = React.useState(false)
  const [framed, setFramed] = React.useState(false)
  const paper = PAPERS.find((p) => p.value === (data.paper ?? 'test')) ?? PAPERS[0]
  const { busy, run } = useAct()
  const act = machineActions(mode)
  const connected = !!status?.connected
  const work = profile?.doc?.work_area as { w_mm?: number; h_mm?: number } | undefined
  const tooBig = !!work && (work.w_mm ?? 0) > 0 && (work.h_mm ?? 0) > 0 && (paper.w > work.w_mm! || paper.h > work.h_mm!)
  React.useEffect(() => setReady(zeroed), [zeroed, setReady])
  const s = Number(step)
  const mv = (dx: number, dy: number) => void run('jog', '移动失败', () => act.jog({ dx, dy }))

  return (
    <div className="flex flex-col gap-5">
      <StepHeader
        title="放纸与原点"
        lead={
          <>
            写字机没有「回零」开关，<strong className="text-label">开始写字时笔在哪里，哪里就是原点</strong>。原点对应要写内容的左上角（不是纸角，纸夹挡住纸角也没关系），所以只要把笔停在你想开始写的地方就行。
          </>
        }
      />
      <DemoBadge mode={mode} />
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-3">
          <Task n={1} title="把纸固定好">
            <p className="text-callout text-secondary-label">纸放在笔够得到的范围内，纸边和机器横梁平行，用胶带或纸夹固定牢。不固定的话，笔尖会把纸带着走。</p>
          </Task>
          <Task n={2} title="把笔移到要写内容的左上角" help="origin">
            <div className="flex flex-wrap items-center gap-4">
              <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="移动笔">
                <span />
                <Button variant="gray" size="lg" aria-label="向上（远离你）" disabled={!connected} onClick={() => mv(0, s)} icon={<ArrowUp />} />
                <span />
                <Button variant="gray" size="lg" aria-label="向左" disabled={!connected} onClick={() => mv(-s, 0)} icon={<ArrowLeft />} />
                <Button variant="gray" size="lg" aria-label="抬笔" disabled={!connected} onClick={() => void run('pen', '抬笔失败', () => act.pen('up'))}>
                  <ChevronsUp />
                </Button>
                <Button variant="gray" size="lg" aria-label="向右" disabled={!connected} onClick={() => mv(s, 0)} icon={<ArrowRight />} />
                <span />
                <Button variant="gray" size="lg" aria-label="向下（靠近你）" disabled={!connected} onClick={() => mv(0, -s)} icon={<ArrowDown />} />
                <span />
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-footnote text-secondary-label">每次移动</span>
                <Segmented aria-label="每次移动距离" value={step} onValueChange={setStep} options={[{ value: '1', label: '1 mm' }, { value: '10', label: '10 mm' }, { value: '50', label: '50 mm' }]} />
                <span className="text-footnote text-tertiary-label">中间的按钮 = 抬笔。移动前请确认笔是抬起的。</span>
              </div>
            </div>
          </Task>
          <Task n={3} title="设为原点" done={zeroed}>
            <p className="text-callout text-secondary-label">开始前：把笔（抬起状态）停在要写内容的左上角，也就是第一行第一个字的左上方，然后点：</p>
            <Button variant={zeroed ? 'gray' : 'filled'} icon={<Crosshair />} className="self-start" disabled={!connected} loading={busy === 'zero'} onClick={() => void run('zero', '设原点失败', async () => {
              await act.zero('xy')
              setZeroed(true)
            }, '已设为原点')}>
              {zeroed ? '已设为原点（可重新设置）' : '把这里设为原点'}
            </Button>
          </Task>
          <Task n={4} title="走边框，确认范围" done={framed} help="frame">
            <p className="text-callout text-secondary-label">笔会抬着沿下面这个大小的外框走一圈，再回到原点。看看它有没有跑出纸外。</p>
            <div className="flex flex-wrap items-center gap-2">
              <Select aria-label="边框大小" className="w-48" value={paper.value} onValueChange={(v) => update({ data: { paper: v } })} options={PAPERS.map((p) => ({ value: p.value, label: p.label }))} />
              <Button variant="tinted" icon={<FrameIcon />} disabled={!connected || !zeroed} loading={busy === 'frame'} onClick={() => void run('frame', '走边框失败', async () => {
                await act.frame(paper.w, paper.h)
                setFramed(true)
              })}>
                走边框
              </Button>
            </div>
            {tooBig ? <Note tone="warn">这个尺寸超出了机器行程（{work?.w_mm}×{work?.h_mm} mm），走边框可能撞到边缘。</Note> : null}
            {framed ? <Note tone="ok">边框走完了。如果跑出了纸，挪一下纸或回到第 2 步重新设原点。</Note> : null}
          </Task>
        </div>
        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-xl bg-bg-grouped-secondary p-3 shadow-sm">
            <PaperOriginArt framing={busy === 'frame' || framed} />
            <p className="mt-1 text-center text-footnote text-secondary-label">原点 = 要写内容的左上角；X 向右，Y 向下</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 5 试写
const TEST_PAPER = { name: '试写 90×40', width_mm: 90, height_mm: 40, margins: { l: 0, r: 0, t: 0, b: 0 }, orientation: 'portrait', rotation: 0, ruling: { line_num: 4, line_gap: 0, line_gap_offset: 0, base_line: 1 } }
const PREFERRED_FONT = 'xxn6900_kvenjoy_小晓宁'

function testDoc(fontId: string | undefined) {
  const tr = (x: number, y: number) => ({ x, y, scale: 1, sx: 1, sy: 1, rotation: 0 })
  return {
    version: 1,
    name: '设置向导 · 试写',
    variables: [],
    paper: { paper_id: null, spec: TEST_PAPER },
    print: { optimize: true },
    pages: [
      {
        id: 'p1', paper: null, origin: null,
        elements: [
          { id: 'sq', type: 'shape', name: '2 cm 方块', transform: tr(5, 5), z: 0, locked: false, hidden: false, pen: 1, props: { kind: 'rect', w: 20, h: 20 } },
          { id: 'hi', type: 'text', name: '你好', transform: tr(32, 6), z: 1, locked: false, hidden: false, pen: 1, props: { text: '你好', font_id: fontId ?? null, size_mm: 18, line_height: 1.0, align: 'L', box: null, seed: 1, missing_glyph: 'box' } },
        ],
      },
    ],
  }
}

interface RenderPage { est_s?: number; warnings?: { missing_glyphs?: string[] } }
interface RenderResult { rid: string; pages: RenderPage[] }

async function renderTest(fontId: string | undefined): Promise<RenderResult> {
  const p = await api.post<{ id: string }>('/projects', { name: '设置向导 · 试写', doc: testDoc(fontId) })
  try {
    let r = await api.post<RenderResult | { task_id: string }>(`/projects/${p.id}/render`, { pages: 'all' }, { query: { wait: 20 }, timeoutMs: 40_000 })
    for (let i = 0; 'task_id' in r && i < 60; i++) {
      await new Promise((res) => setTimeout(res, 1000))
      const t = await api.get<{ state: string; result?: RenderResult; error?: { message?: string } }>(`/tasks/${r.task_id}`)
      if (t.state === 'done' && t.result) r = t.result
      else if (t.state === 'failed' || t.state === 'cancelled') throw new Error(t.error?.message ?? '渲染失败')
    }
    if ('task_id' in r) throw new Error('渲染超时')
    return r
  } finally {
    // the render result is cached server-side; the throwaway project isn't needed any more
    void api.delete(`/projects/${p.id}`).catch(() => undefined)
  }
}

const RESULTS = [
  { value: 'good', label: '很好', hint: '线条连贯，方块和字都清楚' },
  { value: 'light', label: '线断断续续 / 颜色淡', hint: '笔压太轻' },
  { value: 'heavy', label: '线太粗 / 划纸 / 纸被拖动', hint: '笔压太重' },
  { value: 'size', label: '方块不是 2 cm', hint: '机器的步数参数需要校准' },
  { value: 'place', label: '位置不对 / 写出纸外', hint: '原点没对准' },
] as const

export function TestStep({ mode, setReady }: StepProps) {
  const data = useOnboarding((s) => s.s.data)
  const update = useOnboarding((s) => s.update)
  const status = useStatus(mode)
  const { profile } = useActiveProfile()
  const settings = useAppSettings()
  const fonts = useFontsLite()
  const liveJob = useLive((s) => s.job)
  const finished = useLive((s) => s.finished)
  const { busy, run } = useAct()
  const act = machineActions(mode)
  const [demoProgress, setDemoProgress] = React.useState<number | null>(null)

  const fontOptions = (fonts.data ?? []).filter((f) => !f.hidden).map((f) => ({ value: f.id, label: f.display_name || f.id }))
  const fontId = data.fontId ?? (fonts.data?.some((f) => f.id === PREFERRED_FONT) ? PREFERRED_FONT : (settings.data?.default_font ?? fonts.data?.[0]?.id))

  const render = useQuery({
    queryKey: ['onboarding', 'test-render', fontId],
    queryFn: () => renderTest(fontId),
    enabled: mode === 'live' && !!fontId,
    staleTime: Infinity,
    retry: false,
  })
  const job = useQuery({
    queryKey: ['jobs', 'detail', data.testJobId],
    queryFn: () => api.get<Job>(`/jobs/${data.testJobId}`),
    enabled: mode === 'live' && !!data.testJobId,
    refetchInterval: (q) => (q.state.data && ['done', 'failed', 'aborted'].includes(q.state.data.status) ? false : 2000),
  })
  const j = liveJob?.id === data.testJobId ? liveJob : finished && finished.job.id === data.testJobId ? finished.job : job.data
  const jobState = mode === 'demo' ? (demoProgress == null ? null : demoProgress >= 100 ? 'done' : 'running') : (j?.status ?? null)
  const percent = mode === 'demo' ? (demoProgress ?? 0) : (j?.percent ?? 0)
  const finishedOk = jobState === 'done'
  React.useEffect(() => setReady(finishedOk || !!data.testResult), [finishedOk, data.testResult, setReady])

  const page = render.data?.pages?.[0]
  const missing = page?.warnings?.missing_glyphs ?? []
  const connected = !!status?.connected
  const down = data.penDownZ ?? ((profile?.doc?.grbl as { zOn?: number } | undefined)?.zOn ?? 8)

  const start = () =>
    run('start', '开始试写失败', async () => {
      update({ data: { testResult: '' } })
      if (mode === 'demo') {
        setDemoProgress(0)
        for (let p = 0; p <= 100; p += 10) {
          await new Promise((r) => setTimeout(r, 250))
          setDemoProgress(p)
        }
        return
      }
      const rid = render.data?.rid
      if (!rid) throw new Error('预览还没准备好')
      const created = await api.post<Job>('/jobs', { source: { render_id: rid, page: 0 }, name: '设置向导 · 试写', start: false, overrides: { pen_down_z: down } }, { idempotencyKey: true })
      const started = await startJobGuarded(created.id)
      if (!started) return
      update({ data: { testJobId: created.id } })
    })

  const adjust = (delta: number) =>
    run('adjust', '保存失败', async () => {
      const nd = Math.max(0.5, Math.min(20, Math.round((down + delta) * 10) / 10))
      if (mode === 'live' && profile) await patchProfile(profile.id, { doc: { grbl: { zOn: nd }, print_defaults: { pen_down_z: nd } } })
      update({ data: { penDownZ: nd } })
      void queryClient.invalidateQueries({ queryKey: qk.profiles.all })
      toast.success(`落笔高度改为 Z${nd.toFixed(1)}`, { description: '把笔移到旁边的空白处，再试一次。' })
    })

  return (
    <div className="flex flex-col gap-5">
      <StepHeader title="试写" lead="写一个 2 cm 的方块和「你好」两个字，大约 1 分钟。笔会从原点（你停笔的位置，内容的左上角）开始写。" />
      <DemoBadge mode={mode} />
      <div className="grid gap-5 md:grid-cols-[1fr_280px]">
        <div className="flex flex-col gap-3">
          <Task n={1} title="选一个字体" help="single-line-font">
            {mode === 'demo' ? (
              <p className="text-callout text-secondary-label">演示模式下使用示意字体。</p>
            ) : (
              <Select aria-label="字体" className="w-full sm:max-w-[320px]" value={fontId} onValueChange={(v) => update({ data: { fontId: v } })} options={fontOptions} placeholder={fonts.isPending ? '加载字体…' : '没有字体'} />
            )}
            {missing.length ? <Note tone="warn">这个字体缺「{missing.join('')}」字，会写成方框。换一个字体吧。</Note> : null}
          </Task>
          <Task n={2} title="开始" done={finishedOk}>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="filled" icon={<Play />} disabled={!connected || (mode === 'live' && !render.data) || jobState === 'running' || jobState === 'preparing'} loading={busy === 'start'} onClick={() => void start()}>
                {jobState ? '再写一次' : '开始试写'}
              </Button>
              <span className="text-footnote text-secondary-label">
                落笔高度 Z{down.toFixed(1)}
                {page?.est_s ? ` · 预计 ${Math.max(1, Math.round(page.est_s))} 秒` : ''}
              </span>
            </div>
            {!connected ? <p className="text-footnote text-orange">需要先连接写字机。</p> : null}
            {jobState && jobState !== 'done' ? (
              <ProgressBar value={percent} label={jobState === 'failed' || jobState === 'aborted' ? '没有写完' : '正在写…'} valueText={`${Math.round(percent)}%`} tone={jobState === 'failed' || jobState === 'aborted' ? 'red' : 'accent'} />
            ) : null}
            {j && (j.status === 'failed' || j.status === 'aborted') ? (
              <Note tone="warn">
                任务结束了：{j.reason ?? j.status}。<Link className="text-accent" to="/help/troubleshooting">查看故障排除</Link>
              </Note>
            ) : null}
          </Task>
          <Task n={3} title="结果怎么样？" done={data.testResult === 'good'}>
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="试写结果">
              {RESULTS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  role="radio"
                  aria-checked={data.testResult === r.value}
                  onClick={() => update({ data: { testResult: r.value } })}
                  className={cn(
                    'focus-ring flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                    data.testResult === r.value ? 'bg-accent/15 ring-1 ring-accent' : 'bg-fill hover:bg-secondary-fill',
                  )}
                >
                  <span className="text-body text-label">{r.label}</span>
                  <span className="text-footnote text-secondary-label">{r.hint}</span>
                </button>
              ))}
            </div>
            {data.testResult === 'light' || data.testResult === 'heavy' ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="tinted" icon={data.testResult === 'light' ? <ArrowDown /> : <ArrowUp />} loading={busy === 'adjust'} onClick={() => void adjust(data.testResult === 'light' ? 0.3 : -0.3)}>
                  {data.testResult === 'light' ? '压深 0.3 mm' : '抬高 0.3 mm'}
                </Button>
                <Button variant="gray" icon={<ArrowRight />} disabled={!connected} onClick={() => void run('jog', '移动失败', () => act.jog({ dx: 50 }))}>
                  笔右移 50 mm 换块空白
                </Button>
              </div>
            ) : null}
            {data.testResult === 'size' ? (
              <Note tone="warn">
                机器的「每毫米步数」（固件参数 $100 / $101）不准。在「调试」页的固件参数里，按 新值 = 旧值 × 20 ÷ 实测边长 修改。
              </Note>
            ) : null}
            {data.testResult === 'place' ? (
              <Note>回到上一步重新设原点，先走边框确认，再来试写。<HelpLink topic="origin" className="ml-1" /></Note>
            ) : null}
            {data.testResult === 'good' ? <Note tone="ok">太好了！机器已经调好了。</Note> : null}
          </Task>
        </div>
        <div className="flex flex-col gap-2 md:sticky md:top-4 md:self-start">
          <div className="overflow-hidden rounded-xl bg-bg-grouped-secondary p-3 shadow-sm">
            <p className="mb-2 text-footnote font-medium text-secondary-label">预览</p>
            {mode === 'live' && render.data ? (
              <img alt="试写预览" className="w-full rounded-sm bg-white" src={api.url(`/render/${render.data.rid}/pages/0/preview.svg`)} />
            ) : mode === 'live' && render.isError ? (
              <p className="py-6 text-center text-footnote text-red">预览失败：{errorMessage(render.error)}</p>
            ) : mode === 'live' ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : (
              <TestSheetArt />
            )}
          </div>
          <p className="text-footnote text-tertiary-label">实际大小 90 × 40 mm，从原点开始。</p>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ 6 完成
export function DoneStep({ skipped }: { skipped: string[] }) {
  const navigate = useNavigate()
  const tips: [string, string, string][] = [
    ['每次开机先设原点', '断电、急停、报警之后，原点都会失效。', '/help/glossary#origin'],
    ['打印前走一遍边框', '笔抬着走，确认不会写出纸外。', '/help/glossary#frame'],
    ['出意外就按急停', 'Ctrl/⌘ + . 或右上角红色按钮。', '/help/safety#estop'],
    ['字变成方框？', '那是字体缺字，换个字体或混排补字。', '/help/fonts#missing'],
    ['一次写很多张', '用表格批量写信封、席位卡。', '/help/batch'],
  ]
  return (
    <div className="flex flex-col gap-6">
      <StepHeader title="设置完成" lead="写字机已经可以用了。下面几条记住了，能省下不少麻烦。" art={<DoneArt className="max-w-[220px]" />} />
      {skipped.length ? (
        <Note tone="warn">你跳过了：{skipped.join('、')}。需要时可以在帮助中心重新打开设置向导。</Note>
      ) : null}
      <ul className="flex flex-col gap-2">
        {tips.map(([t, d, href]) => (
          <li key={t}>
            <Link to={href} className="focus-ring flex items-center gap-3 rounded-xl bg-bg-grouped-secondary p-3.5 shadow-sm transition-colors hover:bg-quaternary-fill">
              <Lightbulb className="size-5 shrink-0 text-yellow" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-headline text-label">{t}</span>
                <span className="block text-footnote text-secondary-label">{d}</span>
              </span>
              <ArrowRight className="size-4 text-tertiary-label" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="filled" size="lg" icon={<PenLine />} onClick={() => navigate('/studio')}>
          开始创作
        </Button>
        <Button variant="tinted" size="lg" icon={<LayoutGrid />} onClick={() => navigate('/projects')}>
          从模板开始
        </Button>
        <Button variant="plain" size="lg" icon={<BookOpen />} onClick={() => navigate('/help')}>
          帮助中心
        </Button>
      </div>
    </div>
  )
}

