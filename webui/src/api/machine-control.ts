/**
 * Manual machine control (03 §4.7) used by the 控制 page. Pages-agent addition; complements
 * '@/api/machine' (estop/pause/resume/stop/connect). WS first where the protocol allows it, REST otherwise.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import { qk } from './query'
import { useLive } from './store'
import type { MachineStatus, SerialPort } from './types'
import type { components } from './schema'
import { ws } from './ws'

export type Profile = components['schemas']['Profile']

let jogSeq = 0

/** Defensive: list endpoints must yield arrays even if a proxy/mock answers `{}` (review §0-1). */
export function asArray<T>(d: unknown): T[] {
  return Array.isArray(d) ? (d as T[]) : []
}

function applyStatus(s: unknown) {
  if (s && typeof s === 'object' && 'connected' in s) useLive.getState().applyStatus(s as MachineStatus)
}

async function viaWs(op: Parameters<typeof ws.cmd>[0], args: Record<string, unknown>, http: () => Promise<unknown>, timeoutMs = 2500) {
  if (ws.isOpen) {
    try {
      await ws.cmd(op, args, { timeoutMs })
      return
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'timeout' && code !== 'disconnected') throw e
    }
  }
  applyStatus(await http())
}

/** One relative jog (mm). Server limits |d| ≤ 50 mm per call. */
export function jog(d: { dx?: number; dy?: number; dz?: number }, feed?: number) {
  const args = { dx: d.dx ?? 0, dy: d.dy ?? 0, dz: d.dz ?? 0, feed, seq: ++jogSeq }
  return viaWs('jog', args, () => api.post<MachineStatus>('/machine/jog', args, { idempotencyKey: true, timeoutMs: 4000 }), 1500)
}

export function jogCancel() {
  return viaWs('jog_cancel', {}, () => api.post('/machine/jog/cancel', {}, { timeoutMs: 4000 }), 1500)
}

export function setPen(state: 'up' | 'down') {
  return viaWs('pen', { state }, () => api.post<MachineStatus>('/machine/pen', { state }))
}

export function realtime(byte: string) {
  return viaWs('realtime', { byte }, () => api.post('/machine/realtime', { byte }))
}

export async function setZero(axes: 'xyz' | 'xy' | 'z') {
  applyStatus(await api.post<MachineStatus>('/machine/zero', { axes }, { idempotencyKey: true }))
}
export async function gotoOrigin() {
  applyStatus(await api.post<MachineStatus>('/machine/goto-origin', {}, { timeoutMs: 60_000 }))
}
export async function machineAction(path: 'unlock' | 'reset' | 'sleep' | 'homing') {
  applyStatus(await api.post<MachineStatus>(`/machine/${path}`, {}, { timeoutMs: 30_000 }))
}
export async function runMacro(n: 1 | 2 | 3) {
  applyStatus(await api.post<MachineStatus>(`/machine/macro/${n}`, {}, { timeoutMs: 60_000 }))
}
export async function frameBox(bbox_mm: [number, number, number, number], feed?: number) {
  applyStatus(await api.post<MachineStatus>('/machine/frame', { bbox_mm, feed, z: 'up' }, { timeoutMs: 120_000 }))
}
/** Absolute move in work coordinates, pen up first (travel map "移动到此处"). */
export async function moveTo(x: number, y: number, feed?: number) {
  await api.post('/machine/command', { line: `G90 G0 X${x.toFixed(3)} Y${y.toFixed(3)}${feed ? ` F${Math.round(feed)}` : ''}`, timeout_s: 30 }, { idempotencyKey: true, timeoutMs: 40_000 })
}

export function usePorts(enabled = true) {
  return useQuery({
    queryKey: qk.machine.ports,
    queryFn: () => api.get<SerialPort[]>('/machine/ports'),
    select: asArray<SerialPort>,
    enabled,
    staleTime: 15_000,
  })
}

export function useProfiles() {
  return useQuery({ queryKey: qk.profiles.list(), queryFn: () => api.get<Profile[]>('/profiles'), select: asArray<Profile> })
}

export function useActiveProfile() {
  const q = useProfiles()
  return { ...q, profile: q.data?.find((p) => p.is_active) ?? q.data?.[0] ?? null }
}

/** Typed accessors for the loosely typed ProfileDoc sub-dicts. */
export function profileNumbers(p: Profile | null) {
  const d: Partial<Profile['doc']> = p?.doc ?? {}
  const s = (d.settings ?? {}) as Record<string, unknown>
  const g = (d.grbl ?? {}) as Record<string, unknown>
  const a = (d.advanced ?? {}) as Record<string, unknown>
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt)
  return {
    feedRate: num(s.feedRate, 1500),
    jogSpeed: num(s.jogSpeed, 2500),
    zOn: num(g.zOn, 8),
    zOff: num(g.zOff, 0),
    zSpeed: num(g.zSpeed, 5000),
    zJogStep: num(a.zJogStep, 1),
    penType: String(g.type ?? 'Stepper'),
    /** 0 = travel not configured (no homing; not checked) */
    workW: num(d.work_area?.w_mm, 0),
    workH: num(d.work_area?.h_mm, 0),
    corner: num((d.axes as Record<string, unknown> | undefined)?.pos, 0),
    macros: [1, 2, 3].map((n) => String(a[`macro${n}`] ?? '')),
  }
}
