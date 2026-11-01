/**
 * File transfer helpers (pages-agent addition).
 *
 *   await downloadFrom('/jobs/j1/gcode', 'job.gcode')            // GET → save
 *   await downloadFrom('/fonts/x/convert', 'x.psf', { method: 'POST', body: { to: 'psf' } })
 *   saveBlob(new Blob([text]), 'log.txt')
 *   const file = await pickFile('.json,.zip')
 */
import { request, type RequestOptions } from './client'

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function saveText(text: string, filename: string, mime = 'text/plain;charset=utf-8') {
  saveBlob(new Blob([text], { type: mime }), filename)
}

/** Name from `Content-Disposition` (RFC 5987 `filename*` first). */
export function filenameFromResponse(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') ?? ''
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd)
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd)
  return plain ? plain[1] : fallback
}

/** Fetch with the API client (auth, CSRF, errors) and save the body as a file. */
export async function downloadFrom(path: string, fallbackName: string, opts: RequestOptions = {}) {
  const res = await request<Response>(path, { timeoutMs: 120_000, ...opts, raw: true, headers: { Accept: '*/*', ...(opts.headers as object) } })
  const blob = await res.blob()
  saveBlob(blob, filenameFromResponse(res, fallbackName))
}

/** Open the OS file picker. Resolves null when cancelled. */
export function pickFile(accept: string): Promise<File | null>
export function pickFile(accept: string, multiple: true): Promise<File[] | null>
export function pickFile(accept: string, multiple = false): Promise<File | File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    let done = false
    input.addEventListener('change', () => {
      done = true
      const files = input.files ? [...input.files] : []
      input.remove()
      resolve(files.length ? (multiple ? files : files[0]) : null)
    })
    input.addEventListener('cancel', () => {
      if (!done) resolve(null)
      input.remove()
    })
    document.body.appendChild(input)
    input.click()
  })
}

/** multipart body with a single `file` field plus extra form fields. */
export function formWithFile(file: File, fields: Record<string, string | number | boolean | null | undefined> = {}) {
  const fd = new FormData()
  fd.append('file', file, file.name)
  for (const [k, v] of Object.entries(fields)) if (v != null && v !== '') fd.append(k, String(v))
  return fd
}
