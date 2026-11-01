/**
 * Multi-user, machine control lease, presence and diagnostics (04 §13–§15, §17).
 *
 *   GET    /auth/me                       → UserInfo
 *   GET/POST/PATCH/DELETE /users …        (admin)
 *   GET    /machine/lease                 → LeaseInfo (`mine` = caller holds it)
 *   POST   /machine/lease {force?}        → LeaseInfo (409 `lease_held` with detail.holder; force = admin)
 *   DELETE /machine/lease                 → LeaseInfo
 *   WS     `lease` data = LeaseInfo ; `presence` data = {online: PresenceEntry[]}
 *   GET    /presence                      → PresenceEntry[]
 *   GET    /system/diagnostics            → last DiagnosticsResult | 204
 *   POST   /system/diagnostics            {pen_test?, confirm?} → DiagnosticsResult (synchronous)
 */
import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { create } from 'zustand'
import { api, isApiError } from './client'
import { queryClient } from './query'
import type { components } from './schema'
import { ws } from './ws'

type S = components['schemas']

export type Role = 'admin' | 'operator' | 'viewer'
export const ROLE_LABEL: Record<Role, string> = { admin: '管理员', operator: '操作员', viewer: '只读观察' }
export const ROLE_DESC: Record<Role, string> = {
  admin: '全部权限：用户、配置、固件参数、终端',
  operator: '可控制机器、打印、编辑项目',
  viewer: '只能查看状态与任务',
}

export type UserRef = S['UserRef']
export type Me = S['UserInfo']
export type UserInfo = S['UserInfo']
/** Holder carries a few extra fields beyond UserRef on the wire (since, user). */
export type LeaseHolder = S['UserRef'] & { since?: number | null; user?: string }
export type Lease = Omit<S['LeaseInfo'], 'holder'> & { holder?: LeaseHolder | null }
export type PresenceEntry = S['PresenceEntry']
export type DiagStatus = S['DiagnosticCheck']['status']
export type DiagCheck = S['DiagnosticCheck']
export type DiagReport = S['DiagnosticsResult']

/** Display name for a UserRef-ish value (tolerates legacy string users). */
export function userLabel(u: { display_name?: string | null; username?: string } | string | null | undefined): string {
  if (!u) return '未知用户'
  if (typeof u === 'string') return u
  return u.display_name || u.username || '未知用户'
}

export const collabKeys = {
  me: ['auth', 'me'] as const,
  users: ['users'] as const,
  lease: ['machine', 'lease'] as const,
  presence: ['presence'] as const,
  diagnostics: ['system', 'diagnostics'] as const,
}

/** True for "endpoint not there yet". */
export function isUnavailable(e: unknown) {
  return isApiError(e) && (e.status === 404 || e.status === 405 || e.status === 501)
}

export function useMe() {
  return useQuery({
    queryKey: collabKeys.me,
    queryFn: () => api.get<Me>('/auth/me'),
    staleTime: 60_000,
    retry: false,
  })
}

/** Role of the current user; single-admin backends (no /auth/me) count as admin. */
export function useRole(): Role {
  const me = useMe()
  if (me.data?.role) return me.data.role
  return 'admin'
}

/** Viewers may watch but not edit or control (E-stop stays available to everyone). */
export function useCanEdit(): boolean {
  return useRole() !== 'viewer'
}

// ---------------- control lease ----------------

interface LeaseState {
  lease: Lease | null
  /** false = backend has no lease support (everyone may control). */
  supported: boolean | null
}
export const useLeaseStore = create<LeaseState>(() => ({ lease: null, supported: null }))

// opt in to the extra topics for the whole session (servers without them ignore unknown topics)
ws.subscribe(['lease', 'presence'] as never)

const FREE: Lease = { held: false, holder: null, online: false, release_after_s: 60, mine: false }

