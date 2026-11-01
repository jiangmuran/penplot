import * as React from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuthState } from '@/api/auth'
import { Delayed, Spinner } from '@/components/ui'
import { AppShell } from './app-shell'

/**
 * Guards app routes: setup_required → /setup, unauthenticated → /login?next=…
 * If the backend is unreachable we still render the shell (disconnected state) instead of a dead end.
 */
export function AuthGate() {
  const { data, isPending } = useAuthState()
  const loc = useLocation()
  // A refetch of a query without data flips it back to `pending` (TanStack v5). Only block on the
  // very first resolution, otherwise every refetch while offline would unmount the whole shell.
  const [settledOnce, setSettledOnce] = React.useState(false)
  React.useEffect(() => {
    if (!isPending) setSettledOnce(true)
  }, [isPending])
  if (isPending && !settledOnce) {
    return (
      <div className="flex h-dvh items-center justify-center bg-bg-grouped text-secondary-label">
        <Delayed>
          <Spinner size={24} />
        </Delayed>
      </div>
    )
  }
  if (data?.setup_required) return <Navigate to="/setup" replace />
  if (data && !data.authenticated) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />
  return <AppShell />
}
