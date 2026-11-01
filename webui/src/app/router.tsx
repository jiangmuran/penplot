/**
 * Routes (02-ux §1). Feature screens are lazy chunks: src/features/<name>/index.tsx default export.
 * To add a route: add an entry below with `lazy: page(() => import('@/features/<name>/…'))`.
 */
import { Navigate, createBrowserRouter, type RouteObject } from 'react-router-dom'
import { AuthGate } from './auth-gate'
import { NotFoundPage } from './not-found'
import { PageError } from './page-error'
import { RouteError } from './route-error'

function Crash(): never {
  throw new Error('测试：页面渲染崩溃')
}

type PageModule = { default: React.ComponentType }
const page = (load: () => Promise<PageModule>) => async () => ({ Component: (await load()).default })

export const routes: RouteObject[] = [
  { path: '/login', lazy: page(() => import('./auth/login-page')), errorElement: <RouteError /> },
  { path: '/setup', lazy: page(() => import('./auth/setup-page')), errorElement: <RouteError /> },
  {
    path: '/',
    element: <AuthGate />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/studio" replace /> },
      { path: 'studio/:projectId?', lazy: page(() => import('@/features/studio')) },
      { path: 'projects', lazy: page(() => import('@/features/projects')) },
      { path: 'fonts', lazy: page(() => import('@/features/fonts')) },
      { path: 'teletype', lazy: page(() => import('@/features/teletype')) },
      { path: 'machine', lazy: page(() => import('@/features/machine')) },
      { path: 'jobs/:id?', lazy: page(() => import('@/features/jobs')) },
      { path: 'console', lazy: page(() => import('@/features/console')) },
      { path: 'settings', element: <Navigate to="/settings/general" replace /> },
      { path: 'settings/:section', lazy: page(() => import('@/features/settings')) },
      { path: 'system', lazy: page(() => import('@/features/system')) },
      { path: 'welcome', lazy: page(() => import('@/features/onboarding')) },
      { path: 'help/:article?', lazy: page(() => import('@/features/help')) },
      // legacy CLI-era paths
      { path: 'write', element: <Navigate to="/studio" replace /> },
      { path: 'image', element: <Navigate to="/studio" replace /> },
      // dev-only: verifies that a crashing page stays inside the shell (E-stop etc. remain)
      ...(import.meta.env.DEV ? [{ path: '__crash', Component: Crash }] : []),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]

// Every child route renders its errors *inside* the shell (PageError), so a crashing page never
// unmounts the sidebar, toolbar, mini-player or E-stop. Applied automatically to all children.
for (const r of routes) {
  if (r.path === '/' && r.children) {
    r.children = r.children.map((c) => (c.errorElement || c.index ? c : { ...c, errorElement: <PageError /> }))
  }
}

export const router = createBrowserRouter(routes)
