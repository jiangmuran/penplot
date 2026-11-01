/**
 * Starting a job safely (04 §5, jobs.start): turns the start-time 409s into guided dialogs.
 *
 *   const job = await startJobGuarded(id)          // null = the user cancelled
 *   await guardStart((o) => api.post(`/jobs/${id}/start`, { allow_out_of_bounds: o.allowOutOfBounds }))
 *
 * - 409 `pen_unknown`  → ask the user to make sure the pen is UP and parked at the top-left of the content,
 *                        then retry with `pen_up_confirmed: true` (the start-time zero then includes Z) —
 *                        one click: 「笔已抬起，开始」.
 * - 409 `out_of_work_area` → list the server's `detail.issues` (travel is only checked server-side and only when the
 *                        profile has a travel area); admins get 「仍然打印」 (retries with allow_out_of_bounds).
 * No client-side travel verdict here: work_area 0×0 = travel not configured and never blocks.
 * Other errors are rethrown (callers toast them via describeError).
 */
import { confirm } from '@/lib/confirm'
import { api, isApiError } from './client'
import { queryClient, qk } from './query'
import type { AuthState, Job } from './types'

function isAdmin() {
  const a = queryClient.getQueryData<AuthState>(qk.auth.state)
  return a?.role ? a.role === 'admin' : true // single-user backends: the admin
}

export interface StartFlags {
  allowOutOfBounds: boolean
  /** The operator confirmed the pen is up (Z rest) and parked at the start point → start-time zero includes Z. */
  penUpConfirmed: boolean
}

export async function guardStart<T>(attempt: (o: StartFlags) => Promise<T>, init: Partial<StartFlags> = {}): Promise<T | null> {
  let allowOutOfBounds = !!init.allowOutOfBounds
  let penUpConfirmed = !!init.penUpConfirmed
  for (let round = 0; round < 4; round++) {
    try {
      return await attempt({ allowOutOfBounds, penUpConfirmed })
    } catch (e) {
      if (!isApiError(e) || e.status !== 409) throw e
      if (e.code === 'pen_unknown' && !penUpConfirmed) {
        const ok = await confirm({
          title: '笔已经抬起了吗？',
          description: '写字机刚连接或复位过，不知道笔现在有多高。确认笔已抬起后开始：开始时会把现在的位置设为原点（含笔高）。',
          items: ['笔尖离开纸面，停在抬笔的静止位置', '笔停在要写内容的左上角（作品的起点）上方', '如果笔还压在纸上：到「控制」页点 Z↑ 把笔抬起来，再回来点开始'],
          confirmLabel: '笔已抬起，开始',
        })
        if (!ok) return null
        penUpConfirmed = true
        continue
      }
      if (e.code === 'out_of_work_area') {
        const issues = ((e.detail as { issues?: string[] } | null)?.issues ?? []).filter(Boolean)
        const admin = isAdmin()
        const ok = await confirm({
          title: '这个任务可能不安全，已阻止开始',
          description: admin
            ? '写字机检查出下面的问题。请调整位置或纸张；只有确定设置有误时才「仍然打印」。'
            : '写字机检查出下面的问题。请调整位置或纸张，或请管理员处理。',
          items: issues.length ? issues : ['作品可能画到纸外，或含有不安全的指令'],
          confirmLabel: '仍然打印',
          destructive: true,
          alertOnly: !admin,
        })
        if (!ok || !admin) return null
        allowOutOfBounds = true
        continue
      }
      throw e
    }
  }
  return null
}

/** POST /jobs/{id}/start with the guard. Returns null when the user cancelled. */
export function startJobGuarded(id: string, body: { set_zero?: boolean; pen_up_confirmed?: boolean } = {}) {
  return guardStart(
    ({ allowOutOfBounds, penUpConfirmed }) =>
      api.post<Job>(`/jobs/${id}/start`, {
        ...body,
        ...(allowOutOfBounds ? { allow_out_of_bounds: true } : {}),
        ...(penUpConfirmed ? { pen_up_confirmed: true } : {}),
      }),
    { penUpConfirmed: !!body.pen_up_confirmed },
  )
}
