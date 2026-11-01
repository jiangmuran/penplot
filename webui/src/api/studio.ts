/**
 * Studio (创作台) API layer: types for the composition model + render / import / job helpers.
 * Shapes: docs/design/03-backend.md §3.3–3.5, §4.3/4.4/4.6 and 04-contract-notes.md §6–9.
 */
import { api, ApiError, isApiError } from './client'
import type { components } from './schema'
import { useLive } from './store'
import type { Task, TaskRef } from './types'

type S = components['schemas']

export type ProjectDoc = S['ProjectDoc']
export type Project = S['Project']
export type ProjectSummary = S['ProjectSummary']
export type ProjectImportResult = S['ProjectImportResult']
export type DocPage = S['Page']
export type Element = DocPage['elements'][number]
export type ElementType = Element['type']
export type TextElement = S['TextElement']
export type FlowTextElement = S['FlowTextElement']
export type ImageElement = S['ImageElement']
export type SvgElement = S['SvgElement']
export type DxfElement = S['DxfElement']
export type ShapeElement = S['ShapeElement']
export type GcodeElement = S['GcodeElement']
export type Transform = S['Transform']
export type Jitter = S['Jitter']
export type Paragraph = S['Paragraph']
export type PaperRef = S['PaperRef']
export type PaperBase = S['PaperBase']
export type PaperSpec = S['PaperSpec']
export type Margins = S['Margins']
export type Ruling = S['Ruling']
export type OriginSpec = S['OriginSpec']
export type PrintOverrides = S['PrintOverrides']
export type Variable = S['Variable']
export type RenderResult = S['RenderResult']
export type RenderPage = S['RenderPage']
export type RenderRequest = S['RenderRequest']
export type RenderExport = S['RenderExport']
export type Profile = S['Profile']
export type ProfileDoc = S['ProfileDoc']
export type FontSummary = S['FontSummary']
export type FileInfo = S['FileInfo']
export type VectorImportResult = S['VectorImportResult']
export type ImageImportResult = S['ImageImportResult']
export type GcodeImportResult = S['GcodeImportResult']
export type TextImportResult = S['TextImportResult']
export type AppSettings = S['AppSettings']
export type JobCreate = S['JobCreate']
export type Job = S['Job']

// ------------------------------------------------------------------ tasks / long work

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('aborted', 'AbortError'))
    })
  })

function isTaskRef(x: unknown): x is TaskRef {
  return !!x && typeof x === 'object' && 'task_id' in x && !('rid' in x)
}

/** Poll a task until it finishes; returns its result or throws an ApiError. */
export interface TaskWatch {
  /** latest task snapshot (progress 0..1, message) while waiting */
  onProgress?: (t: Task) => void
  /** called once with the task id of a 202 answer (e.g. to cancel it) */
  onTask?: (taskId: string) => void
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

/** Wait up to `ms`, waking early when the WebSocket reports `taskId` finished. */
function nextTaskChange(taskId: string, ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    let unsub = () => {}
    const finish = () => {
      clearTimeout(timer)
      unsub()
      signal?.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      finish()
      resolve()
    }, ms)
    const onAbort = () => {
      finish()
      reject(new DOMException('aborted', 'AbortError'))
    }
    unsub = useLive.subscribe((s, prev) => {
      const t = s.tasks[taskId]
      if (t && t !== prev.tasks[taskId] && TERMINAL.has(t.state)) {
        finish()
        resolve()
      }
    })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Wait for a task. The WS `task` event (with the result) normally ends the wait the moment the task
 * finishes; HTTP polling is only the fallback (every 3 s while the socket is up). Fixed 250 ms→1 s
 * polling used to add up to a second (plus a WiFi round trip) to every slow render.
 */
export async function waitTask<T>(taskId: string, signal?: AbortSignal, timeoutMs = 180_000, watch: TaskWatch = {}): Promise<T> {
  const t0 = Date.now()
  let delay = 250
  // cancelling the wait also cancels the server task (best effort)
  const onAbort = () => void api.delete(`/tasks/${taskId}`).catch(() => undefined)
  signal?.addEventListener('abort', onAbort, { once: true })
  // progress straight from the WS events (the HTTP poll is now rare)
  const unsubProgress = watch.onProgress
    ? useLive.subscribe((s, prev) => {
        const t = s.tasks[taskId]
        if (t && t !== prev.tasks[taskId] && !TERMINAL.has(t.state)) watch.onProgress?.(t)
      })
    : () => {}
  const settle = (t: Task): T | undefined => {
    if (t.state === 'done') return t.result as T
    if (t.state === 'failed') throw new ApiError(500, t.error?.code ?? 'task_failed', t.error?.message ?? '任务失败', t.error?.detail)
    if (t.state === 'cancelled') throw new DOMException('cancelled', 'AbortError')
    return undefined
  }
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const live = useLive.getState().tasks[taskId]
      if (live && TERMINAL.has(live.state) && (live.state !== 'done' || live.result != null)) {
        watch.onProgress?.(live)
        return settle(live) as T
      }
      let t: Task
      try {
        t = await api.get<Task>(`/tasks/${taskId}`, { signal })
      } catch (e) {
        // a dropped link while polling: keep waiting (the task keeps running on the device)
        if (isApiError(e) && e.isOffline && Date.now() - t0 < timeoutMs) {
          await sleep(2000, signal)
          continue
        }
        throw e
      }
      watch.onProgress?.(t)
      const r = settle(t)
      if (r !== undefined || t.state === 'done') return r as T
      if (Date.now() - t0 > timeoutMs) throw new ApiError(0, 'render_timeout', '处理超时')
      // the long fallback interval only once the socket is up AND reports this task (quiet tasks send no events)
      const ls = useLive.getState()
      const wsTracks = ls.conn === 'open' && !!ls.tasks[taskId]
      await nextTaskChange(taskId, wsTracks ? 3000 : delay, signal)
      delay = Math.min(1000, delay * 1.4)
    }
  } finally {
    unsubProgress()
    signal?.removeEventListener('abort', onAbort)
  }
}