/** WS lease events carry no `mine` (it is per-caller): keep ours if the holder didn't change, else re-fetch. */
ws.on('lease' as never, (p: unknown) => {
  const l = p as Lease
  const prev = useLeaseStore.getState().lease
  const sameHolder = (prev?.holder?.id ?? null) === (l.holder?.id ?? null)
  useLeaseStore.setState({ lease: { ...l, mine: l.held ? (sameHolder ? prev?.mine : undefined) ?? undefined : false }, supported: true })
  if (l.held && !sameHolder) void refreshLease()
})
ws.on('hello', (h) => {
  const snap = (h as unknown as { snapshot?: { lease?: Lease | null; presence?: PresenceEntry[] | { online: PresenceEntry[] } } }).snapshot
  if (snap && 'lease' in snap) useLeaseStore.setState({ lease: snap.lease ?? FREE, supported: true })
  if (snap?.presence) queryClient.setQueryData(collabKeys.presence, presenceList(snap.presence))
  void refreshLease()
})
ws.on('presence' as never, (p: unknown) => {
  queryClient.setQueryData(collabKeys.presence, presenceList(p))
})

/** WS sends {online:[…]}; REST sends […]. */
function presenceList(p: unknown): PresenceEntry[] {
  if (Array.isArray(p)) return p as PresenceEntry[]
  const o = (p as { online?: PresenceEntry[] } | null)?.online
  return Array.isArray(o) ? o : []
}

let leaseInflight: Promise<void> | null = null
let leaseAt = 0

/** GET /machine/lease; concurrent callers (hello + first useLease mount) share one request. */
export function refreshLease(): Promise<void> {
  if (leaseInflight) return leaseInflight
  if (Date.now() - leaseAt < 1500) return Promise.resolve()
  leaseInflight = fetchLease().finally(() => {
    leaseInflight = null
    leaseAt = Date.now()
  })
  return leaseInflight
}

async function fetchLease() {
  try {
    const l = await api.get<Lease>('/machine/lease', { timeoutMs: 6000 })
    if (!l || typeof l !== 'object' || !('held' in l)) useLeaseStore.setState({ supported: false, lease: null })
    else useLeaseStore.setState({ lease: l, supported: true })
  } catch (e) {
    if (isUnavailable(e)) useLeaseStore.setState({ supported: false, lease: null })
  }
}

export async function acquireLease(force = false) {
  const l = await api.post<Lease>('/machine/lease', force ? { force: true } : {})
  useLeaseStore.setState({ lease: { ...l, mine: l.mine ?? true }, supported: true })
  return l
}
export async function releaseLease() {
  const l = await api.delete<Lease>('/machine/lease')
  useLeaseStore.setState({ lease: l ?? FREE, supported: true })
}

export interface LeaseView {
  supported: boolean
  /** Nobody holds it, or we do: controls usable. When nobody holds it, the first control call may acquire implicitly. */
  canControl: boolean
  mine: boolean
  free: boolean
  holderName: string | null
  since: number | null
}

export function useLease(): LeaseView {
  const { lease, supported } = useLeaseStore()
  const me = useMe()
  React.useEffect(() => {
    if (supported == null) void refreshLease()
  }, [supported])
  if (!supported || !lease) return { supported: !!supported, canControl: true, mine: false, free: true, holderName: null, since: null }
  const h = lease.held ? lease.holder : null
  const mine = lease.mine ?? (!!h && !!me.data && h.id === me.data.id)
  // Admins may act regardless of the lease (04 §14).
  const admin = me.data?.role === 'admin'
  return {
    supported: true,
    canControl: !h || mine || admin,
    mine,
    free: !h,
    holderName: h ? userLabel(h) : null,
    since: lease.since ?? h?.since ?? null,
  }
}

// ---------------- presence ----------------

export function usePresence(enabled = true) {
  return useQuery({
    queryKey: collabKeys.presence,
    queryFn: async () => presenceList(await api.get<unknown>('/presence')),
    enabled,
    refetchInterval: 30_000,
    retry: false,
  })
}

/** Short device label from a user agent. */
export function clientLabel(ua?: string | null) {
  if (!ua) return '未知设备'
  if (/iPad/.test(ua)) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return 'Android'
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl|python|httpx/i.test(ua) ? '脚本' : '浏览器'
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${b} · ${os}` : b
}
