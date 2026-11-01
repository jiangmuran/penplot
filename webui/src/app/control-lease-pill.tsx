/**
 * Toolbar control-lease pill (pages-agent addition; one-line wiring in toolbar.tsx).
 * Lazy so the shell chunk doesn't pull in the machine feature; renders nothing until the backend
 * reports lease support.
 */
import * as React from 'react'

const Inner = React.lazy(() => import('@/features/machine/lease').then((m) => ({ default: m.ControlLeasePillInner })))

export function ControlLeasePill() {
  return (
    <React.Suspense fallback={null}>
      <Inner />
    </React.Suspense>
  )
}
