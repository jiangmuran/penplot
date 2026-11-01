import { CirclePause, Gamepad2, PlugZap, SlidersHorizontal, Wand2 } from 'lucide-react'
import * as React from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { connectMachine } from '@/api/machine'
import { profileNumbers, setPen, useActiveProfile } from '@/api/machine-control'
import { useLive } from '@/api/store'
import { STRAY_HOLD_TEXT, useClearHold, useStrayHold } from '@/app/banners'
import { Page } from '@/app/page'
import { Button, Card, ErrorState, Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { useShortcut } from '@/lib/shortcuts'
import { ConnectionCard } from './connection-card'
import { DroCard, homeWithConfirm } from './dro-card'
import { runAction } from './errors'
import { useMachineGate } from './gate'
import { JogPad } from './jog-pad'
import { LeaseStrip } from './lease'
import { MacrosCard, OverridesCard } from './overrides-card'
import { SetupWizard } from './setup-wizard'
import { TravelMapCard } from './travel-map'
import { ZCalibrationCard } from './z-calibration'

export default function MachinePage() {
  const compact = useIsCompact()
  const gate = useMachineGate()
  // narrow selectors: the whole page must not re-render on every 4 Hz status frame
  const connected = useLive((s) => !!s.machine?.connected)
  const machineConnecting = useLive((s) => !!s.machine?.connecting)
  const strayHold = useStrayHold()
  const hold = useClearHold()
  const { profile, isLoading, error, refetch } = useActiveProfile()
  const n = profileNumbers(profile)
  const [busy, setBusy] = React.useState(false)
  const [params, setParams] = useSearchParams()
  const wizardOpen = params.get('wizard') === '1'
  const setWizard = (o: boolean) =>
    setParams(
      (p) => {
        if (o) p.set('wizard', '1')
        else p.delete('wizard')
        return p
      },
      { replace: true },
    )

  useShortcut('u', () => (gate.canMove ? void runAction('抬笔失败', () => setPen('up')) : false), { description: '抬笔', group: '控制 · 点动' })
  useShortcut('d', () => (gate.canMove ? void runAction('落笔失败', () => setPen('down')) : false), { description: '落笔', group: '控制 · 点动' })

  const connect = async () => {
    setBusy(true)
    await runAction('连接失败', () => connectMachine())
    setBusy(false)
  }

  const dim = !gate.connected && 'opacity-40 pointer-events-none select-none'
  // While a job is writing, the jog pad collapses into one explanatory line (review §2.2).
  const jogCollapsed = gate.connected && gate.jobActive && !gate.canMove

  const jog = isLoading ? (
    <Skeleton className="h-80 rounded-lg" />
  ) : jogCollapsed ? (
    <Card className="flex items-center gap-3 px-4 py-3.5">
      <Gamepad2 className="size-5 shrink-0 text-secondary-label" aria-hidden />
      <p className="text-subheadline text-secondary-label">点动：任务进行中，暂停后可点动。</p>
    </Card>
  ) : (
    <JogPad
      feed={n.jogSpeed}
      zFeed={Math.min(n.zSpeed, n.jogSpeed)}
      zStep={n.zJogStep}
      enabled={gate.canMove}
      reason={gate.reason}
      onHome={homeWithConfirm}
      compact={compact}
    />
  )
  const overrides = gate.jobActive ? <OverridesCard gate={gate} /> : null
  // no travel configured (no homing: the machine powers on anywhere) → no travel map
  const map = n.workW > 0 && n.workH > 0 ? <TravelMapCard gate={gate} workW={n.workW} workH={n.workH} corner={n.corner} feed={n.jogSpeed} /> : null
  const zcal = <ZCalibrationCard profile={profile} gate={gate} zOn={n.zOn} zOff={n.zOff} zFeed={n.zSpeed} />
  const macros = <MacrosCard macros={n.macros} gate={gate} />

  return (
    <Page
      title="控制"
      toolbar={
        profile ? (
          <Button asChild size="sm" variant="plain" className="text-secondary-label max-md:hidden">
            <Link to="/settings/machine" title="机器配置">
              <SlidersHorizontal />
              {profile.name}
            </Link>
          </Button>
        ) : null
      }
      actions={
        <>
          <Button variant="gray" icon={<Wand2 />} onClick={() => setWizard(true)} className="max-md:hidden">
            上机向导
          </Button>
          {!connected ? (
            <Button variant="filled" size={compact ? 'sm' : 'md'} icon={<PlugZap />} loading={busy || machineConnecting} disabled={!gate.online || gate.leaseBlocked} onClick={connect}>
              连接
            </Button>
          ) : null}
        </>
      }
    >
      {error && !profile ? (
        <ErrorState title="读不到机器配置" error={error} onRetry={() => refetch()} />
      ) : (
        <>
          <LeaseStrip className="mb-4" />
          {strayHold ? (
            <Card className="mb-4 flex items-center gap-3 px-4 py-3.5">
              <CirclePause className="size-5 shrink-0 text-orange" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-headline">机器暂停</p>
                <p className="text-subheadline text-secondary-label">{STRAY_HOLD_TEXT}。解除后缓冲中的移动会被丢弃，位置保留。</p>
              </div>
              <Button variant="filled" loading={hold.busy} onClick={hold.run}>
                解除暂停
              </Button>
            </Card>
          ) : null}
          {compact ? (
            <div className="flex flex-col gap-4">
              {!gate.connected ? <ConnectionCard profile={profile} /> : null}
              <div className={cn('flex flex-col gap-4', dim)} aria-disabled={!gate.connected || undefined}>
                <DroCard gate={gate} compact />
                {jog}
                {overrides}
              </div>
              {gate.connected ? <ConnectionCard profile={profile} /> : null}
              <div className={cn('flex flex-col gap-4', dim)}>
                {zcal}
                {macros}
                {map}
              </div>
              <Button variant="gray" size="lg" icon={<Wand2 />} onClick={() => setWizard(true)}>
                上机向导
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)]">
              <div className="flex min-w-0 flex-col gap-4 max-lg:order-2">
                {!gate.connected ? <ConnectionCard profile={profile} /> : null}
                <div className={cn(dim)}>{map}</div>
                <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
                  {gate.connected ? <ConnectionCard profile={profile} /> : null}
                  <div className={cn('flex flex-col gap-4', dim)}>
                    {zcal}
                    {macros}
                  </div>
                </div>
              </div>
              <div className={cn('flex flex-col gap-4 max-lg:order-1', dim)} aria-disabled={!gate.connected || undefined}>
                <DroCard gate={gate} />
                {jog}
                {overrides}
              </div>
            </div>
          )}
        </>
      )}
      <SetupWizard open={wizardOpen} onOpenChange={setWizard} profile={profile} />
    </Page>
  )
}
