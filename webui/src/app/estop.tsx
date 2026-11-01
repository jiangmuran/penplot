/**
 * E-stop (02-ux §2.4). The visible button lives in its own top-layer portal (z above every
 * Sheet/Dialog/overlay) and is positioned over an <EStopAnchor/> placeholder that reserves its
 * space in the toolbar (regular) or machine bar (compact). Single tap → immediate, no confirm.
 */
import { OctagonX, X } from 'lucide-react'
import * as React from 'react'
import { createPortal } from 'react-dom'
import { estop, penUp, runAction, unlockMachine } from '@/api/machine'
import { useLive } from '@/api/store'
import { Button, Spinner } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { useOverlays } from '@/lib/overlays'
import { useChrome } from './chrome'

/** Placeholder that reserves the E-stop's slot. */
export function EStopAnchor({ className }: { className?: string }) {
  const setEstopAnchor = useChrome((c) => c.setEstopAnchor)
  const compact = useIsCompact()
  return (
    <div
      ref={setEstopAnchor}
      aria-hidden
      className={cn('shrink-0', compact ? 'size-12' : 'h-11 w-[88px] pointer-coarse:w-[96px]', className)}
    />
  )
}

function useAnchorRect(el: HTMLElement | null) {
  const [rect, setRect] = React.useState<DOMRect | null>(null)
  React.useLayoutEffect(() => {
    if (!el) {
      setRect(null)
      return
    }
    let raf = 0
    const update = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        setRect((prev) => (prev && prev.x === r.x && prev.y === r.y && prev.width === r.width && prev.height === r.height ? prev : r))
      })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    ro.observe(document.body)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    document.addEventListener('transitionend', update, true)
    // Layout can also shift without resize events (fonts, panels); poll cheaply.
    const iv = setInterval(update, 500)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
      document.removeEventListener('transitionend', update, true)
      clearInterval(iv)
    }
  }, [el])
  return rect
}

