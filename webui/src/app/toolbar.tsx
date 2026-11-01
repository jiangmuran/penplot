import { PanelLeft, PanelRight } from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import { isJobActive, useLive } from '@/api/store'
import { IconButton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatNumber } from '@/lib/format'
import { useBreakpoint } from '@/lib/media'
import { useChrome } from './chrome'

/** Stable callback refs for the toolbar slots (an inline ref would re-register every render). */
function useSlotRefs() {
  const setSlot = useChrome((c) => c.setSlot)
  const leading = React.useCallback((el: HTMLDivElement | null) => setSlot('leading', el), [setSlot])
  const trailing = React.useCallback((el: HTMLDivElement | null) => setSlot('trailing', el), [setSlot])
  return { leading, trailing }
}
import { ControlLeasePill } from './control-lease-pill'
import { EStopAnchor } from './estop'
import { MiniPlayerBody, useMiniPlayerJob, useMiniPlayerSuppressed } from './mini-player'
import { SafeBoundary } from './error-boundary'
import { NotificationCenter } from './notification-center'
import { MachineStatusPill } from './status-pill'
import { useUi } from './ui-store'

/**
 * Regular toolbar (52px, material): [sidebar] title | page controls | flex | status | page actions |
 * bell | [inspector] | E-stop.
 */
/** Title + subtitle in their own leaf: pages may pass a new subtitle node on every render. */
function ToolbarTitle() {
  const title = useChrome((c) => c.title)
  const subtitle = useChrome((c) => c.subtitle)
  return (
    <div className="flex min-w-0 shrink items-baseline gap-2 pl-1 pr-2">
      <h1 className="truncate text-headline text-label">{title}</h1>
      {subtitle ? <span className="truncate text-footnote text-secondary-label">{subtitle}</span> : null}
    </div>
  )
}

export function Toolbar({ sidebarVisible }: { sidebarVisible: boolean }) {
  const hasInspector = useChrome((c) => c.hasInspector)
  const slots = useSlotRefs()
  const bp = useBreakpoint()
  const toggleSidebar = useUi((s) => s.toggleSidebar)
  const inspectorOpen = useUi((s) => s.inspector[bp])
  const toggleInspector = useUi((s) => s.toggleInspector)
  return (
    <header className="mat-toolbar hairline-b relative z-30 flex h-[var(--toolbar-h)] shrink-0 items-center gap-2 pl-[max(8px,env(safe-area-inset-left))] pr-[max(8px,env(safe-area-inset-right))]">
      <IconButton label={sidebarVisible ? '隐藏侧边栏' : '显示侧边栏'} shortcut="mod+alt+s" onClick={() => toggleSidebar(bp)} active={false}>
        <PanelLeft />
      </IconButton>
      <ToolbarTitle />
      <div ref={slots.leading} className="flex min-w-0 items-center gap-2 empty:hidden" />
      <div className="min-w-2 flex-1" />
      <SafeBoundary name="lease-pill">
        <ControlLeasePill />
      </SafeBoundary>
      <SafeBoundary name="status-pill">
        <MachineStatusPill showProgressRing={!sidebarVisible} />
      </SafeBoundary>
      <div ref={slots.trailing} className="flex items-center gap-1 empty:hidden" />
      <div className="flex items-center gap-0.5">
        <NotificationCenter />
        {hasInspector ? (
          <IconButton label={inspectorOpen ? '隐藏检查器' : '显示检查器'} shortcut="mod+alt+i" onClick={() => toggleInspector(bp)} active={inspectorOpen}>
            <PanelRight />
          </IconButton>
        ) : null}
      </div>
      <EStopAnchor className="ml-1.5" />
    </header>
  )
}

/** Compact navigation bar (44px): title (fades in when the large title scrolls away) + actions. */
export function NavBar() {
  const chrome = useChrome(useShallow((c) => ({ title: c.title, largeTitleVisible: c.largeTitleVisible })))
  const slots = useSlotRefs()
  return (
    <header className={cn('mat-toolbar pt-safe relative z-30 shrink-0', !chrome.largeTitleVisible && 'hairline-b')}>
      <div className="flex h-[var(--navbar-h)] items-center gap-1 px-2">
        <div className="w-24 shrink-0" />
        <h1
          className={cn(
            'min-w-0 flex-1 truncate text-center text-headline text-label transition-opacity duration-[var(--dur-fast)]',
            chrome.largeTitleVisible ? 'opacity-0' : 'opacity-100',
          )}
          aria-hidden={chrome.largeTitleVisible}
        >
          {chrome.title}
        </h1>
        <div className="flex w-24 shrink-0 items-center justify-end gap-0.5">
          <div ref={slots.trailing} className="flex items-center gap-0.5 empty:hidden" />
          <NotificationCenter size="md" />
        </div>
      </div>
      <div ref={slots.leading} className="scrollbar-none flex items-center gap-2 overflow-x-auto px-4 pb-2 empty:hidden" />
    </header>
  )
}

/**
 * Compact machine bar (56px): job mini-player (pause/resume only — 停止 lives on the jobs page) or
 * status + DRO, then ≥16pt of space and the E-stop (05-review §0-7).
 */
export function MachineBar() {
  const { job, finished } = useMiniPlayerJob()
  const machine = useLive((s) => s.machine)
  const live = useLive((s) => s.job)
  const navigate = useNavigate()
  const suppressed = useMiniPlayerSuppressed()
  const showJob = !!job && !suppressed && (finished || isJobActive(live))
  return (
    <div className="mat-thick hairline-t flex h-[var(--machinebar-h)] shrink-0 items-center gap-2 pl-[max(12px,env(safe-area-inset-left))] pr-[max(8px,env(safe-area-inset-right))]">
      {showJob && job ? (
        <div role="button" tabIndex={0} className="min-w-0 flex-1" onClick={() => navigate('/jobs')} aria-label="打开任务">
          <MiniPlayerBody job={job} finished={finished} dense allowStop={false} />
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <MachineStatusPill align="start" />
          {machine?.wpos ? (
            <span className="truncate font-mono text-footnote text-secondary-label tabular-nums">
              X{formatNumber(machine.wpos[0], 1)} Y{formatNumber(machine.wpos[1], 1)}
            </span>
          ) : null}
        </div>
      )}
      <EStopAnchor className="ml-4" />
    </div>
  )
}
