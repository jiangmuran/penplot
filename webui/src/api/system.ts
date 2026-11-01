/**
 * System status (03 §4.8). Pages-agent addition.
 */
import { useQuery } from '@tanstack/react-query'
import { collabKeys, type DiagReport } from './collab'
import { api } from './client'
import { qk } from './query'
import type { components } from './schema'

type S = components['schemas']
export type SystemInfo = S['SystemInfo']
export type Metrics = S['Metrics']
export type WifiInfo = S['WifiInfo']
export type LogEntry = S['LogEntry']
export type AuditEntry = S['AuditEntry']
export type Health = S['Health']
export type PortInfo = S['PortInfo']

export const useHealth = () =>
  useQuery({ queryKey: qk.system.health, queryFn: () => api.get<Health>('/system/health'), refetchInterval: 30_000 })
export const useSystemInfo = () =>
  useQuery({ queryKey: qk.system.info, queryFn: () => api.get<SystemInfo>('/system/info'), staleTime: 60_000 })
export const useMetrics = () =>
  useQuery({ queryKey: qk.system.metrics, queryFn: () => api.get<Metrics>('/system/metrics'), refetchInterval: 15_000 })
export const useWifi = () =>
  useQuery({ queryKey: qk.system.wifi, queryFn: () => api.get<WifiInfo>('/system/wifi'), refetchInterval: 20_000 })
export const usePorts = () =>
  useQuery({ queryKey: [...qk.machine.ports], queryFn: () => api.get<PortInfo[]>('/machine/ports') })

export function useServiceLogs(params: { n: number; priority?: number }) {
  return useQuery({
    queryKey: qk.system.logs(params),
    queryFn: () => api.get<LogEntry[]>('/system/logs', { query: { n: params.n, priority: params.priority } }),
    refetchInterval: 10_000,
  })
}

export function useAudit(limit = 100) {
  return useQuery({ queryKey: ['system', 'audit', limit], queryFn: () => api.get<AuditEntry[]>('/system/audit', { query: { limit } }) })
}

export function restartService(force = false) {
  return api.post('/system/restart', { force })
}

// ---------------- diagnostics (04 §17) ----------------

export function useDiagnostics() {
  return useQuery({
    queryKey: collabKeys.diagnostics,
    queryFn: async () => (await api.get<DiagReport | undefined>('/system/diagnostics')) ?? null,
    retry: false,
  })
}

/** Synchronous: returns the report (the pen test needs the lease and `confirm: true`). */
export function runDiagnostics(penTest = false) {
  return api.post<DiagReport>('/system/diagnostics', { pen_test: penTest, confirm: penTest }, { timeoutMs: 60_000 })
}
