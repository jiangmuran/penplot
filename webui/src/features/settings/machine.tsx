/** 设置 › 机器配置: profile list (activate / new / duplicate / rename / import / export / delete) + editor. */
import { Check, Copy, Download, FileUp, MoreHorizontal, Pencil, Plus, Power, Trash2, Wand2 } from 'lucide-react'
import * as React from 'react'
import { describeErrorText } from '@/api/errors'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError } from '@/api/client'
import { downloadFrom } from '@/api/download'
import {
  useActivateProfile, useCreateProfile, useDeleteProfile, useProfiles, useRenameProfile, type Profile,
} from '@/api/profiles'
import { isJobActive, useLive } from '@/api/store'
import {
  Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, FormField,
  GroupedList, IconButton, Input, Select, Skeleton,
} from '@/components/ui'
import { useIsCompact } from '@/lib/media'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'
import { toast } from '@/lib/toast'
import { ImportProfileDialog, pickSettingsFiles } from './import-dialog'
import { ProfileEditor } from './profile-editor'
import { QueryError, SectionIntro } from './shared'

const TYPE_LABEL: Record<string, string> = { Grbl: 'GRBL', Marlin: 'Marlin', Ebb: 'EBB', K_AT: 'K_AT' }
const PEN_LABEL: Record<string, string> = { Stepper: 'Z 步进', Servo: '舵机', Servo_bachin: '舵机', Laser: '激光' }

function profileSubtitle(p: Profile) {
  const doc = p.doc as Record<string, Record<string, unknown> | string | undefined>
  const type = String(doc.type ?? 'Grbl')
  const pen = type === 'Grbl' ? PEN_LABEL[String((doc.grbl as Record<string, unknown>)?.type)] : undefined
  const wa = p.doc.work_area
  return [TYPE_LABEL[type] ?? type, pen, wa && wa.w_mm > 0 && wa.h_mm > 0 ? `${wa.w_mm}×${wa.h_mm} mm` : null].filter(Boolean).join(' · ')
}

function NameDialog({
  open, onOpenChange, title, description, initial, confirmLabel, onSubmit, extra,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: string
  initial: string
  confirmLabel: string
  onSubmit: (name: string) => Promise<unknown>
  extra?: React.ReactNode
}) {
  const [name, setName] = React.useState(initial)
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    if (open) setName(initial)
  }, [open, initial])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setBusy(true)
    try {
      await onSubmit(name.trim())
      onOpenChange(false)
    } catch {
      /* toasted */
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <DialogBody className="flex flex-col gap-3">
            <FormField label="名称" htmlFor="profile-name">
              <Input id="profile-name" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.currentTarget.value)} />
            </FormField>
            {extra}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" variant="filled" loading={busy} disabled={!name.trim()}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const CORNER_NAME = ['左上', '右上', '左下', '右下']

