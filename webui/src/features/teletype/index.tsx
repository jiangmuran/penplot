import { CirclePause, Crosshair, FilePlus2, House, MoreHorizontal, Play, Power, ShieldAlert, Square, SquareTerminal, TriangleAlert, Type } from 'lucide-react'
import * as React from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useLease, useMe, useRole } from '@/api/collab'
import { runAction } from '@/api/machine'
import { setZero } from '@/api/machine-control'
import { useLive } from '@/api/store'
import { DEFAULT_FORM, MONO_FONT, teletypeApi, type SessionForm, type TeletypeActionName, type TeletypeMode } from '@/api/teletype'
import { useWsTopics } from '@/api/ws'
import { Page } from '@/app/page'
import {
  Button, Card, CardHeader, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
  ErrorState, IconButton, Segmented, Skeleton, Spinner,
} from '@/components/ui'
import { useMachineGate } from '@/features/machine/gate'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { formatTime } from '@/lib/format'
import { useIsCompact } from '@/lib/media'
import { JogCard, SettingsForm } from './controls'
import { PaperPreview } from './paper-preview'
import { useTeletypePreview } from './preview'
import { TeletypeStatus } from './status'
import { applyTeletypeState, loadTeletype, useTeletype, wireTeletype } from './store'
import { TypePad } from './type-pad'

const TeletypeTerminal = React.lazy(() => import('./terminal'))
const FORM_KEY = 'penplot.teletype.form'

function loadForm(): SessionForm {
  try {
    return { ...DEFAULT_FORM, ...(JSON.parse(localStorage.getItem(FORM_KEY) ?? '{}') as Partial<SessionForm>) }
  } catch {
    return DEFAULT_FORM
  }
}

function act(a: TeletypeActionName, title: string, args?: Record<string, unknown>) {
  return runAction(title, async () => applyTeletypeState(await teletypeApi.action(a, args)))
}

function Notice({ tone = 'gray', icon, children, action }: { tone?: 'gray' | 'orange' | 'red'; icon?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-3 rounded-lg px-4 py-2.5 text-callout',
        tone === 'gray' && 'bg-fill text-secondary-label',
        tone === 'orange' && 'bg-orange/12 text-on-tint-orange',
        tone === 'red' && 'bg-red/12 text-on-tint-red',
      )}
    >
      <span className="shrink-0 [&_svg]:size-4">{icon ?? <ShieldAlert />}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  )
}

