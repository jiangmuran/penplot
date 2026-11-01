/**
 * Profiles, papers, app settings, account (sessions/tokens) hooks — pages-agent addition.
 * Endpoints: 03 §4.1, §4.3 (papers), §4.8; shapes: 04 §7, §10.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from './client'
import { queryClient, qk } from './query'
import type { components } from './schema'

type S = components['schemas']
export type Profile = S['Profile']
export type ProfileDoc = S['ProfileDoc']
export type ProfileCreate = S['ProfileCreate']
export type PaperSpec = S['PaperSpec']
export type PaperBase = S['PaperBase']
export type AppSettings = S['AppSettings']
export type SessionInfo = S['SessionInfo']
export type TokenInfo = S['TokenInfo']
export type TokenCreate = S['TokenCreate']
export type TokenCreated = S['TokenCreated']
export type PortInfo = S['PortInfo']
export type FontSummary = S['FontSummary']

// ---------------- profiles ----------------
export const useProfiles = () =>
  useQuery({ queryKey: qk.profiles.list(), queryFn: () => api.get<Profile[]>('/profiles') })

const invalidateProfiles = () => queryClient.invalidateQueries({ queryKey: qk.profiles.all })

export function patchProfile(id: string, body: { name?: string; doc?: Record<string, unknown> }) {
  return api.patch<Profile>(`/profiles/${encodeURIComponent(id)}`, body)
}

export function useCreateProfile() {
  return useMutation({
    mutationFn: (b: ProfileCreate) => api.post<Profile>('/profiles', b),
    meta: { errorTitle: '新建机器配置失败' },
    onSuccess: invalidateProfiles,
  })
}
export function useDeleteProfile() {
  return useMutation({
    mutationFn: (id: string) => api.delete(`/profiles/${encodeURIComponent(id)}`),
    meta: { errorTitle: '删除机器配置失败' },
    onSuccess: invalidateProfiles,
  })
}
export function useActivateProfile() {
  return useMutation({
    mutationFn: (id: string) => api.post<Profile>(`/profiles/${encodeURIComponent(id)}/activate`, {}),
    meta: { errorTitle: '切换机器配置失败' },
    onSuccess: () => {
      void invalidateProfiles()
      void queryClient.invalidateQueries({ queryKey: qk.machine.all })
    },
  })
}
export function useRenameProfile() {
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => patchProfile(id, { name }),
    meta: { errorTitle: '重命名失败' },
    onSuccess: invalidateProfiles,
  })
}

// ---------------- machine ports ----------------
export const useMachinePorts = (enabled = true) =>
  useQuery({ queryKey: qk.machine.ports, queryFn: () => api.get<PortInfo[]>('/machine/ports'), enabled, staleTime: 5_000 })

// ---------------- papers ----------------
export const usePapers = () => useQuery({ queryKey: qk.papers.list(), queryFn: () => api.get<PaperSpec[]>('/papers') })
const invalidatePapers = () => queryClient.invalidateQueries({ queryKey: qk.papers.all })
export function useSavePaper() {
  return useMutation({
    mutationFn: ({ id, body }: { id?: string | null; body: PaperBase }) =>
      id ? api.put<PaperSpec>(`/papers/${encodeURIComponent(id)}`, body) : api.post<PaperSpec>('/papers', body),
    meta: { errorTitle: '保存纸张失败' },
    onSuccess: invalidatePapers,
  })
}
export function useDeletePaper() {
  return useMutation({
    mutationFn: (id: string) => api.delete(`/papers/${encodeURIComponent(id)}`),
    meta: { errorTitle: '删除纸张失败' },
    onSuccess: invalidatePapers,
  })
}

// ---------------- app settings ----------------
export const useAppSettings = () => useQuery({ queryKey: qk.settings, queryFn: () => api.get<AppSettings>('/settings') })
export function patchAppSettings(body: Partial<AppSettings>) {
  return api.patch<AppSettings>('/settings', body).then((s) => {
    queryClient.setQueryData(qk.settings, s)
    return s
  })
}

export const useFontsLite = () =>
  useQuery({ queryKey: qk.fonts.list({}), queryFn: () => api.get<FontSummary[]>('/fonts'), staleTime: 60_000 })

// ---------------- account ----------------
export const useSessions = () => useQuery({ queryKey: qk.auth.sessions, queryFn: () => api.get<SessionInfo[]>('/auth/sessions') })
export const useTokens = () => useQuery({ queryKey: qk.auth.tokens, queryFn: () => api.get<TokenInfo[]>('/auth/tokens') })

export function useRevokeSession() {
  return useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${encodeURIComponent(id)}`),
    meta: { errorTitle: '注销会话失败' },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.auth.sessions }),
  })
}
export function useCreateToken() {
  return useMutation({
    mutationFn: (b: TokenCreate) => api.post<TokenCreated>('/auth/tokens', b),
    meta: { errorTitle: '创建令牌失败' },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.auth.tokens }),
  })
}
export function useRevokeToken() {
  return useMutation({
    mutationFn: (id: string) => api.delete(`/auth/tokens/${encodeURIComponent(id)}`),
    meta: { errorTitle: '吊销令牌失败' },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.auth.tokens }),
  })
}
export function changePassword(oldPw: string, newPw: string) {
  return api.post('/auth/password', { old: oldPw, new: newPw })
}
