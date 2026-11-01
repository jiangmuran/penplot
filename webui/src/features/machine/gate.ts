import { useShallow } from 'zustand/react/shallow'
import { useLease, useRole } from '@/api/collab'
import { isJobActive, useLive } from '@/api/store'

export interface MachineGate {
  /** WS open + serial connected */
  online: boolean
  connected: boolean
  /** Manual motion/pen/zero allowed now */
  canMove: boolean
  /** Reason shown when !canMove */
  reason: string | null
  alarm: boolean
  jobActive: boolean
  /** Blocked by the control lease or a read-only role (unlock etc. too) */
  leaseBlocked: boolean
  state: string
}

/**
 * Whether manual controls may be used (03 §2.3: during a job only when paused, nothing pending and Idle).
 * E-stop is never gated.
 */
export function useMachineGate(): MachineGate {
  const { conn, machine, job } = useLive(useShallow((s) => ({ conn: s.conn, machine: s.machine, job: s.job })))
  const online = conn === 'open'
  const connected = !!machine?.connected
  const state = (machine?.grbl_state ?? '').split(':')[0]
  const alarm = state === 'Alarm'
  const jobActive = isJobActive(job)
  const pausedIdle = job?.status === 'paused' && state === 'Idle'
  const lease = useLease()
  const role = useRole()
  let reason: string | null = null
  if (!online) reason = '与设备的连接已断开'
  else if (!connected) reason = machine?.connecting ? '正在连接机器…' : '机器未连接'
  else if (role === 'viewer') reason = '只读账户不能控制机器'
  else if (!lease.canControl) reason = `控制权在 ${lease.holderName ?? '其他用户'} 手中`
  else if (alarm) reason = '机器处于报警状态，请先解锁'
  else if (jobActive && !pausedIdle) reason = '任务进行中，暂停后可点动'
  else if (machine?.busy && !pausedIdle) reason = '机器忙'
  return { leaseBlocked: !lease.canControl || role === 'viewer', online, connected: online && connected, canMove: reason == null, reason, alarm, jobActive, state }
}
