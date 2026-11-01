/** 设置 › 偏好: server app settings (GET/PATCH /settings) + local browser preferences. */
import * as React from 'react'
import { patchAppSettings, useAppSettings, useFontsLite, usePapers, type AppSettings } from '@/api/profiles'
import { AttentionSettings } from '@/app/attention-settings'
import { Combobox, FormRow, GroupedList, Select, SkeletonList } from '@/components/ui'
import { setSingleKeyShortcutsEnabled, singleKeyShortcutsEnabled } from '@/lib/shortcuts'
import { NumberRow, QueryError, SaveIndicator, SwitchRow, useSaveStatus } from './shared'

export function PreferencesSection() {
  const settings = useAppSettings()
  const fonts = useFontsLite()
  const papers = usePapers()
  const save = useSaveStatus()
  const [draft, setDraft] = React.useState<AppSettings | null>(null)
  const [singleKey, setSingleKey] = React.useState(singleKeyShortcutsEnabled)
  React.useEffect(() => {
    if (settings.data && !draft) setDraft(settings.data)
  }, [settings.data, draft])

  const [lastUndo, setLastUndo] = React.useState<Partial<AppSettings> | null>(null)
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K], recordUndo = true) => {
    if (recordUndo && draft) setLastUndo({ [k]: draft[k] ?? null } as Partial<AppSettings>)
    setDraft((d) => (d ? { ...d, [k]: v } : d))
    void save.run(() => patchAppSettings({ [k]: v } as Partial<AppSettings>)).catch(() => setDraft(settings.data ?? null))
  }
  const undo = lastUndo
    ? () => {
        for (const [k, v] of Object.entries(lastUndo)) set(k as keyof AppSettings, v as never, false)
        setLastUndo(null)
      }
    : undefined

  const fontOptions = React.useMemo(
    () =>
      (fonts.data ?? [])
        .filter((f) => !f.hidden)
        .map((f) => ({ value: f.id, label: f.display_name, description: `${f.format} · ${f.glyph_count.toLocaleString('zh-CN')} 字`, keywords: [f.filename] })),
    [fonts.data],
  )

  if (settings.isPending || (!draft && !settings.isError)) return <SkeletonList rows={6} />
  if (settings.isError || !draft) return <QueryError error={settings.error} onRetry={() => void settings.refetch()} what="偏好设置" />

  return (
    <div className="flex flex-col gap-6 max-md:pt-2">
      <div className="relative h-0">
        <SaveIndicator status={save.status} error={save.error} onUndo={undo} className="absolute -top-[46px] right-1 max-md:-top-3 max-md:-translate-y-full" />
      </div>
      <GroupedList header="新建项目默认值">
        <FormRow label="默认字体" htmlFor="pref-font">
          <Combobox
            id="pref-font"
            value={draft.default_font ?? ''}
            onValueChange={(v) => set('default_font', v || null)}
            options={fontOptions}
            placeholder={fonts.isPending ? '加载中…' : '内置字体'}
            searchPlaceholder="搜索字体"
            className="max-w-60 flex-1"
          />
        </FormRow>
        <FormRow label="默认纸张" htmlFor="pref-paper">
          <Select
            id="pref-paper"
            value={draft.default_paper ?? 'a4-normal'}
            onValueChange={(v) => set('default_paper', v)}
            options={(papers.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            className="max-w-60"
          />
        </FormRow>
      </GroupedList>

      <GroupedList header="任务" footer="多页或批量任务默认每页之间等你换纸。只有能自动进纸的机器才应该打开「自动开始下一页」。">
        <SwitchRow label="批量任务自动开始下一页" checked={!!draft.batch_auto_advance} onChange={(v) => set('batch_auto_advance', v)} />
        <SwitchRow
          label="没人看着时自动暂停"
          help="正在看这个任务的所有网页都关闭或断网超过设定时间（默认 120 秒）后，写完当前笔画就软暂停，抬笔等你回来继续，避免无人看管时出错。只对有人从网页看过的任务生效，脚本提交的任务不受影响。"
          checked={draft.pause_on_client_loss_s != null}
          onChange={(v) => set('pause_on_client_loss_s', v ? 120 : null)}
        />
        {draft.pause_on_client_loss_s != null ? (
          <NumberRow label="断开后等待" unit="s" min={10} max={3600} step={10} value={draft.pause_on_client_loss_s} onChange={(v) => set('pause_on_client_loss_s', v)} />
        ) : null}
        <NumberRow
          label="控制权自动释放"
          help="控制机器的人关闭网页且没有任何操作超过这个时间后，控制权自动释放，其他人就可以接手。"
          unit="s"
          min={10}
          max={3600}
          step={10}
          value={draft.lease_release_s ?? 60}
          onChange={(v) => set('lease_release_s', v)}
        />
        <FormRow label="剩余时间校准" help="根据写完的任务的实际用时自动调整，不需要手动修改。">
          <span className="text-body text-secondary-label tabular-nums">× {(draft.eta_factor ?? 1).toFixed(2)}</span>
        </FormRow>
      </GroupedList>

      <GroupedList header="服务">
        <NumberRow label="状态刷新频率" help="写字时查询写字机状态的频率。太高会占用串口带宽。" unit="Hz" min={1} max={10} step={0.5} value={draft.poll_hz ?? 4} onChange={(v) => set('poll_hz', v)} />
        <NumberRow label="登录有效期" unit="小时" min={1} max={8760} step={24} value={draft.session_ttl_h ?? 720} onChange={(v) => set('session_ttl_h', v)} />
      </GroupedList>

      <AttentionSettings />

      <GroupedList header="此浏览器" footer="这些设置只保存在当前浏览器中。">
        <SwitchRow
          label="单键快捷键"
          help="例如空格暂停、U / D 抬落笔。关闭后只保留带 ⌘ / Ctrl 的快捷键。"
          checked={singleKey}
          onChange={(v) => {
            setSingleKeyShortcutsEnabled(v)
            setSingleKey(v)
          }}
        />
      </GroupedList>
    </div>
  )
}
