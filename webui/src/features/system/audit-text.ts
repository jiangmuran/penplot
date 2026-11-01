/** Audit entries as plain sentences (05-review §2.6): 「张老师 创建了只读 Token “t1”」. */
import type { AuditEntry } from '@/api/system'

const SCOPE: Record<string, string> = { read: '只读', control: '可控制', admin: '管理员' }

type D = Record<string, unknown>
const q = (v: unknown) => `“${String(v)}”`

export function auditActor(actor: string): string {
  if (actor === 'setup') return '首次设置'
  if (actor === 'cli') return '命令行'
  if (actor === 'system') return '系统'
  if (actor === 'session' || actor === 'admin') return '管理员'
  if (actor.startsWith('ip:')) return `来自 ${actor.slice(3)}`
  if (actor.startsWith('user:')) return `用户 ${actor.slice(5)}`
  if (actor.startsWith('token:')) return `Token ${actor.slice(6)}`
  return actor
}

function scopes(v: unknown) {
  const s = Array.isArray(v) ? (v as string[]) : []
  if (s.includes('admin')) return '管理员'
  if (s.includes('control')) return '可控制'
  return s.length ? SCOPE[s[0]] ?? s.join('、') : ''
}

export function auditSentence(a: AuditEntry): string {
  const d = (a.detail && typeof a.detail === 'object' ? a.detail : {}) as D
  switch (a.action) {
    case 'admin_setup':
      return `创建了管理员账户${d.username ? ` ${q(d.username)}` : ''}`
    case 'login':
      return '登录了'
    case 'login_fail':
      return `登录失败${d.username ? `（账户 ${q(d.username)}）` : ''}`
    case 'logout':
      return '退出了登录'
    case 'password_change':
      return '修改了自己的密码'
    case 'password_reset':
    case 'user_password_reset':
      return `重置了${d.username ? ` ${q(d.username)} ` : '用户'}的密码`
    case 'token_create':
      return `创建了${scopes(d.scopes)} Token${d.name ? ` ${q(d.name)}` : ''}`
    case 'token_revoke':
      return `吊销了 Token${d.name ? ` ${q(d.name)}` : ''}`
    case 'user_create':
      return `添加了用户 ${q(d.username)}`
    case 'user_update':
      return d.disabled ? '停用了一个用户' : `修改了用户设置${d.role ? `（角色改为 ${String(d.role)}）` : ''}`
    case 'user_delete':
      return `删除了用户 ${q(d.username)}`
    case 'restart':
      return d.force ? '强制重启了服务' : '重启了服务'
    case 'profile_activate':
      return `切换了机器配置${d.id ? ` ${q(d.id)}` : ''}`
    case 'lease_take':
      return '取得了机器控制权'
    case 'lease_release':
      return d.reason === 'idle' ? `${d.holder ? `${q(d.holder)} ` : ''}长时间未操作，控制权已自动释放` : '释放了机器控制权'
    case 'soft_reset':
      return '软复位了控制板'
    case 'raw_cmd':
      return `在调试台发送了 ${d.line ? `\`${String(d.line)}\`` : '命令'}`
    case 'grbl_set': {
      const n = d.changes && typeof d.changes === 'object' ? Object.keys(d.changes as object).length : 0
      const failed = Array.isArray(d.failed) && d.failed.length ? `，${(d.failed as unknown[]).length} 项失败` : ''
      return `写入了 ${n} 项 GRBL 参数${failed}`
    }
    case 'estop':
      return d.kept_origin === false ? '按下了急停（原点已丢失）' : '按下了急停'
    case 'job_start':
      return `开始了任务${d.job_id ? ` ${String(d.job_id)}` : ''}`
    case 'teletype_start':
      return '开始了打字机模式'
    case 'teletype_stop':
      return '结束了打字机模式'
    case 'terminal_start':
    case 'terminal_attach':
      return '打开了服务器终端'
    default:
      return a.action.replace(/_/g, ' ')
  }
}
