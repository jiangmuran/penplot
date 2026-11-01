/** Auth queries/mutations (03 §4.1, §6). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, isApiError } from './client'
import { qk } from './query'
import type { AuthState, LoginResponse } from './types'
import { ws } from './ws'

export function fetchAuthState() {
  return api.get<AuthState>('/auth/state', { skipAuthHandling: true, timeoutMs: 8000 })
}

export function useAuthState() {
  return useQuery({
    queryKey: qk.auth.state,
    queryFn: fetchAuthState,
    staleTime: 60_000,
    // Backend unreachable → fail fast so the shell renders in its offline state.
    retry: (n, e) => !(isApiError(e) && (e.isOffline || e.status >= 500)) && n < 1,
    refetchOnWindowFocus: true,
  })
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { username?: string; password: string } | string) => {
      const body = typeof v === 'string' ? { password: v } : { password: v.password, username: v.username?.trim() || undefined }
      if (body.username) localStorage.setItem('penplot.lastUser', body.username)
      return api.post<LoginResponse>('/auth/login', body, { skipAuthHandling: true })
    },
    meta: { silent: true },
    onSuccess: async () => {
      await qc.invalidateQueries()
      ws.restart()
    },
  })
}

export function useSetup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { setup_code: string; password: string; username: string; display_name?: string }) =>
      api.post<{ ok: boolean }>('/auth/setup', v, { skipAuthHandling: true }),
    meta: { silent: true },
    onSuccess: async () => {
      await qc.invalidateQueries()
      ws.restart()
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post('/auth/logout', {}, { skipAuthHandling: true }),
    meta: { errorTitle: '退出登录失败' },
    onSettled: () => {
      ws.stop()
      qc.setQueryData<AuthState>(qk.auth.state, (s) => (s ? { ...s, authenticated: false } : s))
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
    },
  })
}
