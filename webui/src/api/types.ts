/**
 * Stable type names used across the app, aliased from the generated OpenAPI types (./schema.d.ts,
 * `npm run gen:api` from docs/design/openapi.json). Behaviour notes: docs/design/04-contract-notes.md.
 *
 * Prefer importing from here; for anything not aliased use
 *   import type { components } from '@/api/schema'
 *   type Foo = components['schemas']['Foo']
 */
import type { components } from './schema'

type S = components['schemas']

// ---------- errors ----------
export type ApiErrorBody = S['ErrorBody']
export type ErrorInfo = S['ErrorInfo']

// ---------- auth ----------
export type AuthState = S['AuthState']
export type LoginRequest = S['LoginRequest']
export type LoginResponse = S['LoginResponse']
export type SetupRequest = S['SetupRequest']

// ---------- machine ----------
export type MachineStatus = S['MachineStatus']
export type PenState = MachineStatus['pen']
export type SerialPort = S['PortInfo']
export type Alarm = S['AlarmInfo']

// ---------- jobs ----------
export type Job = S['Job']
export type JobStatus = Job['status']
export type JobError = S['JobError']
export type JobProgress = S['ProgressData']

export const ACTIVE_JOB_STATUSES: JobStatus[] = ['preparing', 'running', 'paused', 'stopping']
export const TERMINAL_JOB_STATUSES: JobStatus[] = ['done', 'failed', 'aborted']

// ---------- tasks ----------
export type Task = S['Task']
export type TaskState = Task['state']
export type TaskRef = S['TaskRef']

// ---------- WebSocket (04 §11): payload is under `data` except hello / gap / ack / pong ----------
/** Server topics; the collab ones (presence/lease/project/locks/teletype) are not in openapi.json yet. */
export type WsTopic = S['WsSubscribe']['topics'][number] | 'presence' | 'lease' | 'project' | 'locks' | 'teletype'
export type WsCmdOp = S['WsCmd']['op']
export type WsHello = S['WsHello']
export type WsJobEvent = S['JobEventData']
export type WsTaskEvent = S['TaskData']
export type WsAck = S['WsAck']
export type FirmwareError = S['GcodeErrorData']
export type LogLine = S['WsLogLine']
export type SystemMetricsEvent = S['SystemData']
export type Notice = S['NoticeData']
export type AlarmEvent = S['AlarmData']

/** Map of server→client message types to their payloads (already unwrapped from `data`). */
export interface WsServerEvents {
  hello: WsHello
  status: MachineStatus
  progress: JobProgress
  job: WsJobEvent
  alarm: AlarmEvent
  error: FirmwareError
  log: S['LogData']
  task: WsTaskEvent
  system: SystemMetricsEvent
  notice: Notice
  gap: S['WsGap']
  ack: WsAck
  pong: S['WsPong']
  attention: S['AttentionData']
  lease: S['LeaseInfo']
  presence: S['PresenceData']
}
export type WsServerType = keyof WsServerEvents

// ---------- misc used by the shell ----------
export type SystemHealth = S['Health']
