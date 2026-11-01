/**
 * First-run hook-up for the shell (not mounted by this feature — the shell owner adds one line):
 *
 *   import { FirstRunRedirect } from '@/features/onboarding/first-run'
 *   …inside AppShell (under the router, after auth): <FirstRunRedirect />
 *
 * After login it opens /welcome once per browser session until the wizard is completed or the user
 * chose「以后再说」. It never redirects away from a deep link other than the app root / studio.
 */
import * as React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useOnboarding } from './state'

const SESSION_KEY = 'penplot.onboarding.shown'

export function useOnboardingStatus() {
  const s = useOnboarding((st) => st.s)
  const loaded = useOnboarding((st) => st.loaded)
  return { loaded, completed: s.completed, dismissed: s.dismissed, step: s.step, needsSetup: !s.completed && !s.dismissed }
}

export function FirstRunRedirect() {
  const load = useOnboarding((s) => s.load)
  const { loaded, needsSetup } = useOnboardingStatus()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  React.useEffect(() => {
    void load()
  }, [load])
  React.useEffect(() => {
    if (!loaded || !needsSetup) return
    if (sessionStorage.getItem(SESSION_KEY)) return
    if (!(pathname === '/' || pathname.startsWith('/studio'))) return
    sessionStorage.setItem(SESSION_KEY, '1')
    navigate('/welcome', { replace: true })
  }, [loaded, needsSetup, pathname, navigate])
  return null
}

export default FirstRunRedirect
