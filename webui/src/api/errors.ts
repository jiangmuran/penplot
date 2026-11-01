/**
 * Human Chinese error descriptions (05-review §3.10: 发生了什么 + 为什么/怎么办; codes go to 技术详情).
 *
 *   const d = describeError(err)
 *   toast.error(d.title, { description: d.hint })
 *   <ErrorState error={err} />        // uses describeError internally
 *
 * Never show a raw HTTP status to the user; `d.technical` carries code/status for the details pane.
 */
import { ApiError } from './client'

export interface ErrorDescription {
  /** One line: what happened. */
  title: string
  /** Why / what to do next (may be undefined). */
  hint?: string
  /** Stable code (`machine_busy`, `network`, …) for logic. */
  code: string
  /** HTTP status (0 = network); undefined for non-API errors. */
  status?: number
  /** "code · HTTP 409 · detail…" for a collapsible 技术详情. */
  technical?: string
}

type Entry = { title: string; hint?: string }

/** Known backend codes (03 §4, 04 §1, penplot/web). Server messages are used when the code is unknown. */
const CODES: Record<string, Entry> = {
  network: { title: '无法连接到写字机', hint: '请确认设备已开机、与本机在同一网络，然后重试。' },
  timeout: { title: '设备响应超时', hint: '网络可能不稳定，请稍后重试。' },
  job_active: { title: '已有任务正在进行', hint: '等当前任务写完，或先停止它，再开始新的任务。' },
  machine_busy: { title: '机器正在忙', hint: '任务进行中不能手动操作；先暂停任务，等机器空闲后再试。' },
  origin_invalid: { title: '原点已失效', hint: '机器复位过，坐标已丢失：请抬笔，把笔移到要写内容的左上角，再重新设原点。' },
  port_busy: { title: '串口被占用', hint: '可能有其他程序（或另一个 PenPlot）正在使用写字机，关闭它后重试。' },
  port_not_found: { title: '找不到写字机', hint: '检查 USB 线是否插好、写字机是否通电，然后重新扫描。' },
  connect_failed: { title: '连接写字机失败', hint: '检查 USB 线与电源，或在控制页换一个串口重试。' },
  connecting: { title: '正在连接写字机', hint: '请稍候几秒再试。' },
  machine_disconnected: { title: '写字机未连接', hint: '到「控制」页连接写字机后再试。' },
  not_connected: { title: '写字机未连接', hint: '到「控制」页连接写字机后再试。' },
  no_response: { title: '写字机没有应答', hint: '检查 USB 线和电源；必要时在控制页断开后重新连接。' },
  alarm_locked: { title: '写字机处于报警锁定', hint: '先解锁（$X），确认笔已抬起，再继续。' },
  setup_required: { title: '需要先完成初始设置', hint: '请先创建管理员账户。' },
  already_setup: { title: '已经完成初始设置', hint: '请直接登录。' },
  rate_limited: { title: '尝试次数过多', hint: '为了安全暂时锁定，请稍后再试。' },
  bad_password: { title: '密码不正确' },
  unauthorized: { title: '登录已过期', hint: '请重新登录。' },
  forbidden: { title: '没有权限执行此操作', hint: '请让管理员为你开通权限。' },
  csrf: { title: '请求被拒绝', hint: '页面可能已过期，请刷新后重试。' },
  csrf_origin: { title: '请求被拒绝', hint: '请从写字机的地址直接打开此页面。' },
  feature_unavailable: { title: '此功能尚不可用', hint: '设备上没有安装该功能所需的组件。' },
  not_found: { title: '找不到这项内容', hint: '它可能已被删除，请刷新列表。' },
  render_expired: { title: '预览已过期', hint: '请重新生成预览。' },
  rev_conflict: { title: '内容已在别处被修改', hint: '刷新以获取最新版本，或另存为副本。' },
  element_locked: { title: '这个元素正被其他人编辑', hint: '等对方完成后再修改。' },
  lease_held: { title: '机器控制权在别人手上', hint: '请对方释放控制权，或由管理员接管。' },
  lease_required: { title: '需要先获取机器控制权', hint: '在工具栏的控制权按钮里获取后再操作。' },
  teletype_active: { title: '电传打字机正在使用写字机', hint: '先结束电传会话再试。' },
  in_use: { title: '正在被使用，无法删除', hint: '有排队或进行中的任务引用了它。' },
  builtin: { title: '内置内容不能修改', hint: '内置模板和纸张是只读的：点「复制后编辑」得到一份自己的副本。' },
  pen_unknown: { title: '笔的高度未知', hint: '写字机刚连接或复位过：确认笔已抬起、停在要写内容的左上角，点「笔已抬起，开始」。' },
  out_of_work_area: { title: '任务可能不安全，已阻止开始', hint: '作品超出机器行程或含有危险指令，请调整位置或纸张。' },
  unsafe_gcode: { title: 'G 代码里有不能发送的指令', hint: '请删除或修改这一行后再试。' },
  unauthenticated: { title: '登录已失效', hint: '请重新登录。' },
  teletype_unavailable: { title: '电传打字机不可用' },
  bundled: { title: '内置字体不能删除', hint: '可以将它隐藏。' },
  profile_active: { title: '不能删除正在使用的机器配置', hint: '先切换到其他配置。' },
  last_admin: { title: '至少需要保留一个管理员' },
  self_delete: { title: '不能删除自己的账户' },
  username_taken: { title: '用户名已被使用' },
  bad_state: { title: '当前状态不允许此操作', hint: '刷新后再试。' },
  no_job: { title: '没有进行中的任务' },
  batch_done: { title: '这一批已经全部写完' },
  need_paper: { title: '请先换纸', hint: '放好新纸后点「继续下一页」。' },
  zero_failed: { title: '设原点失败', hint: '确认写字机已连接且空闲后重试。' },
  homing_failed: { title: '归位失败', hint: '本机没有限位开关时不要使用归位（$H）。' },
  pen_failed: { title: '抬落笔失败', hint: '确认写字机已连接且空闲后重试。' },
  command_failed: { title: '命令执行失败' },
  grbl_set_failed: { title: '写入固件参数失败', hint: '确认写字机空闲后重试。' },
  prepare_failed: { title: '任务准备失败' },
  no_profile: { title: '还没有机器配置', hint: '到 设置 › 机器配置 新建一个。' },
  too_large: { title: '文件太大' },
  too_complex: { title: '内容太复杂', hint: '请简化图形或减少页数。' },
  disk_full: { title: '设备存储空间不足', hint: '到「系统」页清理历史与文件。' },
  render_timeout: { title: '生成时间过长', hint: '内容可能太复杂，请稍后重试或减少元素。' },
  validation_error: { title: '填写的内容有误' },
  cancelled: { title: '已取消' },
}

