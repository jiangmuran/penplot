/** Output pipeline: render the doc for print/export (with the per-job placement offset), frame, create jobs. */
import { guardStart } from '@/api/job-guard'
import { api, errorMessage, isApiError } from '@/api/client'
import { qk, queryClient } from '@/api/query'
import { renderProject, type Job, type PrintOverrides, type ProfileDoc, type ProjectDoc, type RenderResult, type TaskWatch } from '@/api/studio'
import { useLive } from '@/api/store'
import { confirm } from '@/lib/confirm'
import { toast } from '@/lib/toast'
import { clone, variableValues } from './model'
import { useStudio } from './store'

/** The document as it should be output: the per-job placement offset applied to every element (design unchanged). */
export function outputDoc(doc: ProjectDoc, placement: { dx: number; dy: number }): ProjectDoc {
  if (!placement.dx && !placement.dy) return doc
  const d = clone(doc)
  for (const p of d.pages) for (const e of p.elements) e.transform = { ...e.transform, x: e.transform.x + placement.dx, y: e.transform.y + placement.dy }
  return d
}

export async function renderForOutput(opts: { profileId?: string | null; overrides?: PrintOverrides | null; signal?: AbortSignal } & TaskWatch = {}): Promise<RenderResult> {
  const s = useStudio.getState()
  if (!s.project || !s.doc) throw new Error('没有打开的项目')
  const doc = outputDoc(s.doc, s.placement)
  return renderProject(s.project.id, { doc, variables: variableValues(s.doc), profile_id: opts.profileId ?? null, overrides: opts.overrides ?? null }, { signal: opts.signal, onProgress: opts.onProgress, onTask: opts.onTask })
}

// ------------------------------------------------------------------ profile defaults

export type OverrideKey = keyof Omit<PrintOverrides, 'origin'>

/** Profile value for a print field (03 §3.4 mapping). */
export function profileDefault(doc: ProfileDoc | undefined, key: OverrideKey): unknown {
  if (!doc) return null
  const pd = (doc.print_defaults ?? {}) as Record<string, unknown>
  if (pd[key] != null) return pd[key]
  const st = (doc.settings ?? {}) as Record<string, unknown>
  const pen = ((doc.type === 'Marlin' ? doc.marlin : doc.grbl) ?? {}) as Record<string, unknown>
  const adv = (doc.advanced ?? {}) as Record<string, unknown>
  const servo = pen.type === 'Servo'
  switch (key) {
    case 'feed_rate':
      return st.feedRate ?? 1500
    case 'jog_speed':
      return st.jogSpeed ?? 2500
    case 'pen_down_z':
      return servo ? pen.penDownPos : (pen.zOn ?? pen.penDownMM ?? 8)
    case 'pen_up_z':
      return servo ? pen.penUpPos : (pen.zOff ?? pen.penUpMM ?? 0)
    case 'z_speed':
      return pen.zSpeed ?? 5000
    case 'tool_on_delay':
      return st.toolOnDelay ?? 0
    case 'tool_off_delay':
      return st.toolOffDelay ?? 0
    case 'optimize':
      return false
    case 'near_dst':
      return st.nearDst ?? 0.3
    case 'simplify':
      return 0
    case 'copies':
      return 1
    case 'copy_gap_mm':
      return 10
    case 'copy_mode':
      return 'repeat_same'
    case 'start_gcode':
      return adv.startGcode ?? ''
    case 'end_gcode':
      return adv.endGcode ?? ''
    case 'multi_page':
      return 'separate_jobs'
    case 'stop_on_error':
      return true
    default:
      return null
  }
}

// ------------------------------------------------------------------ frame

export type FrameMode = 'up' | 'down_light' | 'corners'

export async function runFrame(bbox: number[], mode: FrameMode, feed?: number | null) {
  const m = useLive.getState().machine
  if (!m?.connected) {
    toast.error('先连接机器')
    return false
  }
  if (mode === 'down_light' && !(await confirm({ title: '落笔画外框？', description: '笔会轻触纸面画出包围盒（试纸用）。请确认纸张已放好。', confirmLabel: '开始画框' }))) return false
  useFraming.set(bbox)
  try {
    await api.post('/machine/frame', { bbox_mm: bbox, feed: feed ?? null, z: mode === 'down_light' ? 'down_light' : 'up', corners_only: mode === 'corners' }, { timeoutMs: 180_000 })
    toast.success('走边框完成')
    return true
  } catch (e) {
    toast.error('走边框失败', { description: errorMessage(e) })
    return false
  } finally {
    useFraming.set(null)
  }
}

/** Tiny observable for "framing in progress" (canvas highlight). */
export const useFraming = (() => {
  let cur: number[] | null = null
  const ls = new Set<() => void>()
  return {
    get: () => cur,
    set: (b: number[] | null) => {
      cur = b
      ls.forEach((l) => l())
    },
    sub: (l: () => void) => {
      ls.add(l)
      return () => ls.delete(l)
    },
  }
})()

// ------------------------------------------------------------------ jobs

export interface StartOptions {
  result: RenderResult
  pages: number[]
  name: string
  profileId: string | null
  overrides: PrintOverrides | null
  start: boolean
  /** Admin already confirmed printing beyond the work area. */
  allowOutOfBounds?: boolean
  /** Checklist「纸张和笔已就位：笔已抬起，停在原点位置」was ticked → POST …/start {pen_up_confirmed:true}. */
  penUpConfirmed?: boolean
}

/**
 * Create one queued job per output page, then start the first through the start guard
 * (pen_unknown → 「笔已抬起，开始」 retries with pen_up_confirmed; out_of_work_area → server issues / admin override;
 * job_active → stays queued).
 * Creating with start:false first means a refused start never leaves a duplicate job behind.
 */
export async function createJobs(o: StartOptions): Promise<Job[]> {
  const s = useStudio.getState()
  const jobs: Job[] = []
  for (let i = 0; i < o.pages.length; i++) {
    const idx = o.pages[i]
    const body = {
      source: { render_id: o.result.rid, page: idx, project_id: s.project?.id ?? null },
      name: o.pages.length > 1 ? `${o.name} 第${idx + 1}页` : o.name,
      profile_id: o.profileId,
      overrides: o.overrides,
      start: false,
    }
    jobs.push(await api.post<Job>('/jobs', body, { timeoutMs: 120_000, idempotencyKey: true }))
  }
  if (o.start && jobs[0]) {
    try {
      const started = await guardStart(
        ({ allowOutOfBounds, penUpConfirmed }) =>
          api.post<Job>(`/jobs/${jobs[0].id}/start`, {
            ...(allowOutOfBounds ? { allow_out_of_bounds: true } : {}),
            ...(penUpConfirmed ? { pen_up_confirmed: true } : {}),
          }),
        { allowOutOfBounds: !!o.allowOutOfBounds, penUpConfirmed: !!o.penUpConfirmed },
      )
      if (started) jobs[0] = started
    } catch (e) {
      if (isApiError(e) && e.status === 409 && e.code === 'job_active') {
        toast.info('已有任务在运行，新任务已加入队列', { description: '当前任务完成后，可在任务页开始。' })
      } else throw e
    }
  }
  void queryClient.invalidateQueries({ queryKey: qk.jobs.all })
  return jobs
}