export default function TeletypePage() {
  const compact = useIsCompact()
  const role = useRole()
  const lease = useLease()
  const gate = useMachineGate()
  const myId = useMe().data?.id
  const penState = useLive((x) => x.machine?.pen)
  useWsTopics(['teletype' as never])
  const s = useTeletype(
    useShallow((x) => ({
      availability: x.availability, error: x.error, active: x.active, terminalEnabled: x.terminalEnabled, owner: x.owner,
      mode: x.mode, paper: x.paper, log: x.log, pending: x.pending, paused: x.paused, originOk: x.originOk, font: x.font,
    })),
  )
  const [form, setFormState] = React.useState<SessionForm>(loadForm)
  const [startMode, setStartMode] = React.useState<TeletypeMode>('type')
  const [starting, setStarting] = React.useState(false)
  const setForm = (f: SessionForm) => {
    setFormState(f)
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(f))
    } catch {
      /* private mode */
    }
  }

  React.useEffect(() => {
    wireTeletype()
    void loadTeletype()
  }, [])

  const ready = s.availability === 'ready'
  const termAllowed = ready && s.terminalEnabled && role === 'admin'
  const mode: TeletypeMode = s.mode === 'term' ? 'term' : 'type'
  const notMine = s.active && s.owner?.id && myId && s.owner.id !== myId
  const controlBlock =
    role === 'viewer' ? '只读账户不能书写'
    : !lease.canControl ? `控制权在 ${lease.holderName ?? '其他用户'} 手中，只能旁观`
    : !gate.online ? '与设备的连接已断开'
    : null
  const writeBlock =
    !s.active ? '先开始会话'
    : controlBlock
    ?? (!s.originOk ? '原点已失效：抬笔并把笔停在原来的左上角，再点「设为原点」'
      : s.paper.need_paper ? '这一页写满了：换纸后点「已换纸」继续'
      : null)
  const canWrite = ready && writeBlock == null
  const canControl = ready && s.active && controlBlock == null
  const startBlock =
    controlBlock
    ?? (!gate.connected ? '机器未连接'
      : gate.alarm ? '机器处于报警状态，请先在「控制」页解锁'
      : gate.jobActive ? '有任务正在进行，结束后才能开始电传会话'
      : null)
  const sample = useTeletypePreview(form, ready && !s.active).data ?? null

  const start = async () => {
    const zUnknown = penState === 'unknown'
    if (form.set_zero || zUnknown) {
      const ok = await confirm({
        title: '笔已经停在要写内容的左上角了吗？',
        description: zUnknown
          ? '写字机还不知道笔的高度。请确认笔已抬起（笔尖离开纸面），开始时会把现在的笔高设为抬笔位、现在的位置设为原点。'
          : '开始后，笔现在的位置就是这张纸的原点（第一行第一个字在它右下方，相隔边距）。笔应当是抬起的。',
        confirmLabel: '开始',
      })
      if (!ok) return
    }
    setStarting(true)
    try {
      await runAction('开始会话失败', async () => {
        if (zUnknown) await setZero('xyz')
        const st = await teletypeApi.start({
          char_h: form.char_h, feed: form.feed, margin: form.margin, paper_w_mm: form.paper_w, paper_h_mm: form.paper_h,
          z_up: form.z_up ?? undefined, max_backlog: form.max_backlog, mode: startMode, set_zero: form.set_zero,
          // terminal mode writes with the built-in font anyway; its grid should match it
          font_id: startMode === 'term' ? MONO_FONT : form.font_id, letter_spacing: form.letter_spacing, line_spacing: form.line_spacing,
        })
        applyTeletypeState(st)
      })
    } finally {
      setStarting(false)
    }
  }

  const end = async () => {
    const ok = await confirm({
      title: '结束电传会话？',
      description: s.pending > 0 ? `还有 ${s.pending} 行没写完，会被丢弃。笔会抬起并回到原点。` : '笔会抬起并回到原点，机器交还给任务队列。',
      confirmLabel: '结束会话',
      destructive: s.pending > 0,
    })
    if (!ok) return
    await runAction('结束会话失败', async () => applyTeletypeState(await teletypeApi.end()), '会话已结束')
  }

  const setMode = async (m: TeletypeMode) => {
    if (m === 'term') {
      const ok = await confirm({
        title: '切换到终端模式？',
        description: '这是设备上真正的交互式 shell，输入的命令会直接执行，会话同时抄写到纸上。',
        confirmLabel: '打开终端',
        destructive: true,
      })
      if (!ok) return
    }
    await act('mode', '切换模式失败', { mode: m })
  }

  const stop = async () => {
    if (await confirm({ title: '停止并清空队列？', description: '尚未写出的字会被丢弃，笔会抬起。会话保持打开。', confirmLabel: '停止', destructive: true })) await act('stop', '停止失败')
  }
  const changePaper = async () => {
    if (await confirm({ title: '现在换纸？', description: '写完已排队的字后笔回到原点，之后的输入会先缓存，换好纸点「已换纸」再继续。', confirmLabel: '换纸' })) await act('change_paper', '换纸失败')
  }
  const newSheet = () => runAction('继续失败', async () => applyTeletypeState(await teletypeApi.newpage()))

  const modeSeg =
    s.active && termAllowed ? (
      <Segmented<TeletypeMode>
        aria-label="模式"
        value={mode}
        onValueChange={setMode}
        block={compact}
        options={[
          { value: 'type', label: '打字模式', icon: Type },
          { value: 'term', label: '终端模式', icon: SquareTerminal },
        ]}
      />
    ) : null

  const actions = s.active ? (
    <>
      {!compact ? (
        <>
          <Button variant="gray" icon={s.paused ? <Play /> : <CirclePause />} disabled={!canControl} onClick={() => act(s.paused ? 'resume' : 'pause', '操作失败')}>
            {s.paused ? '继续' : '暂停'}
          </Button>
          <Button variant="gray" icon={<FilePlus2 />} disabled={!canControl || s.paper.need_paper} onClick={changePaper}>
            换纸
          </Button>
        </>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton label="更多操作">
            <MoreHorizontal />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {compact ? (
            <>
              <DropdownMenuItem icon={s.paused ? <Play /> : <CirclePause />} disabled={!canControl} onSelect={() => act(s.paused ? 'resume' : 'pause', '操作失败')}>
                {s.paused ? '继续书写' : '暂停书写'}
              </DropdownMenuItem>
              <DropdownMenuItem icon={<FilePlus2 />} disabled={!canControl || s.paper.need_paper} onSelect={changePaper}>
                换纸
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem icon={<House />} disabled={!canControl} onSelect={() => act('home', '回原点失败')}>
            抬笔回原点
          </DropdownMenuItem>
          {mode === 'term' ? (
            <DropdownMenuItem disabled={!canControl} onSelect={() => act('interrupt', '发送失败')}>
              发送 Ctrl-C
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={<Square />} destructive disabled={!canControl} onSelect={stop}>
            停止并清空队列
          </DropdownMenuItem>
          {compact ? (
            <DropdownMenuItem icon={<Power />} disabled={!canControl} onSelect={end}>
              结束会话
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {!compact ? (
        <Button variant="gray" icon={<Power />} disabled={!canControl} onClick={end}>
          结束会话
        </Button>
      ) : null}
    </>
  ) : ready ? (
    <Button variant="filled" icon={<Play />} loading={starting} disabled={startBlock != null} onClick={start}>
      开始
    </Button>
  ) : null

  return (
    <Page title="电传打字机" toolbar={!compact ? modeSeg : null} actions={actions}>
      <div className="flex flex-col gap-4">
        {s.availability === 'unavailable' ? (
          <Notice tone="orange" icon={<TriangleAlert />}>这台设备的服务端没有电传打字机功能。</Notice>
        ) : null}
        {ready && s.active && controlBlock ? <Notice>{controlBlock}</Notice> : null}
        {ready && !s.active && startBlock ? <Notice>{startBlock}</Notice> : null}
        {ready && s.active && notMine ? (
          <Notice>会话由 {s.owner?.display_name || s.owner?.username} 开启。</Notice>
        ) : null}
        {ready && s.active && !s.originOk ? (
          <Notice
            tone="red"
            icon={<TriangleAlert />}
            action={
              <Button size="sm" variant="filled" icon={<Crosshair />} disabled={controlBlock != null} onClick={() => act('set_origin', '设原点失败')}>
                设为原点
              </Button>
            }
          >
            原点已失效（急停或报警之后）。抬笔，把笔点动回本页的左上角，再设为原点继续。
          </Notice>
        ) : null}

        {ready && s.active ? <TeletypeStatus /> : null}

        {compact ? modeSeg : null}

        {s.availability === 'loading' ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-[60vh] rounded-lg" />
            <Skeleton className="h-64 rounded-lg" />
          </div>
        ) : s.availability === 'error' ? (
          <Card>
            <ErrorState error={s.error} onRetry={() => void loadTeletype()} />
          </Card>
        ) : s.availability === 'unavailable' ? null : (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,1.05fr)]">
            <Card className="p-3 lg:sticky lg:top-4">
              <PaperPreview
                canControl={canControl}
                onNewSheet={newSheet}
                sample={sample}
                className={compact ? 'h-[46dvh]' : 'h-[calc(100dvh-210px)] min-h-[420px]'}
              />
            </Card>
            <div className="flex min-w-0 flex-col gap-4">
              {!s.active ? (
                <Card>
                  <CardHeader title="开始会话" subtitle="会话期间写字机只听电传打字机的，任务要等会话结束" />
                  <div className="flex flex-col gap-4 px-4 pb-4">
                    <ol className="list-decimal space-y-1 pl-5 text-callout text-secondary-label">
                      <li>放好纸，用下面的「定位」把笔（抬起状态）停在要写内容的左上角。</li>
                      <li>选纸张和字高，点「开始」。</li>
                      <li>在「打字」框里打字，每个键立刻写到纸上。</li>
                    </ol>
                    {termAllowed ? (
                      <Segmented<TeletypeMode>
                        aria-label="开始模式"
                        value={startMode}
                        onValueChange={setStartMode}
                        options={[
                          { value: 'type', label: '打字模式', icon: Type },
                          { value: 'term', label: '终端模式', icon: SquareTerminal },
                        ]}
                      />
                    ) : null}
                    <SettingsForm disabled={startBlock != null || starting} form={form} onFormChange={setForm} />
                    <Button variant="filled" size="lg" icon={<Play />} loading={starting} disabled={startBlock != null} onClick={start}>
                      开始{startMode === 'term' ? '终端' : '打字'}
                    </Button>
                  </div>
                </Card>
              ) : mode === 'term' ? (
                <Card className="overflow-hidden">
                  <div className="flex items-start gap-2.5 bg-red/12 px-4 py-3 text-on-tint-red">
                    <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                    <p className="text-footnote">
                      <b className="font-semibold">这是设备上真正的 shell。</b>命令会直接执行，会话会抄写到纸上；全屏程序（vim、top、less）在纸上只记一行。
                    </p>
                  </div>
                  <div className="h-[380px] p-3">
                    <React.Suspense
                      fallback={
                        <div className="flex h-full items-center justify-center gap-2 rounded-lg bg-[#101215] text-footnote text-[#8a91a0]">
                          <Spinner size={14} /> 正在加载终端…
                        </div>
                      }
                    >
                      <TeletypeTerminal cols={s.paper.geo.cols} enabled={canControl} />
                    </React.Suspense>
                  </div>
                </Card>
              ) : (
                <Card>
                  <CardHeader title="打字" subtitle="每按一个键就立刻写到纸上" />
                  <div className="px-4 pb-4">
                    <TypePad enabled={canWrite} reason={writeBlock} cols={s.paper.geo.cols} cjk={!!s.font?.cjk} />
                  </div>
                </Card>
              )}
              <JogCard gate={gate} compact={compact} />
              {s.active ? (
                <Card>
                  <CardHeader title="书写设置" />
                  <div className="px-4 pb-4">
                    <SettingsForm disabled={!canControl} form={form} onFormChange={setForm} />
                  </div>
                </Card>
              ) : null}
              {s.log.length ? (
                <Card>
                  <CardHeader title="日志" />
                  <div className="max-h-36 overflow-y-auto px-4 pb-3 font-mono text-caption text-secondary-label" role="log" aria-label="电传打字机日志">
                    {s.log.slice(-60).map((l, i) => (
                      <div key={i} className="whitespace-pre-wrap">
                        <span className="text-tertiary-label">{formatTime(l.t)}</span> {l.msg}
                      </div>
                    ))}
                  </div>
                </Card>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </Page>
  )
}