const STATUS: Record<number, Entry> = {
  0: CODES.network,
  400: { title: '请求无效' },
  401: CODES.unauthorized,
  403: CODES.forbidden,
  404: CODES.not_found,
  409: { title: '当前状态不允许此操作', hint: '刷新后再试。' },
  413: CODES.too_large,
  422: CODES.validation_error,
  423: CODES.setup_required,
  429: CODES.rate_limited,
  500: { title: '设备内部出错', hint: '请重试；如果反复出现，请到「系统」页查看日志。' },
  501: CODES.feature_unavailable,
  502: { title: '连接中断', hint: '与设备的网络暂时断开，恢复后会自动重连，请稍后再试。' },
  503: { title: '设备暂时不可用', hint: '写字机可能未连接，请稍后重试。' },
  504: CODES.timeout,
  507: CODES.disk_full,
}

/** Server messages that are just a status/code echo and should not be shown verbatim. */
function isRawMessage(m: string | undefined) {
  return !m || /^(HTTP\s*)?\d{3}\b|^[A-Za-z_ ]+$|请求失败（\d{3}）/.test(m.trim())
}

function validationHint(detail: unknown): string | undefined {
  if (!Array.isArray(detail)) return undefined
  const msgs = detail
    .map((d) => {
      const loc = Array.isArray(d?.loc) ? d.loc.filter((x: unknown) => x !== 'body').join('.') : ''
      return loc ? `${loc}：${d?.msg ?? ''}` : d?.msg
    })
    .filter(Boolean)
  return msgs.length ? msgs.slice(0, 3).join('；') : undefined
}

