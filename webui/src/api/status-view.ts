/** Derive the global machine-status presentation (02-ux §2.3) from live state. */
import {
  Activity, CircleCheck, CirclePause, Crosshair, DoorOpen, House, Loader, Moon, PlugZap, ScanSearch, Siren,
  TriangleAlert, WifiOff, type LucideIcon,
} from 'lucide-react'
import type { ConnState } from './store'
import type { FirmwareError, Job, JobProgress, MachineStatus } from './types'

export type StatusTone = 'gray' | 'green' | 'blue' | 'orange' | 'red'

export interface StatusView {
  tone: StatusTone
  icon: LucideIcon
  label: string
  /** aria-live politeness */
  live: 'polite' | 'assertive'
  spin?: boolean
  percent?: number | null
  /** Machine usable for control commands. */
  canControl: boolean
}

export const toneClasses: Record<StatusTone, { pill: string; dot: string; text: string }> = {
  gray: { pill: 'bg-fill text-secondary-label', dot: 'bg-gray', text: 'text-secondary-label' },
  green: { pill: 'bg-green/15 text-on-tint-green', dot: 'bg-green', text: 'text-on-tint-green' },
  blue: { pill: 'bg-blue/15 text-on-tint-blue', dot: 'bg-blue', text: 'text-on-tint-blue' },
  orange: { pill: 'bg-orange/15 text-on-tint-orange', dot: 'bg-orange', text: 'text-on-tint-orange' },
  red: { pill: 'bg-red/15 text-on-tint-red', dot: 'bg-red', text: 'text-on-tint-red' },
}

/**
 * GRBL is in feed hold (`Hold:0/1`) but nothing of ours paused it: no active job, no teletype session
 * (the machine's own pause button, or a hold kept across a USB reconnect). Only `clear-hold` gets out.
 */
export function isStrayHold(machine: MachineStatus | null | undefined, job: Job | null | undefined): boolean {
  if (!machine?.connected || !machine.grbl_state?.startsWith('Hold')) return false
  if (machine.teletype || machine.job_id) return false
  return !job || !['running', 'paused', 'preparing', 'stopping'].includes(job.status)
}

export function statusView(input: {
  conn: ConnState
  everConnected: boolean
  machine: MachineStatus | null
  job: Job | null
  progress: JobProgress | null
  firmwareErrors?: FirmwareError[]
}): StatusView {
  const { conn, everConnected, machine, job, progress } = input
  if (conn !== 'open') {
    return {
      tone: 'gray',
      icon: WifiOff,
      label: everConnected ? '设备离线 · 重连中' : conn === 'connecting' ? '正在连接…' : '设备离线',
      live: 'polite',
      canControl: false,
    }
  }
  if (!machine || !machine.connected) {
    return machine?.connecting
      ? { tone: 'gray', icon: Loader, label: '连接中…', live: 'polite', spin: true, canControl: false }
      : { tone: 'gray', icon: PlugZap, label: '未连接', live: 'polite', canControl: false }
  }
  const state = (machine.grbl_state || 'Unknown').split(':')[0]
  const pct = progress?.percent ?? (job && job.total_lines ? (100 * job.acked_line) / job.total_lines : null)
  if (state === 'Alarm') return { tone: 'red', icon: Siren, label: '报警 · 需解锁', live: 'assertive', canControl: true }
  const errCount = job ? Math.max((input.firmwareErrors ?? []).filter((e) => e.job_id === job.id).length, job.errors?.length ?? 0) : 0
  if (job && errCount > 0) return { tone: 'red', icon: TriangleAlert, label: `错误 ×${errCount}`, live: 'assertive', percent: pct, canControl: true }
  if (state === 'Hold' && isStrayHold(machine, job)) return { tone: 'orange', icon: CirclePause, label: '机器暂停', live: 'polite', canControl: true }
  if (job?.status === 'paused' || state === 'Hold') return { tone: 'orange', icon: CirclePause, label: '已暂停', live: 'polite', percent: pct, canControl: true }
  if (job && ['running', 'preparing', 'stopping'].includes(job.status)) {
    const label =
      job.status === 'preparing' ? '准备中…' : job.status === 'stopping' ? '正在停止…' : `运行 · ${Math.floor(pct ?? 0)}%`
    return { tone: 'blue', icon: Activity, label, live: 'polite', percent: pct, canControl: true }
  }
  switch (state) {
    case 'Idle':
      return { tone: 'green', icon: CircleCheck, label: '空闲', live: 'polite', canControl: true }
    case 'Run':
      return { tone: 'blue', icon: Activity, label: '运行中', live: 'polite', canControl: true }
    case 'Jog':
      return { tone: 'blue', icon: Crosshair, label: '点动中', live: 'polite', canControl: true }
    case 'Home':
      return { tone: 'blue', icon: House, label: '归位中', live: 'polite', canControl: true }
    case 'Door':
      return { tone: 'orange', icon: DoorOpen, label: '安全门打开', live: 'polite', canControl: true }
    case 'Sleep':
      return { tone: 'gray', icon: Moon, label: '休眠', live: 'polite', canControl: true }
    case 'Check':
      return { tone: 'gray', icon: ScanSearch, label: '检查模式', live: 'polite', canControl: true }
    default:
      return { tone: 'gray', icon: Loader, label: machine.state_text || '状态未知', live: 'polite', canControl: true }
  }
}