/** The floating E-stop button + post-stop card. Mounted once by the shell. */
export function EStopLayer() {
  const estopAnchor = useChrome((c) => c.estopAnchor)
  const rect = useAnchorRect(estopAnchor)
  const compact = useIsCompact()
  const conn = useLive((s) => s.conn)
  const machineConnected = useLive((s) => s.machine?.connected ?? null)
  const state = useLive((s) => s.estop)
  // Never disabled, for any role (04 §14): when the machine looks disconnected it is merely muted
  // visually; pressing it still sends (the server may know better than our last status).
  const muted = conn === 'open' && machineConnected === false
  const sending = state?.phase === 'sending'
  const bottomSheetOpen = useOverlays((s) => s.bottomSheets > 0)
  const layerRef = React.useRef<HTMLDivElement>(null)

  // Radix dialogs call hideOthers(), which sets aria-hidden (and `inert` in newer versions) on
  // every sibling of the dialog portal, including this layer. The E-stop must stay reachable for
  // screen readers and keyboard users whatever is open, so undo that as soon as it happens.
  React.useEffect(() => {
    const el = layerRef.current
    if (!el) return
    const unhide = () => {
      if (el.getAttribute('aria-hidden') != null) el.removeAttribute('aria-hidden')
      if (el.hasAttribute('inert')) el.removeAttribute('inert')
      if (el.hasAttribute('data-aria-hidden')) el.removeAttribute('data-aria-hidden')
    }
    unhide()
    const mo = new MutationObserver(unhide)
    mo.observe(el, { attributes: true, attributeFilter: ['aria-hidden', 'inert', 'data-aria-hidden'] })
    return () => mo.disconnect()
  }, [])

  // Where to draw it: over its anchor; on compact while a bottom sheet is open, in the top-right
  // corner (over the dimmed backdrop, never over sheet content); with no anchor (e.g. the toolbar
  // crashed), at a fixed default corner so it is *always* reachable.
  const style: React.CSSProperties =
    compact && bottomSheetOpen
      ? { position: 'fixed', top: 'calc(env(safe-area-inset-top) + 8px)', right: 'calc(env(safe-area-inset-right) + 8px)', width: 48, height: 48 }
      : rect && rect.width > 0
        ? { position: 'fixed', left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        : compact
          ? { position: 'fixed', right: 8, bottom: 'calc(var(--tabbar-h) + 4px + env(safe-area-inset-bottom))', width: 48, height: 48 }
          : { position: 'fixed', right: 8, top: 4, width: 88, height: 44 }

  const button = (
      <button
        id="estop-button"
        type="button"
        onClick={() => void estop()}
        data-muted={muted || undefined}
        aria-label="急停"
        aria-keyshortcuts="Meta+Period Control+Period"
        title="急停（⌘/Ctrl + .）"
        style={style}
        className={cn(
          'pointer-events-auto z-[100] inline-flex select-none items-center justify-center gap-1.5 rounded-lg bg-red font-semibold text-white',
          'shadow-[0_1px_2px_rgb(0_0_0/0.2),inset_0_0_0_0.5px_rgb(0_0_0/0.15)] transition-[transform,filter] duration-[var(--dur-instant)]',
          'hover:brightness-110 active:scale-[var(--press-scale)] active:brightness-90',
          'focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-red/60',
          'data-[muted]:opacity-70',
          compact ? 'flex-col gap-0.5 text-[12px] leading-none' : 'text-body',
        )}
      >
        {sending ? <Spinner size={compact ? 20 : 18} label="急停发送中" /> : <OctagonX className={compact ? 'size-5' : 'size-[18px]'} strokeWidth={2.25} aria-hidden />}
        <span>急停</span>
      </button>
  )

  return createPortal(
    <div ref={layerRef} style={{ pointerEvents: 'auto' }} data-estop-layer>
      {button}
      <EStopCard />
    </div>,
    document.body,
  )
}

/** Minimal E-stop used if the regular layer ever crashes (error boundary fallback). */
export function EStopFallback() {
  return createPortal(
    <button
      type="button"
      aria-label="急停"
      onClick={() => void estop()}
      style={{ position: 'fixed', right: 8, bottom: 72, zIndex: 100, pointerEvents: 'auto' }}
      className="flex h-12 items-center gap-1.5 rounded-lg bg-red px-4 font-semibold text-white shadow-lg"
    >
      <OctagonX className="size-5" /> 急停
    </button>,
    document.body,
  )
}

/** Non-modal card after an E-stop: 「已急停，机器需复位」[解锁并抬笔]. */
function EStopCard() {
  const state = useLive((s) => s.estop)
  const setEstop = useLive((s) => s.setEstop)
  const originValid = useLive((s) => s.machine?.origin_valid ?? true)
  const retryFrom = useLive((s) => (s.finished?.job.reason === 'estop' ? s.finished.job.can_retry_from : null) ?? s.job?.can_retry_from ?? null)
  const compact = useIsCompact()
  const [busy, setBusy] = React.useState(false)
  if (!state || state.phase === 'sending') return null
  const failed = state.phase === 'failed'
  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-labelledby="estop-card-title"
      className={cn(
        'mat-thick fixed z-[95] flex w-[min(380px,calc(100vw-16px))] items-start gap-3 rounded-xl p-3.5 shadow-lg animate-toast-in',
        compact ? 'left-1/2 top-[calc(env(safe-area-inset-top)+8px)] -translate-x-1/2' : 'right-3 top-[calc(var(--toolbar-h)+8px)]',
      )}
    >
      <OctagonX className={cn('mt-0.5 size-6 shrink-0', failed ? 'text-orange' : 'text-red')} strokeWidth={2} />
      <div className="min-w-0 flex-1">
        <h2 id="estop-card-title" className="text-headline">
          {failed ? '急停请求未送达' : '已急停，机器需复位'}
        </h2>
        <p className="mt-0.5 text-callout text-secondary-label">
          {failed
            ? `${state.error ?? '无法连接设备'}。请立即切断机器电源或按下物理急停。`
            : originValid
              ? `队列已清空，坐标仍然有效${retryFrom ? `，可在任务页从第 ${retryFrom} 行续写` : ''}。解锁后可继续操作。`
              : '坐标已丢失，笔的状态未知：请先点动 Z 抬笔，再把笔移到要写内容的左上角重新设原点。'}
        </p>
        <div className="mt-3 flex gap-2">
          {failed ? (
            <Button variant="destructive" size="md" onClick={() => void estop()}>
              再次急停
            </Button>
          ) : (
            <Button
              variant="filled"
              size="md"
              loading={busy}
              onClick={async () => {
                setBusy(true)
                const ok = await runAction('解锁失败', async () => {
                  await unlockMachine()
                  if (originValid) await penUp()
                })
                setBusy(false)
                if (ok) setEstop(null)
              }}
            >
              {originValid ? '解锁并抬笔' : '解锁'}
            </Button>
          )}
          <Button variant="gray" size="md" onClick={() => setEstop(null)}>
            关闭
          </Button>
        </div>
      </div>
      <button type="button" aria-label="关闭" onClick={() => setEstop(null)} className="focus-ring -mr-1 -mt-1 flex size-7 items-center justify-center rounded-full text-tertiary-label hover:bg-quaternary-fill">
        <X className="size-4" />
      </button>
    </div>
  )
}