export function describeError(err: unknown): ErrorDescription {
  if (err instanceof ApiError) {
    const known = CODES[err.code] ?? (err.code.startsWith('http_') ? undefined : undefined)
    const byStatus = STATUS[err.status]
    const serverMsg = isRawMessage(err.message) ? undefined : err.message
    let title = known?.title ?? serverMsg ?? byStatus?.title ?? '操作没有完成'
    let hint = known?.hint ?? (known ? undefined : byStatus?.hint)
    // Keep a specific Chinese server message as the hint when our title is generic.
    if (known && serverMsg && serverMsg !== known.title && !hint) hint = serverMsg
    if (err.code === 'validation_error' || err.status === 422) hint = validationHint(err.detail) ?? hint
    if (err.code === 'rate_limited' && err.retryAfter) hint = `请 ${Math.ceil(err.retryAfter)} 秒后再试。`
    if (err.code === 'lease_held') {
      const h = (err.detail as { holder?: { display_name?: string; username?: string } } | null)?.holder
      if (h) title = `机器控制权在 ${h.display_name || h.username} 手上`
    }
    if (err.code === 'unsafe_gcode') {
      const d = err.detail as { line?: number; text?: string; reason?: string } | null
      if (d?.line) {
        title = `第 ${d.line} 行 G 代码不能发送`
        hint = [d.reason, d.text ? `「${d.text}」` : null, '请删除或修改这一行后再试。'].filter(Boolean).join(' · ')
      } else if (serverMsg) hint = serverMsg
    }
    if (err.code === 'out_of_work_area') {
      const issues = (err.detail as { issues?: string[] } | null)?.issues
      if (issues?.length) hint = issues.join('；')
    }
    let det = ''
    try {
      det = err.detail === undefined ? '' : ` · ${typeof err.detail === 'string' ? err.detail : JSON.stringify(err.detail)}`
    } catch {
      det = ''
    }
    return {
      title,
      hint,
      code: err.code,
      status: err.status,
      technical: `${err.code}${err.status ? ` · HTTP ${err.status}` : ''}${det}${serverMsg && serverMsg !== title ? ` · ${serverMsg}` : ''}`,
    }
  }
  // Task errors ({code, message, detail}) and WS ack errors look like ApiErrors without a status.
  const o = err as { code?: string; message?: string; detail?: unknown } | null
  if (o && typeof o === 'object' && !(err instanceof Error) && typeof o.code === 'string') {
    return describeError(new ApiError(400, o.code, o.message ?? '', o.detail))
  }
  const code = o?.code
  if (code && CODES[code]) return { ...CODES[code], code, technical: String((err as Error).message ?? '') }
  if (err instanceof Error) {
    if (/Failed to fetch|NetworkError|Load failed/i.test(err.message)) return { ...CODES.network, code: 'network', technical: err.message }
    return { title: '出现了意外错误', hint: '请重试；如果反复出现，请刷新页面。', code: 'client_error', technical: `${err.name}: ${err.message}` }
  }
  return { title: '出现了意外错误', code: 'unknown', technical: String(err) }
}

/** One-line message: "标题。提示" — for places with a single text slot. */
export function describeErrorText(err: unknown): string {
  const d = describeError(err)
  return d.hint ? `${d.title}。${d.hint}` : d.title
}
