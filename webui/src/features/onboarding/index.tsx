/**
 * 首次设置向导 /welcome (?step=connect to jump). Steps: 欢迎 → 连接写字机 → 认识你的笔 → 放纸与原点 → 试写 → 完成.
 * Every step is skippable; progress (current step, done/skipped, calibration values) is persisted
 * (see ./state.ts) so the wizard resumes where the user left off.
 */
import { Check, ChevronLeft, ChevronRight, RotateCcw, SkipForward } from 'lucide-react'
import * as React from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Page } from '@/app/page'
import { Button, IconButton, ProgressBar, Spinner } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { useMachineMode } from './machine'
import { STEPS, stepIndex, useOnboarding, type StepId } from './state'
import { ConnectStep, DoneStep, PaperStep, PenStep, TestStep, WelcomeStep } from './steps'

export default function WelcomePage() {
  const { s, update, load, loaded, reset } = useOnboarding()
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const compact = useIsCompact()
  const mode = useMachineMode()
  const [ready, setReady] = React.useState(true)
  const topRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  const urlStep = params.get('step') as StepId | null
  const step: StepId = urlStep && stepIndex(urlStep) >= 0 ? urlStep : s.step
  const idx = stepIndex(step)

  const go = React.useCallback(
    (id: StepId, extra?: Parameters<typeof update>[0]) => {
      update({ ...extra, step: id })
      setParams(id === 'welcome' ? {} : { step: id }, { replace: true })
      setReady(true)
      topRef.current?.scrollIntoView({ block: 'start' })
    },
    [update, setParams],
  )
  const next = () => {
    const n = STEPS[idx + 1]?.id
    const done = Array.from(new Set([...s.done, step]))
    if (n === 'done' || !n) go('done', { done, skipped: s.skipped.filter((x) => x !== step), completed: true })
    else go(n, { done, skipped: s.skipped.filter((x) => x !== step) })
  }
  const skip = () => {
    const n = STEPS[idx + 1]?.id ?? 'done'
    go(n, { skipped: Array.from(new Set([...s.skipped, step])).filter((x) => !s.done.includes(x)), ...(n === 'done' ? { completed: true } : {}) })
  }
  const restart = () => {
    reset()
    setParams({}, { replace: true })
  }
  const later = () => {
    update({ dismissed: true })
    navigate('/studio')
  }

  const body = (() => {
    const p = { mode, setReady }
    switch (step) {
      case 'welcome':
        return <WelcomeStep onStart={() => go('connect')} onLater={later} />
      case 'connect':
        return <ConnectStep {...p} />
      case 'pen':
        return <PenStep {...p} />
      case 'paper':
        return <PaperStep {...p} />
      case 'test':
        return <TestStep {...p} />
      default:
        return <DoneStep skipped={s.skipped.map((id) => STEPS[stepIndex(id)]?.title).filter(Boolean)} />
    }
  })()

  const showFooter = step !== 'welcome' && step !== 'done'
  return (
    <Page
      title="设置向导"
      subtitle={compact ? undefined : `${idx + 1} / ${STEPS.length} · ${STEPS[idx].title}`}
      actions={
        step !== 'welcome' ? (
          compact ? (
            <IconButton label="重新开始" onClick={restart}>
              <RotateCcw />
            </IconButton>
          ) : (
            <Button variant="plain" icon={<RotateCcw />} onClick={restart}>
              重新开始
            </Button>
          )
        ) : null
      }
      padded={false}
      largeTitle={false}
    >
      <div ref={topRef} className="flex flex-1">
        {!compact ? <StepRail current={step} done={s.done} skipped={s.skipped} onPick={(id) => go(id)} /> : null}
        <div className="flex min-w-0 flex-1 flex-col">
          {compact ? (
            <div className="px-4 pt-3">
              <ProgressBar value={((idx + 1) / STEPS.length) * 100} label={`第 ${idx + 1} 步，共 ${STEPS.length} 步：${STEPS[idx].title}`} />
              <p className="mt-1.5 text-footnote text-secondary-label">
                第 {idx + 1} / {STEPS.length} 步 · {STEPS[idx].title}
              </p>
            </div>
          ) : null}
          <div className={cn('mx-auto w-full max-w-[880px] flex-1', compact ? 'px-4 py-4' : 'px-8 py-8')}>
            {mode === 'checking' && step !== 'welcome' && step !== 'done' ? (
              <div className="flex justify-center py-16">
                <Spinner size={24} />
              </div>
            ) : (
              <div key={step} className="animate-fade-in">
                {body}
              </div>
            )}
          </div>
          {showFooter ? (
            <div className={cn('mat-toolbar hairline-t sticky bottom-0 z-10 flex items-center gap-2 pb-safe', compact ? 'px-4 py-2.5' : 'px-8 py-3')}>
              <Button variant="gray" icon={<ChevronLeft />} onClick={() => go(STEPS[Math.max(0, idx - 1)].id)}>
                上一步
              </Button>
              <div className="flex-1" />
              <Button variant="plain" icon={<SkipForward />} onClick={skip}>
                跳过{compact ? '' : '此步'}
              </Button>
              <Button variant="filled" disabled={!ready} onClick={next}>
                {idx === STEPS.length - 2 ? '完成' : '下一步'}
                <ChevronRight />
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </Page>
  )
}

function StepRail({ current, done, skipped, onPick }: { current: StepId; done: StepId[]; skipped: StepId[]; onPick: (id: StepId) => void }) {
  return (
    <nav aria-label="设置步骤" className="hairline-r hidden w-60 shrink-0 bg-bg-grouped px-3 py-6 md:block">
      <ol className="flex flex-col gap-0.5">
        {STEPS.map((st, i) => {
          const isDone = done.includes(st.id)
          const isSkipped = skipped.includes(st.id)
          const active = st.id === current
          return (
            <li key={st.id}>
              <button
                type="button"
                onClick={() => onPick(st.id)}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'focus-ring flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                  active ? 'bg-accent/12 bg-accent/15' : 'hover:bg-quaternary-fill',
                )}
              >
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full text-footnote font-semibold',
                    isDone ? 'bg-green text-white' : active ? 'bg-accent text-white' : 'bg-fill text-secondary-label',
                  )}
                >
                  {isDone ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className={cn('block text-body', active ? 'font-semibold text-label' : 'text-label')}>{st.title}</span>
                  <span className="block truncate text-footnote text-secondary-label">{isSkipped && !isDone ? '已跳过' : st.hint}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
