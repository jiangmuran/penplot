/**
 * Projects & templates (03 §4.3, §3.5; 04 §8). Pages-agent addition.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import { downloadFrom, formWithFile } from './download'
import { qk, queryClient } from './query'
import type { components } from './schema'

type S = components['schemas']
export type ProjectSummary = S['ProjectSummary']
export type Project = S['Project']
export type ProjectDoc = S['ProjectDoc']
export type ProjectVariable = S['Variable']
export type ProjectImportResult = S['ProjectImportResult']
export type PaperSpec = S['PaperSpec']
export type TableImportResult = S['TableImportResult']
export type SheetInfo = S['SheetInfo']
export type BatchRequest = S['BatchRequest']
export type BatchResult = S['BatchResult']
export type RenderResult = S['RenderResult']

export function useProjects(params: { template?: 0 | 1; q?: string } = {}) {
  return useQuery({
    queryKey: qk.projects.list(params),
    queryFn: () => api.get<ProjectSummary[]>('/projects', { query: { template: params.template, q: params.q || undefined, limit: 500 } }),
    placeholderData: (prev) => prev,
  })
}

export function useProject(id: string | null | undefined) {
  return useQuery({
    queryKey: qk.projects.detail(id ?? '-'),
    queryFn: () => api.get<Project>(`/projects/${id}`),
    enabled: !!id,
  })
}

export function usePapers() {
  return useQuery({ queryKey: qk.papers.list(), queryFn: () => api.get<PaperSpec[]>('/papers'), staleTime: 60_000 })
}

export const invalidateProjects = () => queryClient.invalidateQueries({ queryKey: qk.projects.all })

export function createProject(body: { name: string; doc?: Record<string, unknown> | null; from_template_id?: string | null; is_template?: boolean }) {
  return api.post<Project>('/projects', body)
}

export function duplicateProject(id: string) {
  return api.post<Project>(`/projects/${id}/duplicate`, {})
}

export function saveAsTemplate(id: string, name?: string) {
  return api.post<Project>(`/projects/${id}/save-as-template`, name ? { name } : {})
}

export function deleteProject(id: string) {
  return api.delete(`/projects/${id}`)
}

/** Rename = read current doc + rev, then PUT with the new name (409 rev_conflict if stale). */
export async function renameProject(id: string, name: string) {
  const p = await api.get<Project>(`/projects/${id}`)
  return api.put<Project>(`/projects/${id}`, { doc: { ...p.doc, name }, rev: p.rev, name })
}

export function exportProject(id: string, name: string, zip = false) {
  return downloadFrom(`/projects/${id}/export`, `${name}${zip ? '.zip' : '.penplot.json'}`, { query: zip ? { zip: 1 } : undefined })
}

export function importProject(file: File) {
  return api.post<ProjectImportResult>('/projects/import', formWithFile(file), { timeoutMs: 120_000 })
}

export function importTable(file: File) {
  return api.post<TableImportResult>('/import/table', formWithFile(file), { timeoutMs: 120_000 })
}

export function runBatch(id: string, body: BatchRequest, wait = 5) {
  return api.post<BatchResult | S['TaskRef']>(`/projects/${id}/batch`, body, { query: { wait }, timeoutMs: 120_000 })
}

export const previewSvgUrl = (rid: string, page = 0) => api.url(`/render/${rid}/pages/${page}/preview.svg`, { space: 'page' })
