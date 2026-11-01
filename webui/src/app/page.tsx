import * as React from 'react'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { ToolbarPortal, useChrome } from './chrome'

export interface PageProps {
  /** Toolbar / navigation-bar title; also the document title. */
  title: string
  subtitle?: React.ReactNode
  /** Page-specific toolbar controls, after the title (segmented controls, filters…). */
  toolbar?: React.ReactNode
  /** Secondary icon buttons + the (single) primary action, before the status pill. */
  actions?: React.ReactNode
  /** Page has a right-side inspector; shows the panel-right toggle (state: useUi().inspector[bp]). */
  inspector?: boolean
  /** Content padding (regular 24 / compact 16) + max width. Set false for full-bleed (canvas). */
  padded?: boolean
  /** Max content width when padded, px (default none). */
  maxWidth?: number
  /** Show the iOS large title at the top of the content on compact (default true when padded). */
  largeTitle?: boolean
  className?: string
  children?: React.ReactNode
}

/**
 * Every routed screen renders inside <Page>:
 *
 *   export default function FontsPage() {
 *     return (
 *       <Page title="字库" toolbar={<SearchField …/>} actions={<Button variant="filled">导入</Button>}>
 *         …
 *       </Page>
 *     )
 *   }
 *
 * The shell owns the scroll container; <Page> fills it.
 */
export function Page({ title, subtitle, toolbar, actions, inspector = false, padded = true, maxWidth, largeTitle, className, children }: PageProps) {
  const set = useChrome((c) => c.set)
  const compact = useIsCompact()
  const showLarge = (largeTitle ?? padded) && compact
  const headRef = React.useRef<HTMLHeadingElement>(null)

  React.useEffect(() => {
    set({ title, subtitle, hasInspector: inspector }) // document.title is managed by the shell (attention.tsx)
  }, [title, subtitle, inspector, set])
  React.useEffect(() => () => set({ hasInspector: false, subtitle: undefined }), [set])

  React.useEffect(() => {
    if (!showLarge || !headRef.current) {
      set({ largeTitleVisible: false })
      return
    }
    const io = new IntersectionObserver(([e]) => set({ largeTitleVisible: e.isIntersecting }), { threshold: 0, rootMargin: '-44px 0px 0px 0px' })
    io.observe(headRef.current)
    return () => io.disconnect()
  }, [showLarge, set])

  return (
    <div className={cn('flex min-h-full flex-col', padded && 'px-4 pb-8 pt-4 md:px-6 md:pt-6', className)}>
      {toolbar ? <ToolbarPortal slot="leading">{toolbar}</ToolbarPortal> : null}
      {actions ? <ToolbarPortal slot="trailing">{actions}</ToolbarPortal> : null}
      <div className={cn('flex min-h-0 w-full flex-1 flex-col', maxWidth && 'mx-auto')} style={maxWidth ? { maxWidth } : undefined}>
        {showLarge ? (
          <h1 ref={headRef} className="mb-3 text-large-title text-label">
            {title}
          </h1>
        ) : null}
        {children}
      </div>
    </div>
  )
}
