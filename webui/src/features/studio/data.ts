/** Shared queries used across the studio (papers, fonts, profiles, settings). */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { qk } from '@/api/query'
import type { AppSettings, FontSummary, PaperSpec, Profile, ProjectSummary } from '@/api/studio'

export function usePapers() {
  return useQuery({ queryKey: qk.papers.list(), queryFn: () => api.get<PaperSpec[]>('/papers'), staleTime: 60_000 })
}

export function useFonts() {
  return useQuery({ queryKey: qk.fonts.list({}), queryFn: () => api.get<FontSummary[]>('/fonts'), staleTime: 60_000 })
}

/** Per-font missing characters for `text` (GET /fonts?covers=). */
export function useFontCoverage(text: string, enabled = true) {
  const uniq = [...new Set([...text].filter((c) => c.trim()))].join('').slice(0, 400)
  return useQuery({
    queryKey: qk.fonts.list({ covers: uniq }),
    queryFn: () => api.get<FontSummary[]>('/fonts', { query: { covers: uniq } }),
    enabled: enabled && uniq.length > 0,
    staleTime: 60_000,
    placeholderData: (p) => p,
  })
}

export function useProfiles() {
  return useQuery({ queryKey: qk.profiles.list(), queryFn: () => api.get<Profile[]>('/profiles'), staleTime: 30_000 })
}

export function useActiveProfile() {
  const q = useProfiles()
  return { ...q, profile: q.data?.find((p) => p.is_active) ?? q.data?.[0] ?? null }
}

export function useAppSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: () => api.get<AppSettings>('/settings'), staleTime: 60_000 })
}

export function useProjectList(template: boolean, q = '') {
  return useQuery({
    queryKey: qk.projects.list({ template, q }),
    queryFn: () => api.get<ProjectSummary[]>('/projects', { query: { template: template ? 1 : 0, q: q || undefined } }),
    staleTime: 5_000,
  })
}
