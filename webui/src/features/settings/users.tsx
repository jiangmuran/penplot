/** 设置 › 用户与权限 (admin only). ASSUMED contract in api/collab.ts; 404/501 → "尚不可用". */
import { KeyRound, MoreHorizontal, Pencil, Plus, ShieldOff, Trash2, UserCheck, UserPlus, Users } from 'lucide-react'
import * as React from 'react'
import { describeErrorText } from '@/api/errors'
import { isUnavailable, ROLE_DESC, ROLE_LABEL, useMe, useRole, type Role, type UserInfo } from '@/api/collab'
import { resetUserPassword, useCreateUser, useDeleteUser, useUpdateUser, useUsers } from '@/api/users'
import {
  Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, ErrorState,
  FormField, GroupedList, IconButton, Input, Segmented, Skeleton, Switch,
} from '@/components/ui'
import { confirm } from '@/lib/confirm'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'
import { useIsCompact } from '@/lib/media'
import { toast } from '@/lib/toast'
import { PasswordInput } from '@/app/auth/password-input'
import { SectionIntro } from './shared'

const ROLES: Role[] = ['admin', 'operator', 'viewer']
const ROLE_TONE: Record<Role, 'orange' | 'blue' | 'gray'> = { admin: 'orange', operator: 'blue', viewer: 'gray' }
const AVATAR_TINT = ['bg-blue', 'bg-purple', 'bg-pink', 'bg-orange', 'bg-green', 'bg-indigo', 'bg-teal']

export function Avatar({ name, size = 32, className }: { name: string; size?: number; className?: string }) {
  const ch = (name.trim()[0] ?? '?').toUpperCase()
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return (
    <span
      aria-hidden
      className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold text-white', AVATAR_TINT[h % AVATAR_TINT.length], className)}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {ch}
    </span>
  )
}

function RolePicker({ value, onChange, disabled }: { value: Role; onChange: (r: Role) => void; disabled?: boolean }) {
  return (
    <FormField label="角色" help={ROLE_DESC[value]}>
      <Segmented block aria-label="角色" value={value} onValueChange={onChange} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r], disabled }))} />
    </FormField>
  )
}