/** 「本机名片」: the essentials of the active machine configuration + entry to the first-run wizard. */
function MachineCard({ profile }: { profile: Profile }) {
  const navigate = useNavigate()
  const doc = profile.doc as Record<string, Record<string, unknown> | string | undefined>
  const type = String(doc.type ?? 'Grbl')
  const grbl = (doc.grbl ?? {}) as Record<string, unknown>
  const axes = (doc.axes ?? {}) as Record<string, unknown>
  const wa = profile.doc.work_area
  const stepper = type === 'Grbl' && grbl.type === 'Stepper'
  const dir = [axes.revxy ? 'X/Y 交换' : null, axes.xAxeRev ? 'X 反向' : null, axes.yAxeRev ? 'Y 反向' : null].filter(Boolean).join('，') || '标准'
  const facts: [string, string][] = [
    ['行程', wa && wa.w_mm > 0 && wa.h_mm > 0 ? `${wa.w_mm} × ${wa.h_mm} mm` : '未设置（不检查）'],
    stepper ? ['落笔深度', `${Number(grbl.zOn ?? 0).toFixed(1)} mm`] : ['笔类型', PEN_LABEL[String(grbl.type)] ?? (TYPE_LABEL[type] ?? type)],
    ['原点', `${((doc.print_defaults as Record<string, unknown> | undefined)?.origin as Record<string, unknown> | undefined)?.anchor === 'content' ? '内容' : '纸张'}${CORNER_NAME[Number(axes.pos ?? 0)] ?? '左上'}角`],
    ['方向', dir],
  ]
  return (
    <section aria-label="本机名片" className="overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm">
      <div className="flex items-center gap-3 px-4 pb-2 pt-3.5">
        <div className="min-w-0 flex-1">
          <h3 className="text-headline text-label">本机名片</h3>
          <p className="truncate text-footnote text-secondary-label">
            {profile.name} · {TYPE_LABEL[type] ?? type}
            {stepper ? ' · Z 步进笔' : ''}
          </p>
        </div>
        <Button variant="tinted" size="sm" icon={<Wand2 />} onClick={() => navigate('/machine?wizard=1')}>
          运行上机向导
        </Button>
      </div>
      <dl className="grid grid-cols-2 gap-px bg-separator pt-px sm:grid-cols-4">
        {facts.map(([k, v]) => (
          <div key={k} className="bg-bg-grouped-secondary px-4 py-2.5">
            <dt className="text-footnote text-secondary-label">{k}</dt>
            <dd className="truncate text-body font-medium text-label tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

export function MachineSection({ onActions }: { onActions?: (n: React.ReactNode) => void }) {
  const profiles = useProfiles()
  const [params, setParams] = useSearchParams()
  const create = useCreateProfile()
  const remove = useDeleteProfile()
  const compact = useIsCompact()
  const activate = useActivateProfile()
  const rename = useRenameProfile()
  const jobActive = useLive((s) => isJobActive(s.job))
  const [newOpen, setNewOpen] = React.useState(false)
  const [copyFrom, setCopyFrom] = React.useState<string>('')
  const [renaming, setRenaming] = React.useState<Profile | null>(null)

  const list = profiles.data ?? []
  const active = list.find((p) => p.is_active)
  const selId = params.get('p') ?? active?.id ?? list[0]?.id
  const selected = list.find((p) => p.id === selId) ?? active ?? list[0]
  const select = (id: string) => setParams((sp) => { sp.set('p', id); return sp }, { replace: true })

  const [importFiles, setImportFiles] = React.useState<File[] | null>(null)
  const doImport = React.useCallback(async () => {
    const files = await pickSettingsFiles()
    if (files?.length) setImportFiles(files)
  }, [])

  const openNew = React.useCallback(() => {
    setCopyFrom(active?.id ?? '')
    setNewOpen(true)
  }, [active?.id])

  React.useEffect(() => {
    onActions?.(
      compact ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="新建或导入机器配置">
              <Plus />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem icon={<Plus />} onSelect={openNew}>
              新建机器配置…
            </DropdownMenuItem>
            <DropdownMenuItem icon={<FileUp />} onSelect={() => void doImport()}>
              导入设置文件…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <>
          <IconButton label="导入设置文件（原软件 / JSON）" onClick={() => void doImport()}>
            <FileUp />
          </IconButton>
          <Button variant="filled" icon={<Plus />} onClick={openNew}>
            新建机器配置
          </Button>
        </>
      ),
    )
    return () => onActions?.(null)
  }, [onActions, doImport, openNew, compact])

  const doActivate = async (p: Profile) => {
    try {
      await activate.mutateAsync(p.id)
      toast.success(`已切换到「${p.name}」`)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'job_active') return // toasted by meta
    }
  }
  const doDelete = async (p: Profile) => {
    if (p.is_active) {
      toast.warning('不能删除正在使用的机器配置', { description: '先把另一个机器配置设为当前，再删除它。' })
      return
    }
    const ok = await remove.mutateAsync(p.id).then(() => true).catch(() => false)
    if (!ok) return
    if (selId === p.id) setParams((sp) => { sp.delete('p'); return sp }, { replace: true })
    toast({
      title: `已删除「${p.name}」`,
      duration: 10_000,
      action: {
        label: '撤销',
        onClick: () =>
          void create
            .mutateAsync({ name: p.name, doc: p.doc })
            .then((c) => {
              toast.success(`已恢复「${c.name}」`)
              select(c.id)
            })
            .catch(() => null),
      },
    })
  }
  const doDuplicate = async (p: Profile) => {
    const c = await create.mutateAsync({ name: `${p.name} 副本`, copy_from: p.id }).catch(() => null)
    if (c) {
      toast.success(`已复制为「${c.name}」`)
      select(c.id)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <SectionIntro description="机器配置记录控制器类型、串口、笔、行程和起止 G 代码。同一时间只有一个机器配置生效。" />
      {active ? <MachineCard profile={active} /> : null}

      {profiles.isPending ? (
        <div className="overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm" role="status" aria-label="加载中">
          {[0, 1].map((i) => (
            <div key={i} className="flex h-14 items-center gap-3 px-4 [&+&]:hairline-t">
              <Skeleton className="size-5 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-2.5 w-48" />
              </div>
            </div>
          ))}
        </div>
      ) : profiles.isError ? (
        <QueryError error={profiles.error} onRetry={() => void profiles.refetch()} what="机器配置" />
      ) : (
        <GroupedList header="机器配置" footer={jobActive ? '正在写字，写完后才能切换机器配置。' : '点一下选择要编辑的机器配置。「设为当前」后，之后的连接和任务都用它。'}>
          {list.map((p) => {
            const isSel = p.id === selected?.id
            return (
              <div key={p.id} className={cn('flex min-h-14 items-center gap-2 pr-2', isSel && 'bg-accent/10')}>
                <button
                  type="button"
                  onClick={() => select(p.id)}
                  aria-current={isSel ? 'true' : undefined}
                  className="focus-ring -outline-offset-2 flex min-w-0 flex-1 items-center gap-3 py-2 pl-4 text-left"
                >
                  <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full', p.is_active ? 'bg-green text-white' : 'border border-tertiary-label')} aria-hidden>
                    {p.is_active ? <Check className="size-3" strokeWidth={3} /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-body text-label">{p.name}</span>
                      {p.is_active ? <Badge tone="green">当前</Badge> : null}
                    </span>
                    <span className="block truncate text-footnote text-secondary-label">
                      {profileSubtitle(p)} · 修改于 {formatRelative(p.updated_at)}
                    </span>
                  </span>
                </button>
                {!p.is_active ? (
                  <Button size="sm" variant="tinted" className="hidden sm:inline-flex" disabled={jobActive} loading={activate.isPending && activate.variables === p.id} onClick={() => void doActivate(p)}>
                    设为当前
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <IconButton label={`「${p.name}」更多操作`} size="md">
                      <MoreHorizontal />
                    </IconButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {!p.is_active ? (
                      <DropdownMenuItem icon={<Power />} disabled={jobActive} onSelect={() => void doActivate(p)}>
                        设为当前
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem icon={<Pencil />} onSelect={() => setRenaming(p)}>
                      重命名…
                    </DropdownMenuItem>
                    <DropdownMenuItem icon={<Copy />} onSelect={() => void doDuplicate(p)}>
                      复制
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      icon={<Download />}
                      onSelect={() => void downloadFrom(`/profiles/${encodeURIComponent(p.id)}/export`, `${p.name}.json`).catch((e) => toast.error('导出失败', { description: describeErrorText(e) }))}
                    >
                      导出 JSON
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem icon={<Trash2 />} destructive disabled={p.is_active} onSelect={() => void doDelete(p)}>
                      删除…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )
          })}
        </GroupedList>
      )}

      {selected ? <ProfileEditor key={selected.id} profile={selected} /> : null}

      <ImportProfileDialog files={importFiles} onOpenChange={(o) => !o && setImportFiles(null)} active={active} onDone={(p) => select(p.id)} />
      <NameDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        title="新建机器配置"
        initial="新机器配置"
        confirmLabel="创建"
        onSubmit={async (name) => {
          const p = await create.mutateAsync({ name, copy_from: copyFrom || null })
          toast.success(`已创建「${p.name}」`)
          select(p.id)
        }}
        extra={
          <FormField label="基于" htmlFor="profile-copy">
            <Select
              id="profile-copy"
              value={copyFrom || '__blank'}
              onValueChange={(v) => setCopyFrom(v === '__blank' ? '' : v)}
              options={[{ value: '__blank', label: '默认值（空白）' }, ...list.map((p) => ({ value: p.id, label: `复制「${p.name}」` }))]}
            />
          </FormField>
        }
      />
      <NameDialog
        open={!!renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="重命名机器配置"
        initial={renaming?.name ?? ''}
        confirmLabel="保存"
        onSubmit={(name) => rename.mutateAsync({ id: renaming!.id, name })}
      />
    </div>
  )
}