/** POST a `?wait=` endpoint and resolve the final result (following a 202 task ref). */
export async function postAndWait<T>(
  path: string,
  body: unknown,
  opts: { signal?: AbortSignal; slot?: string; wait?: number; timeoutMs?: number } & TaskWatch = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts.slot) headers['X-Render-Slot'] = opts.slot
  const r = await api.post<T | TaskRef>(path, body, { query: { wait: opts.wait ?? 8 }, signal: opts.signal, headers, timeoutMs: 60_000 })
  if (isTaskRef(r)) {
    opts.onTask?.(r.task_id)
    return waitTask<T>(r.task_id, opts.signal, opts.timeoutMs, opts)
  }
  return r as T
}

// ------------------------------------------------------------------ render

export function renderProject(projectId: string, body: Partial<RenderRequest> & { doc?: ProjectDoc }, opts: { signal?: AbortSignal; slot?: string; timeoutMs?: number } & TaskWatch = {}) {
  const req = { pages: 'all', variables: {}, ...body }
  return postAndWait<RenderResult>(`/projects/${projectId}/render`, req, opts)
}

/** Polylines decoded from the `PPL1` binary (04 §6). Each entry is a flat [x0,y0,x1,y1,…] array in mm. */
export type Polylines = Float32Array[]

export function decodePaths(buf: ArrayBuffer): Polylines {
  const dv = new DataView(buf)
  if (buf.byteLength < 8 || dv.getUint32(0, true) !== 0x314c5050) throw new Error('bad paths magic')
  const n = dv.getUint32(4, true)
  const offs = new Uint32Array(n + 1)
  for (let i = 0; i <= n; i++) offs[i] = dv.getUint32(8 + i * 4, true)
  const base = 8 + (n + 1) * 4
  const total = offs[n]
  const xy = new Float32Array(buf.slice(base, base + total * 8))
  const out: Polylines = []
  for (let k = 0; k < n; k++) out.push(xy.subarray(offs[k] * 2, offs[k + 1] * 2))
  return out
}

export async function fetchPaths(rid: string, index: number, space: 'page' | 'machine' = 'page', signal?: AbortSignal): Promise<Polylines> {
  const res = await api.get<Response>(`/render/${rid}/pages/${index}/paths`, { query: { space }, raw: true, signal, headers: { Accept: 'application/octet-stream' } })
  return decodePaths(await res.arrayBuffer())
}

// ------------------------------------------------------------------ downloads

export function filenameFromResponse(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') ?? ''
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd)
  if (star) {
    try {
      return decodeURIComponent(star[1].replace(/"/g, ''))
    } catch {
      /* ignore */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd)
  return plain ? plain[1] : fallback
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** POST /render/{rid}/export and download the file (follows a 202 task to its result file). */
export async function exportRender(rid: string, body: RenderExport, fallbackName: string) {
  const res = await api.post<Response>(`/render/${rid}/export`, body, { raw: true, timeoutMs: 120_000, headers: { Accept: '*/*' } })
  if (res.status === 202) {
    const ref = (await res.json()) as TaskRef
    const result = await waitTask<{ file_id?: string; name?: string }>(ref.task_id)
    if (result?.file_id) {
      const f = await api.get<Response>(`/files/${result.file_id}/content`, { raw: true, headers: { Accept: '*/*' } })
      saveBlob(await f.blob(), result.name ?? fallbackName)
      return
    }
    throw new ApiError(500, 'export_failed', '导出失败')
  }
  saveBlob(await res.blob(), filenameFromResponse(res, fallbackName))
}

export async function downloadProjectJson(projectId: string, name: string) {
  const res = await api.get<Response>(`/projects/${projectId}/export`, { raw: true, headers: { Accept: '*/*' } })
  saveBlob(await res.blob(), filenameFromResponse(res, `${name}.penplot.json`))
}

// ------------------------------------------------------------------ imports

export type ImportKind = 'svg' | 'dxf' | 'image' | 'gcode' | 'text'

export function importKindFor(name: string): ImportKind | null {
  const n = name.toLowerCase()
  if (n.endsWith('.svg')) return 'svg'
  if (n.endsWith('.dxf')) return 'dxf'
  if (/\.(png|jpe?g|webp)$/.test(n)) return 'image'
  if (/\.(gcode|nc|gco)$/.test(n)) return 'gcode'
  if (n.endsWith('.txt')) return 'text'
  return null
}

export type ImportResult =
  | { kind: 'svg' | 'dxf'; name: string; data: VectorImportResult }
  | { kind: 'image'; name: string; data: ImageImportResult }
  | { kind: 'gcode'; name: string; data: GcodeImportResult }
  | { kind: 'text'; name: string; data: TextImportResult }

export async function importFile(file: File): Promise<ImportResult> {
  const kind = importKindFor(file.name)
  if (!kind) throw new ApiError(400, 'unsupported', `不支持的文件类型：${file.name}`)
  const fd = new FormData()
  fd.append('file', file, file.name)
  const data = await api.post<never>(`/import/${kind}`, fd, { timeoutMs: 180_000 })
  return { kind, name: file.name, data } as ImportResult
}
