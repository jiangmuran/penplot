/**
 * Plain-Chinese errors for the machine / jobs pages (review §3.10: 发生了什么 + 怎么办, codes go to 技术详情).
 * Drop-in replacement for `runAction` from '@/api/machine' that never shows raw HTTP codes.
 * Delegates to the shell's `describeError(err)`; the local table is a fallback.
 */
import { isApiError } from '@/api/client'
import { describeError } from '@/api/errors'
import { toast } from '@/lib/toast'

const BY_CODE: Record<string, string> = {
  machine_busy: '机器正在写字，手动操作要等任务暂停或结束后再做。',
  job_active: '有任务正在进行，先暂停或停止它。',
  origin_invalid: '原点已经失效（控制板复位过）。先抬笔，把笔移回原来的起点并设为原点，再续写。',
  machine_disconnected: '写字机没有连接。到「控制」页连接后再试。',
  port_busy: '串口被别的程序占用了。关掉其他使用写字机的软件后再连接。',
  lease_held: '控制权在别人手里。请对方释放，或由管理员接管。',
  bad_state: '当前状态不允许这个操作。',
  empty_macro: '这个宏还没有内容。到 设置 › 机器配置 › 宏 里填写。',
  in_use: '它正在被任务使用，暂时不能删除。',
  timeout: '设备没有及时回应，可能是 WiFi 不稳定。稍后再试。',
  network: '连不上写字机所在的设备。检查网络后再试。',
  forbidden: '你的账户没有这个权限。',
  unauthenticated: '登录已过期，请重新登录。',
}

export function friendlyError(e: unknown): { message: string; detail?: string } {
  const d = describeError(e)
  if (d.title) return { message: d.hint ? `${d.title}：${d.hint}` : d.title, detail: d.technical }
  if (isApiError(e)) {
    const known = BY_CODE[e.code]
    const detail = `${e.code}${e.status ? ` · HTTP ${e.status}` : ''}${e.message && known ? ` · ${e.message}` : ''}`
    if (known) return { message: known, detail }
    // server messages are already Chinese; just strip codes like "409" if present
    return { message: e.message.replace(/\b[1-5]\d\d\b\s*/g, '').trim() || '操作没有成功。', detail }
  }
  const code = (e as { code?: string })?.code
  if (code && BY_CODE[code]) return { message: BY_CODE[code], detail: code }
  return { message: e instanceof Error ? e.message : String(e) }
}

/** Run an action, toasting a friendly failure. Returns true on success. */
export async function runAction(title: string, fn: () => Promise<unknown>, success?: string): Promise<boolean> {
  try {
    await fn()
    if (success) toast.success(success)
    return true
  } catch (e) {
    const f = friendlyError(e)
    toast.error(title, { description: f.message, key: title })
    return false
  }
}