function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const create = useCreateUser()
  const [username, setUsername] = React.useState('')
  const [display, setDisplay] = React.useState('')
  const [pw, setPw] = React.useState('')
  const [role, setRole] = React.useState<Role>('operator')
  React.useEffect(() => {
    if (open) {
      setUsername('')
      setDisplay('')
      setPw('')
      setRole('operator')
    }
  }, [open])
  const badName = username.length > 0 && !/^[a-zA-Z0-9_.-]{2,32}$/.test(username)
  const shortPw = pw.length > 0 && pw.length < 10
  const ok = username && !badName && pw.length >= 10
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ok) return
    const u = await create.mutateAsync({ username, display_name: display.trim() || null, password: pw, role }).catch(() => null)
    if (u) {
      toast.success(`已添加用户「${u.display_name || u.username}」`)
      onOpenChange(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>添加用户</DialogTitle>
            <DialogDescription>新用户用自己的用户名和密码登录。</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="用户名" htmlFor="nu-name" error={badName ? '2–32 位字母、数字或 _ . -' : undefined}>
                <Input id="nu-name" autoFocus autoCapitalize="off" autoComplete="off" spellCheck={false} value={username} invalid={badName} onChange={(e) => setUsername(e.currentTarget.value.trim())} placeholder="例如 zhangsan" />
              </FormField>
              <FormField label="显示名称（可选）" htmlFor="nu-display">
                <Input id="nu-display" value={display} maxLength={40} onChange={(e) => setDisplay(e.currentTarget.value)} placeholder="例如 张三" />
              </FormField>
            </div>
            <FormField label="初始密码" htmlFor="nu-pw" error={shortPw ? '至少需要 10 个字符' : undefined} help="请通过安全的方式告知对方，并建议其登录后修改。">
              <PasswordInput id="nu-pw" autoComplete="new-password" inputSize="md" value={pw} invalid={shortPw} onChange={(e) => setPw(e.currentTarget.value)} />
            </FormField>
            <RolePicker value={role} onChange={setRole} />
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" variant="filled" loading={create.isPending} disabled={!ok}>
              添加
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EditUserDialog({ user, isSelf, onOpenChange }: { user: UserInfo | null; isSelf: boolean; onOpenChange: (o: boolean) => void }) {
  const update = useUpdateUser()
  const [display, setDisplay] = React.useState('')
  const [role, setRole] = React.useState<Role>('operator')
  const [disabled, setDisabled] = React.useState(false)
  React.useEffect(() => {
    if (user) {
      setDisplay(user.display_name ?? '')
      setRole(user.role)
      setDisabled(!!user.disabled)
    }
  }, [user])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user) return
    const patch = {
      ...(display.trim() !== (user.display_name ?? '') ? { display_name: display.trim() || null } : {}),
      ...(role !== user.role ? { role } : {}),
      ...(disabled !== !!user.disabled ? { disabled } : {}),
    }
    if (!Object.keys(patch).length) return onOpenChange(false)
    const u = await update.mutateAsync({ id: user.id, patch }).catch(() => null)
    if (u) {
      toast.success('已保存')
      onOpenChange(false)
    }
  }
  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>编辑用户</DialogTitle>
            <DialogDescription>@{user?.username}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            <FormField label="显示名称" htmlFor="eu-display">
              <Input id="eu-display" value={display} maxLength={40} onChange={(e) => setDisplay(e.currentTarget.value)} placeholder={user?.username} />
            </FormField>
            <RolePicker value={role} onChange={setRole} disabled={isSelf} />
            {isSelf ? <p className="-mt-2 text-footnote text-secondary-label">不能修改自己的角色或停用自己。</p> : null}
            <label className={cn('flex min-h-11 items-center gap-3 rounded-lg bg-quaternary-fill px-3', isSelf && 'opacity-50')}>
              <span className="flex-1">
                <span className="block text-body text-label">停用账户</span>
                <span className="block text-footnote text-secondary-label">停用后无法登录，现有会话立即失效。</span>
              </span>
              <Switch checked={disabled} onCheckedChange={setDisabled} disabled={isSelf} aria-label="停用账户" />
            </label>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" variant="filled" loading={update.isPending}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ResetPasswordDialog({ user, onOpenChange }: { user: UserInfo | null; onOpenChange: (o: boolean) => void }) {
  const [pw, setPw] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => setPw(''), [user])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user || pw.length < 10) return
    setBusy(true)
    try {
      await resetUserPassword(user.id, pw)
      toast.success(`已重置「${user.display_name || user.username}」的密码`, { description: '该用户的其他会话已注销。' })
      onOpenChange(false)
    } catch (err) {
      toast.error('重置密码失败', { description: describeErrorText(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>为 @{user?.username} 设置新密码。</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <FormField label="新密码" htmlFor="rp-pw" error={pw.length > 0 && pw.length < 10 ? '至少需要 10 个字符' : undefined}>
              <PasswordInput id="rp-pw" autoFocus autoComplete="new-password" inputSize="md" value={pw} onChange={(e) => setPw(e.currentTarget.value)} />
            </FormField>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" variant="filled" loading={busy} disabled={pw.length < 10}>
              重置
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function UsersSection({ onActions }: { onActions?: (n: React.ReactNode) => void }) {
  const role = useRole()
  const me = useMe()
  const isAdmin = role === 'admin'
  const users = useUsers(isAdmin)
  const update = useUpdateUser()
  const del = useDeleteUser()
  const compact = useIsCompact()
  const [createOpen, setCreateOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<UserInfo | null>(null)
  const [resetting, setResetting] = React.useState<UserInfo | null>(null)
  const available = isAdmin && !users.isError

  React.useEffect(() => {
    onActions?.(
      available ? (
        compact ? (
          <IconButton label="添加用户" onClick={() => setCreateOpen(true)}>
            <UserPlus />
          </IconButton>
        ) : (
          <Button variant="filled" icon={<Plus />} onClick={() => setCreateOpen(true)}>
            添加用户
          </Button>
        )
      ) : null,
    )
    return () => onActions?.(null)
  }, [onActions, available, compact])

  if (!isAdmin) {
    return <EmptyState icon={ShieldOff} title="需要管理员权限" description="只有管理员可以管理用户。你可以在「账户与安全」中修改自己的资料和密码。" />
  }

  const meId = me.data?.id
  const list = [...(users.data ?? [])].sort((a, b) => Number(b.id === meId) - Number(a.id === meId) || ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.username.localeCompare(b.username))
  const adminCount = list.filter((u) => u.role === 'admin' && !u.disabled).length

  const toggleDisabled = async (u: UserInfo) => {
    if (!u.disabled) {
      const ok = await confirm({ title: `停用「${u.display_name || u.username}」？`, description: '该用户将无法登录，现有会话立即失效。可随时重新启用。', confirmLabel: '停用', destructive: true })
      if (!ok) return
    }
    await update.mutateAsync({ id: u.id, patch: { disabled: !u.disabled } }).then(() => toast.success(u.disabled ? '已启用' : '已停用')).catch(() => null)
  }
  const remove = async (u: UserInfo) => {
    const ok = await confirm({ title: `删除用户「${u.display_name || u.username}」？`, description: '其会话与 API 令牌会一并删除。此操作无法撤销。', confirmLabel: '删除', destructive: true })
    if (ok) await del.mutateAsync(u.id).then(() => toast.success('已删除用户')).catch(() => null)
  }

  return (
    <div className="flex flex-col gap-6">
      <SectionIntro description="为租户的每位成员建立各自的账号：管理员可改配置，操作员可打印，观察者只能看。" />
      {users.isPending ? (
        <div className="overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm" role="status" aria-label="加载中">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex h-14 items-center gap-3 px-4 [&+&]:hairline-t">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-2.5 w-44" />
              </div>
            </div>
          ))}
        </div>
      ) : users.isError ? (
        isUnavailable(users.error) ? (
          <GroupedList footer="后端升级到多用户版本后，这里会列出所有账户。">
            <div className="flex flex-col items-center gap-1.5 px-6 py-8 text-center">
              <Users className="mb-1 size-10 text-tertiary-label" strokeWidth={1.5} aria-hidden />
              <p className="text-headline text-label">尚不可用（后端尚未提供）</p>
              <p className="max-w-sm text-subheadline text-secondary-label">当前为单管理员模式：所有登录都使用同一个管理员密码。</p>
            </div>
          </GroupedList>
        ) : (
          <ErrorState error={users.error} onRetry={() => void users.refetch()} />
        )
      ) : (
        <GroupedList header={`用户（${list.length}）`}>
          {list.map((u) => {
            const self = u.id === meId
            const lastAdmin = u.role === 'admin' && adminCount <= 1
            const name = u.display_name || u.username
            return (
              <div key={u.id} className={cn('flex min-h-14 items-center gap-1 pr-2', u.disabled && 'opacity-60')}>
                <button
                  type="button"
                  onClick={() => setEditing(u)}
                  className="focus-ring -outline-offset-2 flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 pl-4 text-left"
                  aria-label={`编辑 ${name}`}
                >
                  <Avatar name={name} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-body text-label">{name}</span>
                      {self ? <Badge tone="accent">你</Badge> : null}
                      <Badge tone={ROLE_TONE[u.role]}>{ROLE_LABEL[u.role]}</Badge>
                      {u.disabled ? <Badge tone="red">已停用</Badge> : null}
                    </span>
                    <span className="block truncate text-footnote text-secondary-label">
                      @{u.username} · {u.last_login ? `最近登录 ${formatRelative(u.last_login)}` : '从未登录'}
                    </span>
                  </span>
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton label={`「${name}」更多操作`}>
                      <MoreHorizontal />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem icon={<Pencil />} onSelect={() => setEditing(u)}>
                      编辑…
                    </DropdownMenuItem>
                    <DropdownMenuItem icon={<KeyRound />} onSelect={() => setResetting(u)}>
                      重置密码…
                    </DropdownMenuItem>
                    {!self ? (
                      <DropdownMenuItem icon={u.disabled ? <UserCheck /> : <ShieldOff />} disabled={!u.disabled && lastAdmin} onSelect={() => void toggleDisabled(u)}>
                        {u.disabled ? '启用' : '停用…'}
                      </DropdownMenuItem>
                    ) : null}
                    {!self ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem icon={<Trash2 />} destructive disabled={lastAdmin} onSelect={() => void remove(u)}>
                          删除…
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          })}
        </GroupedList>
      )}

      <GroupedList header="角色说明">
        {ROLES.map((r) => (
          <div key={r} className="flex min-h-11 items-center gap-3 px-4 py-2">
            <Badge tone={ROLE_TONE[r]} className="w-16 justify-center">
              {ROLE_LABEL[r]}
            </Badge>
            <span className="text-callout text-secondary-label">{ROLE_DESC[r]}</span>
          </div>
        ))}
      </GroupedList>

      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditUserDialog user={editing} isSelf={!!editing && editing.id === meId} onOpenChange={(o) => !o && setEditing(null)} />
      <ResetPasswordDialog user={resetting} onOpenChange={(o) => !o && setResetting(null)} />
    </div>
  )
}
