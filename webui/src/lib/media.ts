import { useSyncExternalStore } from 'react'

/** Breakpoints from 02-ux §5.1. */
export type Breakpoint = 'compact' | 'medium' | 'regular' | 'wide'

function subscribeMq(query: string) {
  return (cb: () => void) => {
    const mq = window.matchMedia(query)
    mq.addEventListener('change', cb)
    return () => mq.removeEventListener('change', cb)
  }
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    subscribeMq(query),
    () => window.matchMedia(query).matches,
    () => false,
  )
}

function currentBreakpoint(): Breakpoint {
  const w = window.innerWidth
  if (w < 768) return 'compact'
  if (w < 1024) return 'medium'
  if (w < 1280) return 'regular'
  return 'wide'
}

function subscribeResize(cb: () => void) {
  window.addEventListener('resize', cb)
  return () => window.removeEventListener('resize', cb)
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribeResize, currentBreakpoint, () => 'wide' as Breakpoint)
}

export const useIsCompact = () => useBreakpoint() === 'compact'
export const useCoarsePointer = () => useMediaQuery('(pointer: coarse)')
export const useReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)')
