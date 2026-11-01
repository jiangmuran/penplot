/** 设置 › 账户与安全: change password, sessions, API tokens (03 §4.1, 04 §3). */
import { Check, Copy, KeyRound, Laptop, Monitor, Plus, Smartphone, Tablet, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { describeErrorText } from '@/api/errors'
import { ApiError } from '@/api/client'
import {
  changePassword, useCreateToken, useRevokeSession, useRevokeToken, useSessions, useTokens, type SessionInfo, type TokenCreated,
} from '@/api/profiles'
import { queryClient, qk } from '@/api/query'
import {
  Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField,
  FormRow, GroupedList, Input, Select, Skeleton, SkeletonList,
} from '@/components/ui'
import { isUnavailable, ROLE_LABEL, useMe } from '@/api/collab'
import { updateMe } from '@/api/users'
import { Avatar } from './users'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/cn'
import { formatRelative, toDate } from '@/lib/format'
import { toast } from '@/lib/toast'
import { PasswordInput } from '@/app/auth/password-input'
import { HelpLink } from '@/features/help/HelpLink'
import { QueryError } from './shared'

// ---------------- password ----------------
function PasswordCard() {
  const [oldPw, setOld] = React.useState('')
  const [newPw, setNew] = React.useState('')
  const [confirmPw, setConfirm] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [touched, setTouched] = React.useState(false)
  const tooShort = newPw.length > 0 && newPw.length < 10
  const mismatch = confirmPw.length > 0 && confirmPw !== newPw
  const canSubmit = oldPw && newPw.length >= 10 && confirmPw === newPw && !busy

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await changePassword(oldPw, newPw)
      setOld('')
      setNew('')
      setConfirm('')
      setTouched(false)
      toast.success('密码已修改', { description: '其他设备上的登录已退出。' })
      void queryClient.invalidateQueries({ queryKey: qk.auth.sessions })
    } catch (err) {
      setError(err instanceof ApiError && (err.status === 401 || err.code === 'bad_password') ? '当前密码不正确' : describeErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <GroupedList header="修改密码" footer="至少 10 个字符。修改后，其他设备上的会话会被注销。">
      <form onSubmit={submit} className="flex flex-col gap-3 px-4 py-4" noValidate>
        <input type="text" autoComplete="username" value="admin" readOnly hidden />
        <FormField label="当前密码" htmlFor="pw-old" error={error ?? undefined}>
          <PasswordInput id="pw-old" autoComplete="current-password" value={oldPw} onChange={(e) => setOld(e.currentTarget.value)} invalid={!!error} />
        </FormField>
        <FormField label="新密码" htmlFor="pw-new" error={(touched || newPw.length >= 1) && tooShort ? '至少需要 10 个字符' : undefined}>
          <PasswordInput id="pw-new" autoComplete="new-password" value={newPw} onChange={(e) => setNew(e.currentTarget.value)} invalid={tooShort && touched} />
        </FormField>
        <FormField label="确认新密码" htmlFor="pw-confirm" error={mismatch ? '两次输入的密码不一致' : undefined}>
          <PasswordInput id="pw-confirm" autoComplete="new-password" value={confirmPw} onChange={(e) => setConfirm(e.currentTarget.value)} invalid={mismatch} />
        </FormField>
        <div className="flex justify-end pt-1">
          <Button type="submit" variant="filled" loading={busy} disabled={!canSubmit}>
            修改密码
          </Button>
        </div>
      </form>
    </GroupedList>
  )
}

// ---------------- sessions ----------------
function parseUa(ua = ''): { label: string; icon: typeof Laptop } {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//.test(ua) ? 'curl' : /python/i.test(ua) ? 'Python' : null
  const os = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null
  const icon = os === 'iPad' ? Tablet : os === 'iPhone' || os === 'Android' ? Smartphone : browser === 'curl' || browser === 'Python' ? Monitor : Laptop
  const label = [browser, os].filter(Boolean).join(' · ') || ua.slice(0, 40) || '未知设备'
  return { label, icon }
}

function SessionsCard() {
  const sessions = useSessions()
  const revoke = useRevokeSession()
  const doRevoke = async (s: SessionInfo) => {
    const ok = await confirm({ title: '注销此会话？', description: '该设备需要重新登录。', confirmLabel: '注销', destructive: true })
    if (ok) await revoke.mutateAsync(s.id).then(() => toast.success('已注销会话')).catch(() => null)
  }
  const list = [...(sessions.data ?? [])].sort((a, b) => Number(!!b.current) - Number(!!a.current) || b.last_seen - a.last_seen)
  return (
    <section className="flex flex-col">
      {sessions.isPending ? (
        <SkeletonList rows={2} />
      ) : sessions.isError ? (
        <QueryError error={sessions.error} onRetry={() => void sessions.refetch()} what="会话管理" />
      ) : (
        <GroupedList header="登录会话" footer="浏览器关闭后会话仍保留，直到过期或被注销。">
          {list.map((s) => {
            const ua = parseUa(s.ua)
            const Icon = ua.icon
            return (
              <div key={s.id} className="flex min-h-14 items-center gap-3 py-1.5 pl-4 pr-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-fill text-secondary-label" aria-hidden>
                  <Icon className="size-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-body text-label">
                    <span className="truncate">{ua.label}</span>
                    {s.current ? <Badge tone="green">本设备</Badge> : null}
                  </p>
                  <p className="truncate text-footnote text-secondary-label tabular-nums" title={s.ua}>
                    {s.ip || '未知 IP'} · 活动于 {formatRelative(s.last_seen)} · {toDate(s.expires_at)?.toLocaleDateString('zh-CN')} 过期
                  </p>
                </div>
                {!s.current ? (
                  <Button size="sm" variant="destructive-plain" onClick={() => void doRevoke(s)}>
                    注销
                  </Button>
                ) : null}
              </div>
            )
          })}
          {list.filter((s) => !s.current).length > 1 ? (
            <button
              type="button"
              onClick={async () => {
                const others = list.filter((s) => !s.current)
                const ok = await confirm({ title: `注销其他 ${others.length} 个会话？`, description: '这些设备都需要重新登录。', confirmLabel: '全部注销', destructive: true })
                if (!ok) return
                await Promise.allSettled(others.map((s) => revoke.mutateAsync(s.id)))
                toast.success('已注销其他会话')
              }}
              className="focus-ring -outline-offset-2 flex min-h-11 w-full items-center px-4 text-body text-red hover:bg-quaternary-fill"
            >
              注销其他所有会话
            </button>
          ) : null}
        </GroupedList>
      )}
    </section>
  )
}

// ---------------- tokens ----------------
const SCOPES = [
  { value: 'read' as const, label: '读取', help: '状态、文件、任务列表' },
  { value: 'control' as const, label: '控制', help: '点动、开始 / 暂停 / 停止任务' },
  { value: 'admin' as const, label: '管理', help: '设置、配置、原始命令' },
]
type Scope = (typeof SCOPES)[number]['value']
const SCOPE_LABEL: Record<string, string> = Object.fromEntries(SCOPES.map((s) => [s.value, s.label]))

function CreateTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateToken()
  const [name, setName] = React.useState('')
  const [scopes, setScopes] = React.useState<Scope[]>(['read'])
  const [expires, setExpires] = React.useState('90')
  const [created, setCreated] = React.useState<TokenCreated | null>(null)
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (open) {
      setName('')
      setScopes(['read'])
      setExpires('90')
      setCreated(null)
      setCopied(false)
    }
  }, [open])
  const toggle = (s: Scope) => setScopes((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]))
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !scopes.length) return
    const t = await create.mutateAsync({ name: name.trim(), scopes, expires_days: expires === 'never' ? null : Number(expires) }).catch(() => null)
    if (t) setCreated(t)
  }
  const copy = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.token)
    } catch {
      // insecure context (plain HTTP on LAN): fall back to selecting the text
      const el = document.getElementById('token-value') as HTMLInputElement | null
      el?.select()
      document.execCommand?.('copy')
    }
    setCopied(true)
    toast.success('已复制令牌')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" onInteractOutside={(e) => created && e.preventDefault()}>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>令牌已创建</DialogTitle>
              <DialogDescription>「{created.name}」 · {created.scopes.map((s) => SCOPE_LABEL[s]).join('、')}</DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-3">
              <div role="alert" className="flex items-start gap-2 rounded-lg bg-orange/15 px-3 py-2.5 text-callout text-on-tint-orange">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>令牌只显示这一次。请立即复制并妥善保存，关闭后无法再次查看。</span>
              </div>
              <div className="flex gap-2">
                <Input id="token-value" readOnly value={created.token} onFocus={(e) => e.currentTarget.select()} className="flex-1 font-mono text-footnote" aria-label="API 令牌" />
                <Button variant={copied ? 'gray' : 'tinted'} icon={copied ? <Check /> : <Copy />} onClick={() => void copy()}>
                  {copied ? '已复制' : '复制'}
                </Button>
              </div>
              <p className="text-footnote text-secondary-label">
                使用方式：请求头 <code className="rounded-xs bg-fill px-1 font-mono">Authorization: Bearer &lt;令牌&gt;</code>
              </p>
            </DialogBody>
            <DialogFooter>
              <Button variant="filled" onClick={() => onOpenChange(false)}>
                完成
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>新建 API 令牌</DialogTitle>
              <DialogDescription>供脚本和其他程序调用 API。</DialogDescription>
            </DialogHeader>
            <DialogBody className="flex flex-col gap-4">
              <FormField label="名称" htmlFor="token-name">
                <Input id="token-name" autoFocus value={name} maxLength={60} placeholder="例如：自动打印脚本" onChange={(e) => setName(e.currentTarget.value)} />
              </FormField>
              <fieldset>
                <legend className="mb-1.5 text-footnote font-medium text-secondary-label">权限</legend>
                <div className="overflow-hidden rounded-lg bg-quaternary-fill">
                  {SCOPES.map((s) => (
                    <label key={s.value} className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-1.5 [&+&]:hairline-t">
                      <input type="checkbox" checked={scopes.includes(s.value)} onChange={() => toggle(s.value)} className="size-4 accent-[rgb(var(--accent))]" />
                      <span className="flex-1">
                        <span className="block text-body text-label">{s.label}</span>
                        <span className="block text-footnote text-secondary-label">{s.help}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {!scopes.length ? <p className="mt-1 text-footnote text-red">至少选择一项权限</p> : null}
              </fieldset>
              <FormField label="有效期" htmlFor="token-exp">
                <Select
                  id="token-exp"
                  value={expires}
                  onValueChange={setExpires}
                  options={[
                    { value: '7', label: '7 天' },
                    { value: '30', label: '30 天' },
                    { value: '90', label: '90 天' },
                    { value: '365', label: '1 年' },
                    { value: 'never', label: '永不过期' },
                  ]}
                />
              </FormField>
            </DialogBody>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>取消</Button>
              <Button type="submit" variant="filled" loading={create.isPending} disabled={!name.trim() || !scopes.length}>
                创建
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TokensCard() {
  const tokens = useTokens()
  const revoke = useRevokeToken()
  const [open, setOpen] = React.useState(false)
  const now = Date.now() / 1000
  return (
    <section className="flex flex-col">
      <div className="mb-1.5 flex items-end justify-between px-4">
        <h3 className="flex items-center text-footnote font-medium text-secondary-label">API 令牌<HelpLink topic="api-token" className="ml-1" /></h3>
        <Button size="sm" variant="plain" icon={<Plus />} onClick={() => setOpen(true)}>
          新建令牌
        </Button>
      </div>
      {tokens.isPending ? (
        <SkeletonList rows={2} />
      ) : tokens.isError ? (
        <QueryError error={tokens.error} onRetry={() => void tokens.refetch()} what="API 令牌" />
      ) : (
        <GroupedList footer="令牌拥有与所选权限相同的能力，请勿分享。不再使用时请吊销。">
          {tokens.data?.length ? (
            tokens.data.map((t) => {
              const expired = t.expires_at != null && t.expires_at < now
              return (
                <div key={t.id} className="flex min-h-14 items-center gap-3 py-1.5 pl-4 pr-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-fill text-secondary-label" aria-hidden>
                    <KeyRound className="size-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-body text-label">
                      <span className="truncate">{t.name}</span>
                      {t.scopes.map((s) => (
                        <Badge key={s} tone={s === 'admin' ? 'orange' : s === 'control' ? 'blue' : 'gray'}>
                          {SCOPE_LABEL[s] ?? s}
                        </Badge>
                      ))}
                      {expired ? <Badge tone="red">已过期</Badge> : null}
                    </p>
                    <p className="truncate text-footnote text-secondary-label">
                      创建于 {formatRelative(t.created_at)} · {t.last_used ? `最近使用 ${formatRelative(t.last_used)}` : '从未使用'} ·{' '}
                      {t.expires_at ? `${toDate(t.expires_at)?.toLocaleDateString('zh-CN')} 过期` : '永不过期'}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="destructive-plain"
                    onClick={async () => {
                      const ok = await confirm({ title: `吊销令牌「${t.name}」？`, description: '使用此令牌的脚本将立即失去访问权限。', confirmLabel: '吊销', destructive: true })
                      if (ok) await revoke.mutateAsync(t.id).then(() => toast.success('已吊销令牌')).catch(() => null)
                    }}
                  >
                    吊销
                  </Button>
                </div>
              )
            })
          ) : (
            <div className="flex flex-col items-center gap-1 px-4 py-6 text-center">
              <KeyRound className="mb-1 size-7 text-tertiary-label" aria-hidden />
              <p className="text-callout text-label">还没有 API 令牌</p>
              <p className="text-footnote text-secondary-label">脚本可以用令牌代替密码访问 API。</p>
            </div>
          )}
        </GroupedList>
      )}
      <CreateTokenDialog open={open} onOpenChange={setOpen} />
    </section>
  )
}

function ProfileCard() {
  const me = useMe()
  const [name, setName] = React.useState('')
  const [save, setSave] = React.useState<'idle' | 'saving' | 'saved'>('idle')
  React.useEffect(() => setName(me.data?.display_name ?? ''), [me.data?.display_name])
  const user = me.data
  const legacy = me.isError // single-admin backend without /auth/me
  const display = user?.display_name || user?.username || 'admin'
  const commit = async () => {
    if (!user || name.trim() === (user.display_name ?? '')) return
    setSave('saving')
    try {
      await updateMe(user, { display_name: name.trim() || null })
      setSave('saved')
      setTimeout(() => setSave('idle'), 2000)
    } catch (e) {
      setSave('idle')
      setName(user.display_name ?? '')
      toast.error(isUnavailable(e) ? '尚不可用（后端尚未提供）' : '保存失败', { description: isUnavailable(e) ? undefined : describeErrorText(e) })
    }
  }
  return (
    <GroupedList header="我的账户" footer={legacy ? '单管理员模式：显示名称不可修改。' : undefined}>
      <div className="flex items-center gap-3 px-4 py-3">
        {me.isPending ? <Skeleton className="size-12 rounded-full" /> : <Avatar name={display} size={48} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-headline text-label">{me.isPending ? '…' : display}</p>
          <p className="flex items-center gap-1.5 text-footnote text-secondary-label">
            <span className="truncate">@{user?.username ?? 'admin'}</span>
            <Badge tone={(user?.role ?? 'admin') === 'admin' ? 'orange' : user?.role === 'operator' ? 'blue' : 'gray'}>{ROLE_LABEL[user?.role ?? 'admin']}</Badge>
          </p>
        </div>
      </div>
      {user ? (
        <FormRow label="显示名称" htmlFor="me-display" help={save === 'saved' ? '已保存' : undefined}>
          <Input
            id="me-display"
            value={name}
            maxLength={40}
            placeholder={user.username}
            onChange={(e) => setName(e.currentTarget.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            className="max-w-56"
            disabled={save === 'saving'}
          />
        </FormRow>
      ) : null}
    </GroupedList>
  )
}

export function AccountSection() {
  return (
    <div className="flex flex-col gap-6">
      <ProfileCard />
      <PasswordCard />
      <SessionsCard />
      <TokensCard />
      <p className={cn('px-4 text-footnote text-secondary-label')}>
        局域网内通过 HTTP 访问时，密码以明文传输。请只在可信网络中使用；软件急停依赖网络，建议加装物理急停。
      </p>
    </div>
  )
}
