/**
 * Minimal fixed-row-height virtualiser shared by the pages (console log, system logs, glyph grid).
 *
 *   <VirtualList count={lines.length} rowHeight={20} className="h-96" renderRow={(i) => <Line l={lines[i]} />} />
 *   <VirtualGrid count={glyphs.length} minItemWidth={64} rowHeight={72} renderItem={(i) => …} onEndReached={loadMore} />
 *
 * The component owns its scroll container (give it a height). `follow` keeps it pinned to the bottom
 * while the user hasn't scrolled up; `onAtBottomChange` reports that state (for a "jump to latest" button).
 */
import * as React from 'react'
import { cn } from '@/lib/cn'

export interface VirtualListHandle {
  scrollToBottom: () => void
  scrollToIndex: (i: number) => void
  element: HTMLDivElement | null
}

interface BaseProps {
  count: number
  rowHeight: number
  overscan?: number
  className?: string
  innerClassName?: string
  /** Keep pinned to the bottom while at the bottom. */
  follow?: boolean
  onAtBottomChange?: (atBottom: boolean) => void
  /** Called when the last rows become visible (pagination). */
  onEndReached?: () => void
  role?: string
  'aria-label'?: string
  'aria-live'?: 'off' | 'polite'
  tabIndex?: number
  empty?: React.ReactNode
}

function useViewport(ref: React.RefObject<HTMLDivElement | null>) {
  const [vp, setVp] = React.useState({ top: 0, height: 0, width: 0 })
  const sync = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    setVp((v) => (v.top === el.scrollTop && v.height === el.clientHeight && v.width === el.clientWidth ? v : { top: el.scrollTop, height: el.clientHeight, width: el.clientWidth }))
  }, [ref])
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = sync
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    el.addEventListener('scroll', update, { passive: true })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', update)
    }
  }, [ref, sync])
  return { vp, sync }
}

function useVirtualRows(
  ref: React.RefObject<HTMLDivElement | null>,
  rows: number,
  { rowHeight, overscan = 8, follow, onAtBottomChange, onEndReached }: Pick<BaseProps, 'rowHeight' | 'overscan' | 'follow' | 'onAtBottomChange' | 'onEndReached'>,
) {
  const { vp, sync } = useViewport(ref)
  // "Stuck to bottom" is decided by scroll events only (user or programmatic), so content growth and
  // container resizes keep the list pinned while following.
  const stuckRef = React.useRef(true)
  const [stuck, setStuck] = React.useState(true)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      const s = el.scrollTop + el.clientHeight >= el.scrollHeight - rowHeight * 1.5
      if (s !== stuckRef.current) {
        stuckRef.current = s
        setStuck(s)
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref, rowHeight])
  const total = rows * rowHeight
  const atBottom = total <= vp.height || (follow ? stuck : vp.top + vp.height >= total - rowHeight * 1.5)
  const cbRef = React.useRef(onAtBottomChange)
  cbRef.current = onAtBottomChange
  React.useEffect(() => {
    cbRef.current?.(atBottom)
  }, [atBottom])

  // Pin to bottom when rows arrive or the viewport resizes.
  React.useLayoutEffect(() => {
    const el = ref.current
    if (follow && el && stuckRef.current) {
      el.scrollTop = el.scrollHeight
      sync()
    }
  }, [rows, follow, ref, vp.height, sync])

  const first = Math.max(0, Math.floor(vp.top / rowHeight) - overscan)
  const last = Math.min(rows, Math.ceil((vp.top + (vp.height || 800)) / rowHeight) + overscan)

  const endRef = React.useRef(onEndReached)
  endRef.current = onEndReached
  React.useEffect(() => {
    if (rows > 0 && last >= rows - 2) endRef.current?.()
  }, [last, rows])

  return { first, last, total, width: vp.width }
}

function useHandle(ref: React.RefObject<HTMLDivElement | null>, rowHeight: number, handle?: React.Ref<VirtualListHandle>) {
  React.useImperativeHandle(
    handle,
    () => ({
      scrollToBottom: () => {
        const el = ref.current
        if (el) el.scrollTop = el.scrollHeight
      },
      scrollToIndex: (i: number) => {
        const el = ref.current
        if (el) el.scrollTop = Math.max(0, i * rowHeight - el.clientHeight / 2)
      },
      get element() {
        return ref.current
      },
    }),
    [ref, rowHeight],
  )
}

export const VirtualList = React.forwardRef<VirtualListHandle, BaseProps & { renderRow: (index: number) => React.ReactNode }>(function VirtualList(
  { count, rowHeight, overscan, className, innerClassName, follow, onAtBottomChange, onEndReached, renderRow, empty, ...aria },
  handle,
) {
  const ref = React.useRef<HTMLDivElement>(null)
  useHandle(ref, rowHeight, handle)
  const { first, last, total } = useVirtualRows(ref, count, { rowHeight, overscan, follow, onAtBottomChange, onEndReached })
  const items: React.ReactNode[] = []
  for (let i = first; i < last; i++) {
    items.push(
      <div key={i} style={{ position: 'absolute', top: i * rowHeight, left: 0, right: 0, height: rowHeight }}>
        {renderRow(i)}
      </div>,
    )
  }
  return (
    <div ref={ref} className={cn('relative overflow-y-auto overscroll-contain', className)} {...aria}>
      {count === 0 && empty ? empty : <div className={cn('relative w-full', innerClassName)} style={{ height: total }}>{items}</div>}
    </div>
  )
})

export const VirtualGrid = React.forwardRef<
  VirtualListHandle,
  BaseProps & { minItemWidth: number; gap?: number; renderItem: (index: number) => React.ReactNode }
>(function VirtualGrid({ count, rowHeight, minItemWidth, gap = 8, overscan = 4, className, innerClassName, onEndReached, renderItem, empty, follow, onAtBottomChange, ...aria }, handle) {
  const ref = React.useRef<HTMLDivElement>(null)
  useHandle(ref, rowHeight + gap, handle)
  const [width, setWidth] = React.useState(0)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const cols = Math.max(1, Math.floor((width + gap) / (minItemWidth + gap)))
  const rows = Math.ceil(count / cols)
  const pitch = rowHeight + gap
  const { first, last, total } = useVirtualRows(ref, rows, { rowHeight: pitch, overscan, follow, onAtBottomChange, onEndReached })
  const itemW = cols > 0 ? (width - gap * (cols - 1)) / cols : minItemWidth
  const items: React.ReactNode[] = []
  for (let r = first; r < last; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      if (i >= count) break
      items.push(
        <div key={i} style={{ position: 'absolute', top: r * pitch, left: c * (itemW + gap), width: itemW, height: rowHeight }}>
          {renderItem(i)}
        </div>,
      )
    }
  }
  return (
    <div ref={ref} className={cn('relative overflow-y-auto overscroll-contain', className)} {...aria}>
      {count === 0 && empty ? empty : <div className={cn('relative w-full', innerClassName)} style={{ height: Math.max(0, total - gap) }}>{items}</div>}
    </div>
  )
})
