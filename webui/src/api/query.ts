/**
 * TanStack Query setup + query-key conventions.
 *
 * Keys are arrays starting with the REST resource (plural, as in the URL), then an id, then params:
 *   qk.fonts.list({ q })  → ['fonts', 'list', { q }]
 *   qk.fonts.detail(id)   → ['fonts', 'detail', id]
 * Invalidate a whole resource with `queryClient.invalidateQueries({ queryKey: qk.fonts.all })`.
 * Add new resources to `qk` (append-only in phase 2).
 *
 * Mutations: errors toast automatically (title = `meta.errorTitle` or '操作失败'). Opt out with
 * `meta: { silent: true }`. Queries never toast; render an inline error state instead.
 */
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { toast } from '@/lib/toast'
import { ApiError } from './client'
import { describeError } from './errors'
import { onLinkRestored } from './net'

declare module '@tanstack/react-query' {
  interface Register {
    defaultError: ApiError | Error
    mutationMeta: { errorTitle?: string; successTitle?: string; silent?: boolean }
  }
}

function resource(name: string) {
  return {
    all: [name] as const,
    list: (params?: object) => [name, 'list', params ?? {}] as const,
    detail: (id: string | number) => [name, 'detail', id] as const,
  }
}

export const qk = {
  auth: { state: ['auth', 'state'] as const, sessions: ['auth', 'sessions'] as const, tokens: ['auth', 'tokens'] as const },
  fonts: resource('fonts'),
  papers: resource('papers'),
  projects: resource('projects'),
  files: resource('files'),
  jobs: { ...resource('jobs'), current: ['jobs', 'current'] as const },
  render: resource('render'),
  tasks: resource('tasks'),
  machine: {
    all: ['machine'] as const,
    status: ['machine', 'status'] as const,
    ports: ['machine', 'ports'] as const,
    grblSettings: ['machine', 'grbl-settings'] as const,
  },
  profiles: resource('profiles'),
  settings: ['settings'] as const,
  system: {
    all: ['system'] as const,
    health: ['system', 'health'] as const,
    info: ['system', 'info'] as const,
    metrics: ['system', 'metrics'] as const,
    wifi: ['system', 'wifi'] as const,
    logs: (params?: object) => ['system', 'logs', params ?? {}] as const,
  },
}

export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache(),
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      const meta = mutation.meta
      if (meta?.silent) return
      if (error instanceof ApiError && (error.status === 401 || error.status === 423)) return
      if (error instanceof ApiError && error.isOffline) {
        // one merged notice per outage, not one error per request; the banner explains the rest
        toast.error(meta?.errorTitle ?? '连接中断，操作没有完成', { description: '与设备的网络暂时断开。恢复连接后请再试一次。', key: 'link-down' })
        return
      }
      const d = describeError(error)
      toast.error(meta?.errorTitle ?? d.title, {
        description: meta?.errorTitle ? (d.hint ? `${d.title}。${d.hint}` : d.title) : d.hint,
        key: meta?.errorTitle ?? d.code,
      })
    },
    onSuccess: (_d, _v, _c, mutation) => {
      if (mutation.meta?.successTitle) toast.success(mutation.meta.successTitle)
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      // link drops (WiFi, proxy 502/503/504) retry until the link is back, keeping the last data on screen
      retry: (count, err) => {
        if (err instanceof ApiError && err.isOffline) return true
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false
        return count < 2
      },
      retryDelay: (n, err) => (err instanceof ApiError && err.isOffline ? Math.min(1000 * 1.6 ** n, 8000) : Math.min(500 * 2 ** n, 5000)),
    },
    mutations: { retry: false },
  },
})

// when the link comes back, refresh whatever is on screen
onLinkRestored(() => {
  void queryClient.invalidateQueries({ refetchType: 'active' })
})
