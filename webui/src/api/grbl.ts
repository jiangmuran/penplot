/**
 * Raw serial / GRBL helpers (pages-agent addition): `$$` settings, raw commands, realtime bytes.
 *
 *   const q = useGrblSettings(connected)
 *   await writeGrblSettings({ '110': 3000 })
 *   const r = await sendCommand('$G')          // { ok, reply_lines }
 *   await sendRealtime('!')                    // WS first, then HTTP
 */
import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import { queryClient, qk } from './query'
import type { components } from './schema'
import { ws } from './ws'

export type GrblSetting = components['schemas']['GrblSetting']
export type CommandResult = components['schemas']['CommandResult']

export const REALTIME = {
  status: '?',
  hold: '!',
  resume: '~',
  reset: '0x18',
  jogCancel: '0x85',
} as const
export type RealtimeByte = (typeof REALTIME)[keyof typeof REALTIME] | `0x${string}`

export function useGrblSettings(enabled = true) {
  return useQuery({
    queryKey: qk.machine.grblSettings,
    queryFn: () => api.get<GrblSetting[]>('/machine/grbl-settings', { timeoutMs: 20_000 }),
    enabled,
    staleTime: 60_000,
  })
}

/** Re-read `$$` from the controller (bypasses the server's 60 s cache). */
export async function refreshGrblSettings() {
  const rows = await api.get<GrblSetting[]>('/machine/grbl-settings', { query: { refresh: 1 }, timeoutMs: 20_000 })
  queryClient.setQueryData(qk.machine.grblSettings, rows)
  return rows
}

/** Write changed values only (EEPROM). Idle only; audited server-side. */
export async function writeGrblSettings(diff: Record<string, number | string>) {
  const rows = await api.put<GrblSetting[]>('/machine/grbl-settings', diff, { timeoutMs: 30_000 })
  if (Array.isArray(rows)) queryClient.setQueryData(qk.machine.grblSettings, rows)
  else void queryClient.invalidateQueries({ queryKey: qk.machine.grblSettings })
  return rows
}

export function sendCommand(line: string, timeout_s = 10) {
  return api.post<CommandResult>('/machine/command', { line, timeout_s }, { idempotencyKey: true, timeoutMs: (timeout_s + 5) * 1000 })
}

export async function sendRealtime(byte: RealtimeByte) {
  if (ws.isOpen) {
    try {
      await ws.cmd('realtime', { byte }, { timeoutMs: 2000 })
      return
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'timeout' && code !== 'disconnected') throw e
    }
  }
  await api.post('/machine/realtime', { byte })
}
