/** Import original-software settings files (settings.json / Grbl.json / EBB.json / Marlin.json / K_AT) into a profile. */
import { CircleCheck, FileJson, FileWarning, Plus } from 'lucide-react'
import * as React from 'react'
import { describeErrorText } from '@/api/errors'
import { api } from '@/api/client'
import { pickFile } from '@/api/download'
import { patchProfile, type Profile } from '@/api/profiles'
import { queryClient, qk } from '@/api/query'
import {
  Badge, Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, FormField,
  Input, Segmented, Select,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { readPlan, SECTION_LABEL, type ImportPlan, type MachineType } from './legacy-import'

const TYPES: { value: MachineType; label: string }[] = [
  { value: 'Grbl', label: 'GRBL' },
  { value: 'Marlin', label: 'Marlin' },
  { value: 'Ebb', label: 'EBB' },
  { value: 'K_AT', label: 'K_AT' },
]

export const IMPORT_ACCEPT = '.json,application/json'

/** Pick files then open the dialog: `const files = await pickSettingsFiles(); if (files) setFiles(files)`. */
export function pickSettingsFiles() {
  return pickFile(IMPORT_ACCEPT, true)
}

export function ImportProfileDialog({
  files, onOpenChange, active, onDone,
}: {
  files: File[] | null
  onOpenChange: (o: boolean) => void
  active: Profile | undefined
  onDone: (p: Profile) => void
}) {
  const [plan, setPlan] = React.useState<ImportPlan | null>(null)
  const [extra, setExtra] = React.useState<File[]>([])
  const [mode, setMode] = React.useState<'new' | 'merge'>('new')
  const [name, setName] = React.useState('')
  const [type, setType] = React.useState<MachineType | 'keep'>('keep')
  const [busy, setBusy] = React.useState(false)
  const open = !!files

  React.useEffect(() => {
    if (!files) {
      setPlan(null)
      setExtra([])
      return
    }
    setExtra(files)
  }, [files])

  React.useEffect(() => {
    if (!extra.length) return
    let alive = true
    void readPlan(extra).then((p) => {
      if (!alive) return
      setPlan(p)
      setName((n) => n || p.suggestedName)
      setType(p.type ?? 'keep')
    })
    return () => {
      alive = false
    }
  }, [extra])

  React.useEffect(() => {
    if (open) {
      setMode('new')
      setName('')
    }
  }, [open])

  const addMore = async () => {
    const more = await pickSettingsFiles()
    if (more?.length) setExtra((x) => [...x.filter((f) => !more.some((m) => m.name === f.name)), ...more])
  }

  const usable = !!plan && plan.sections.length > 0
  const submit = async () => {
    if (!plan || !usable) return
    const doc = { ...plan.doc } as Record<string, unknown>
    if (type !== 'keep') doc.type = type
    else if (mode === 'new' && !doc.type) doc.type = 'Grbl'
    setBusy(true)
    try {
      let p: Profile
      if (mode === 'merge' && active) {
        p = await patchProfile(active.id, { doc })
        toast.success(`已导入到「${active.name}」`, { description: `${plan.sections.length} 组设置已更新` })
      } else {
        p = await api.post<Profile>('/profiles', { name: name.trim() || plan.suggestedName, doc })
        toast.success(`已创建「${p.name}」`)
      }
      await queryClient.invalidateQueries({ queryKey: qk.profiles.all })
      onDone(p)
      onOpenChange(false)
    } catch (e) {
      toast.error('导入失败', { description: describeErrorText(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>导入机器设置</DialogTitle>
          <DialogDescription>支持原软件的 settings.json、Grbl.json、EBB.json、Marlin.json、K_AT.json，以及导出的机器配置 JSON。可一次选择多个文件合并成一个机器配置。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <section aria-label="已识别的文件">
            <div className="overflow-hidden rounded-lg bg-quaternary-fill">
              {plan?.files.map((f) => (
                <div key={f.file} className="flex min-h-11 items-center gap-3 px-3 py-1.5 [&+&]:hairline-t">
                  {f.error ? <FileWarning className="size-5 shrink-0 text-orange" aria-hidden /> : <FileJson className="size-5 shrink-0 text-accent" aria-hidden />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body text-label">{f.file}</p>
                    <p className={cn('truncate text-footnote', f.error ? 'text-on-tint-orange' : 'text-secondary-label')}>
                      {f.error ?? `${f.kind === 'machine' ? '完整机器配置' : '识别为'}：${f.sections.map((s) => SECTION_LABEL[s]).join('、')}`}
                    </p>
                  </div>
                </div>
              )) ?? <p className="px-3 py-3 text-footnote text-secondary-label">正在读取…</p>}
            </div>
            <Button size="sm" variant="plain" icon={<Plus />} className="mt-1" onClick={() => void addMore()}>
              添加文件
            </Button>
          </section>

          {plan && usable ? (
            <>
              <div className="flex flex-wrap gap-1.5" aria-label="将导入的设置">
                {plan.sections.map((s) => (
                  <Badge key={s} tone="green" icon={CircleCheck}>
                    {SECTION_LABEL[s]}
                  </Badge>
                ))}
              </div>
              {plan.unknownKeys.length ? (
                <p className="text-footnote text-secondary-label">
                  另有 {plan.unknownKeys.length} 个未识别字段会原样保留：
                  <span className="font-mono">{plan.unknownKeys.slice(0, 6).join(', ')}{plan.unknownKeys.length > 6 ? ' …' : ''}</span>
                </p>
              ) : null}

              <FormField label="导入方式">
                <Segmented
                  block
                  aria-label="导入方式"
                  value={mode}
                  onValueChange={setMode}
                  options={[
                    { value: 'new', label: '新建机器配置' },
                    { value: 'merge', label: '导入到当前机器配置', disabled: !active },
                  ]}
                />
              </FormField>
              {mode === 'new' ? (
                <FormField label="名称" htmlFor="imp-name">
                  <Input id="imp-name" value={name} maxLength={80} onChange={(e) => setName(e.currentTarget.value)} />
                </FormField>
              ) : (
                <p className="rounded-lg bg-orange/15 px-3 py-2 text-callout text-on-tint-orange">
                  将覆盖「{active?.name}」中对应的字段，其他设置保持不变。
                </p>
              )}
              <FormField label="控制器类型" htmlFor="imp-type" help={plan.type ? `根据文件识别为 ${TYPES.find((t) => t.value === plan.type)?.label ?? plan.type}` : '文件中没有机型信息'}>
                <Select
                  id="imp-type"
                  value={type}
                  onValueChange={(v) => setType(v as MachineType | 'keep')}
                  options={[{ value: 'keep', label: mode === 'merge' ? '保持当前类型' : '默认（GRBL）' }, ...TYPES]}
                />
              </FormField>
            </>
          ) : plan ? (
            <p role="alert" className="text-callout text-on-tint-orange">没有识别到可导入的设置。请选择原软件配置目录中的 settings.json、Grbl.json 等文件。</p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="filled" loading={busy} disabled={!usable || (mode === 'new' && !name.trim())} onClick={() => void submit()}>
            {mode === 'merge' ? '导入' : '创建机器配置'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
