import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as React from 'react'
import { Outlet, useLocation, useNavigation } from 'react-router-dom'
import { setAuthHandlers } from '@/api/client'
import { ws } from '@/api/ws'
import { cn } from '@/lib/cn'
import { useBreakpoint } from '@/lib/media'
import { AttentionBanner, AttentionEffects } from './attention'
import { AlarmBanner, ConnectionBanner, HoldBanner } from './banners'
import { ChromeProvider } from './chrome'
import { DropOverlay } from './drop-overlay'
import { EStopFallback, EStopLayer } from './estop'
import { SafeBoundary } from './error-boundary'
import { PageError } from './page-error'
import { GlobalShortcuts } from './global-shortcuts'
import { LiveEffects } from './live-effects'
import { MoreSheet } from './more-sheet'
import { SessionExpiredDialog } from './session-expired'
import { ShortcutsSheet } from './shortcuts-sheet'
import { Sidebar } from './sidebar'
import { TabBar } from './tab-bar'
import { MachineBar, NavBar, Toolbar } from './toolbar'
import { useUi } from './ui-store'
import { FirstRunRedirect } from '@/features/onboarding/first-run'

/** The application frame (02-ux §2): sidebar/tab bar, toolbar, banners, content, global layers. */
export function AppShell() {
  return (
    <ChromeProvider>
      <ShellLayout />
    </ChromeProvider>
  )
}

function ShellLayout() {
  const bp = useBreakpoint()
  const compact = bp === 'compact'
  const wide = bp === 'wide'
  const wideSidebar = useUi((s) => s.sidebar.wide)
  const overlay = useUi((s) => s.overlaySidebar)
  const setSidebar = useUi((s) => s.setSidebar)
  const setUi = useUi((s) => s.set)
  const { pathname } = useLocation()
  const sidebarVisible = wide ? wideSidebar : overlay

  // Start live updates for the lifetime of the shell.
  React.useEffect(() => {
    ws.start()
    return () => ws.stop()
  }, [])

  // In-app 401 → re-login sheet instead of losing the page state (02-ux §3.12).
  React.useEffect(() => {
    setAuthHandlers({ onUnauthorized: () => setUi({ sessionExpired: true }) })
    return () =>
      setAuthHandlers({
        onUnauthorized: () => {
          if (!location.pathname.startsWith('/login')) location.assign(`/login?next=${encodeURIComponent(location.pathname)}`)
        },
      })
  }, [setUi])

  // Close the overlay sidebar on navigation.
  React.useEffect(() => {
    setUi({ overlaySidebar: false, moreSheet: false })
  }, [pathname, setUi])

  return (
    <div className="flex h-dvh overflow-hidden bg-bg-grouped text-label">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[110] focus:rounded-md focus:bg-bg-elevated focus:px-3 focus:py-2 focus:shadow-md">
        跳到主内容
      </a>
      <a
        href="#estop-button"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById('estop-button')?.focus()
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-32 focus:top-2 focus:z-[110] focus:rounded-md focus:bg-red focus:px-3 focus:py-2 focus:text-white focus:shadow-md">
        跳到急停（⌘/Ctrl + .）
      </a>
      {wide ? (
        <div
          className={cn('relative z-40 shrink-0 overflow-hidden transition-[width] duration-[var(--dur-slow)] ease-spring', wideSidebar ? 'w-[var(--sidebar-w)]' : 'w-0')}
          aria-hidden={!wideSidebar}
          inert={!wideSidebar}
        >
          <SafeBoundary name="sidebar">
            <Sidebar className="absolute inset-y-0 left-0" />
          </SafeBoundary>
        </div>
      ) : !compact ? (
        <DialogPrimitive.Root open={overlay} onOpenChange={(o) => setSidebar(bp, o)}>
          <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/10 data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out" />
            <DialogPrimitive.Content
              aria-describedby={undefined}
              className="fixed inset-y-2 left-2 z-40 overflow-hidden rounded-xl shadow-lg outline-none data-[state=open]:animate-sheet-in-left data-[state=closed]:animate-sheet-out-left"
            >
              <DialogPrimitive.Title className="sr-only">导航</DialogPrimitive.Title>
              <Sidebar className="bg-bg-secondary/90" onNavigate={() => setSidebar(bp, false)} />
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <SafeBoundary name="toolbar">{compact ? <NavBar /> : <Toolbar sidebarVisible={sidebarVisible} />}</SafeBoundary>
        <SafeBoundary name="banners">
          <ConnectionBanner />
          <AlarmBanner />
          <HoldBanner />
          <AttentionBanner />
        </SafeBoundary>
        <div className="relative min-h-0 flex-1">
          <RouteProgress />
          <main id="main" tabIndex={-1} className="absolute inset-0 overflow-y-auto overscroll-contain outline-none">
            <SafeBoundary name="page" resetKey={pathname} fallback={(err, reset) => <PageError error={err} onReset={reset} />}>
              <React.Suspense fallback={null}>
                <Outlet />
              </React.Suspense>
            </SafeBoundary>
          </main>
        </div>
        {compact ? (
          <SafeBoundary name="machine-bar">
            <MachineBar />
          </SafeBoundary>
        ) : null}
        {compact ? (
          <SafeBoundary name="tab-bar">
            <TabBar />
          </SafeBoundary>
        ) : null}
      </div>

      <SafeBoundary name="estop" fallback={<EStopFallback />}>
        <EStopLayer />
      </SafeBoundary>
      <SafeBoundary name="overlays">
        <DropOverlay />
        <MoreSheet />
        <ShortcutsSheet />
        <SessionExpiredDialog />
      </SafeBoundary>
      <SafeBoundary name="effects">
        <GlobalShortcuts />
        <LiveEffects />
        <AttentionEffects />
        <FirstRunRedirect />
      </SafeBoundary>
    </div>
  )
}

/** 2px accent bar while a lazy route chunk / loader is pending. */
function RouteProgress() {
  const nav = useNavigation()
  const [show, setShow] = React.useState(false)
  React.useEffect(() => {
    if (nav.state === 'idle') return setShow(false)
    const t = setTimeout(() => setShow(true), 150)
    return () => clearTimeout(t)
  }, [nav.state])
  if (!show) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden" role="progressbar" aria-label="页面加载中">
      <div className="h-full w-1/3 bg-accent motion-safe:animate-[route-progress_1s_var(--ease-standard)_infinite]" />
      <style>{`@keyframes route-progress{from{transform:translateX(-100%)}to{transform:translateX(300%)}}`}</style>
    </div>
  )
}
