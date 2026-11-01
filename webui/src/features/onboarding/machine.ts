/**
 * Machine adapter for the wizard: real API (03 §4.7) when the backend answers, otherwise a small local
 * simulation ("演示模式") so the wizard can be walked through and screenshotted without hardware.
 */
import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'
import { ApiError, api } from '@/api/client'
import { connectMachine } from '@/api/machine'
import { frameBox, jog, setPen, setZero } from '@/api/machine-control'
import { qk } from '@/api/query'
import { useLive } from '@/api/store'
import type { MachineStatus, SerialPort } from '@/api/types'

export type Mode = 'live' | 'demo' | 'checking'

interface Sim {
  status: MachineStatus
  set: (p: Partial<MachineStatus>) => void
}
const simStatus = (): MachineStatus =>
  ({
    connected: false, connecting: false, port: null, baud: 115200, fake: true, firmware: null, grbl_state: '', state_text: '未连接',
    wpos: null, mpos: null, wco: null, feed: 0, spindle: 0, buf: null, ov: null, pins: '', pen: 'unknown', origin_valid: false,
    last_alarm: null, job_id: null, busy: false, error: null, updated_at: Date.now() / 1000,
  }) as unknown as MachineStatus
export const useSim = create<Sim>((set) => ({ status: simStatus(), set: (p) => set((s) => ({ status: { ...s.status, ...p } })) }))

const unavailable = (e: unknown) => e instanceof ApiError && (e.isOffline || e.status === 404 || e.status === 501)

export function useMachineMode(): Mode {
  const q = useQuery({
    queryKey: qk.machine.status,
    queryFn: () => api.get<MachineStatus>('/machine/status', { timeoutMs: 5000 }),
    retry: false,
    staleTime: 5000,
  })
  if (q.isPending) return 'checking'
  return q.isError && unavailable(q.error) ? 'demo' : 'live'
}

export function useStatus(mode: Mode): MachineStatus | null {
  const live = useLive((s) => s.machine)
  const q = useQuery({ queryKey: qk.machine.status, queryFn: () => api.get<MachineStatus>('/machine/status'), enabled: false })
  const sim = useSim((s) => s.status)
  if (mode === 'demo') return sim
  return live ?? q.data ?? null
}

export function usePortList(mode: Mode) {
  return useQuery({
    queryKey: [...qk.machine.ports, mode],
    queryFn: async (): Promise<SerialPort[]> => {
      if (mode === 'demo')
        return [
          { path: '/dev/ttyUSB0', by_id: '/dev/serial/by-id/usb-1a86_USB_Serial-if00-port0', description: 'USB Serial (CH340)', vid: '1a86', pid: '7523', busy_pid: null },
          { path: '/dev/ttyS0', by_id: null, description: '板载串口', vid: null, pid: null, busy_pid: null },
        ] as SerialPort[]
      return api.get<SerialPort[]>('/machine/ports')
    },
    enabled: mode !== 'checking',
    staleTime: 5000,
  })
}

/** Best guess: CH340 (vid 1a86) by-id path, else first USB, else first. */
export function preferredPort(ports: SerialPort[] | undefined, current?: string | null) {
  if (!ports?.length) return undefined
  const key = (p: SerialPort) => p.by_id ?? p.path
  if (current && ports.some((p) => key(p) === current || p.path === current)) return current
  const ch = ports.find((p) => p.vid === '1a86' || /1a86|ch340/i.test(`${p.by_id ?? ''} ${p.description}`))
  const usb = ports.find((p) => /usb|acm/i.test(`${p.path} ${p.by_id ?? ''}`))
  return key(ch ?? usb ?? ports.find((p) => p.path !== 'fake') ?? ports[0])
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function simMove(dx: number, dy: number, dz: number) {
  const s = useSim.getState()
  const [x, y, z] = (s.status.wpos as number[] | null) ?? [0, 0, 0]
  const nz = Math.round((z + dz) * 100) / 100
  s.set({ wpos: [x + dx, y + dy, nz], pen: nz > 0.3 ? 'down' : 'up', updated_at: Date.now() / 1000 } as Partial<MachineStatus>)
}

export function machineActions(mode: Mode) {
  const demo = mode === 'demo'
  return {
    async connect(port?: string) {
      if (demo) {
        useSim.getState().set({ connecting: true } as Partial<MachineStatus>)
        await wait(700)
        useSim.getState().set({
          connected: true, connecting: false, port: port ?? null, firmware: '1.1f', grbl_state: 'Idle', state_text: '空闲', wpos: [0, 0, 0], mpos: [0, 0, 0], pen: 'up',
        } as Partial<MachineStatus>)
        return
      }
      await connectMachine(port ? { port } : {})
    },
    async jog(d: { dx?: number; dy?: number; dz?: number }) {
      if (demo) {
        await wait(120)
        return simMove(d.dx ?? 0, d.dy ?? 0, d.dz ?? 0)
      }
      await jog(d, d.dz && !d.dx && !d.dy ? 600 : undefined)
    },
    async zero(axes: 'xyz' | 'xy' | 'z') {
      if (demo) {
        const s = useSim.getState()
        const [x, y, z] = (s.status.wpos as number[] | null) ?? [0, 0, 0]
        s.set({ wpos: [axes === 'z' ? x : 0, axes === 'z' ? y : 0, axes === 'xy' ? z : 0], origin_valid: axes !== 'z' || s.status.origin_valid } as Partial<MachineStatus>)
        return
      }
      await setZero(axes)
    },
    async pen(state: 'up' | 'down', zOn = 8) {
      if (demo) {
        const s = useSim.getState()
        const [x, y] = (s.status.wpos as number[] | null) ?? [0, 0, 0]
        s.set({ wpos: [x, y, state === 'up' ? 0 : zOn], pen: state } as Partial<MachineStatus>)
        return
      }
      await setPen(state)
    },
    /** Pen-up frame of a w×h mm rectangle from the origin (LeftUp: machine y negative downward). */
    async frame(w: number, h: number) {
      if (demo) return wait(1500)
      await frameBox([0, -h, w, 0])
    },
  }
}
