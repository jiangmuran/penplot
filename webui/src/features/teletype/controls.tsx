import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ArrowUpFromLine, Crosshair, House } from 'lucide-react'
import * as React from 'react'
import { runAction } from '@/api/machine'
import { jog, setPen } from '@/api/machine-control'
import { useLive } from '@/api/store'
import { describeError } from '@/api/errors'
import { useFonts } from '@/api/fonts'
import { DEFAULT_FORM, geometryFor, MONO_FONT, teletypeApi, type SessionForm } from '@/api/teletype'
import { Button, Card, CardHeader, Combobox, IconButton, NumberField, Select, Switch, type ComboboxOption } from '@/components/ui'
import { homeWithConfirm, zeroWithConfirm } from '@/features/machine/dro-card'
import type { MachineGate } from '@/features/machine/gate'
import { cn } from '@/lib/cn'
import { confirm } from '@/lib/confirm'
import { useTeletypePreview } from './preview'
import { applyTeletypeState, useTeletype } from './store'

async function setOriginInSession() {
  const ok = await confirm({
    title: '把笔现在的位置设为原点？',
    description: '原点 = 纸面第一行第一个字的左上角外侧（边距之外）。确认笔已抬起。',
    confirmLabel: '设为原点',
  })
  if (ok) await runAction('设原点失败', async () => applyTeletypeState(await teletypeApi.action('set_origin')), '已设为原点')
}

/** Jog + set-origin: normal machine endpoints (/machine/jog, /machine/zero); inside a session the origin goes through the teletype action. */
export function JogCard({ gate, compact }: { gate: MachineGate; compact?: boolean }) {
  const [step, setStep] = React.useState(5)
  const pen = useLive((s) => s.machine?.pen)
  const active = useTeletype((s) => s.active)
  const pending = useTeletype((s) => s.pending)
  const streaming = active && pending > 0
  const d = !gate.canMove || streaming
  const reason = streaming ? '正在书写，写完后才能移动' : gate.reason
  const j = (dx: number, dy: number) => runAction('点动失败', () => jog({ dx: dx * step, dy: dy * step }, 3000))
  const size = compact ? 'size-12' : 'size-10'
  const btn = (label: string, icon: React.ReactNode, onClick: () => void) => (
    <IconButton label={label} variant="gray" disabled={d} onClick={onClick} className={cn(size, 'rounded-lg')}>
      {icon}
    </IconButton>
  )
  return (
    <Card>
      <CardHeader title="定位" subtitle={!d ? '把笔（抬起状态）停在要写内容的左上角，再设为原点' : reason} />
      <div className="flex flex-wrap items-center gap-4 px-4 pb-4">
        <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="XY 点动">
          <span />
          {btn(`Y+ ${step} mm`, <ArrowUp />, () => j(0, 1))}
          <span />
          {btn(`X− ${step} mm`, <ArrowLeft />, () => j(-1, 0))}
          {btn('把当前位置设为原点', <Crosshair />, () => void (active ? setOriginInSession() : zeroWithConfirm('xy', pen)))}
          {btn(`X+ ${step} mm`, <ArrowRight />, () => j(1, 0))}
          <span />
          {btn(`Y− ${step} mm`, <ArrowDown />, () => j(0, -1))}
          <span />
        </div>
        <div className="flex min-w-36 max-w-56 flex-1 flex-col gap-2">
          <label className="flex flex-col gap-1 text-footnote text-secondary-label">
            步长
            <NumberField value={step} onChange={setStep} min={0.1} max={50} step={1} unit="mm" aria-label="点动步长" />
          </label>
          <div className="flex gap-2">
            <Button variant="gray" size="sm" icon={<ArrowUpFromLine />} disabled={d} onClick={() => runAction('抬笔失败', () => setPen('up'))}>
              抬笔
            </Button>
            <Button variant="gray" size="sm" icon={<House />} disabled={d} onClick={() => void homeWithConfirm()}>
              回原点
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}

type NumKey = 'char_h' | 'feed' | 'margin' | 'paper_w' | 'paper_h' | 'max_backlog' | 'z_up' | 'letter_spacing' | 'line_spacing'
type Field = { k: NumKey; label: string; unit: string; step: number; min: number; max: number; help?: string; auto?: string }
const FIELDS: Field[] = [
  { k: 'char_h', label: '字高', unit: 'mm', step: 0.5, min: 1, max: 30, help: '内置字体 = 大写字母高；其他字体 = 汉字高（无汉字的字体按大写字母高）' },
  { k: 'feed', label: '书写速度', unit: 'mm/min', step: 500, min: 100, max: 20000 },
  { k: 'letter_spacing', label: '字距', unit: 'mm', step: 0.1, min: -5, max: 20, auto: '自动', help: '每个半角格之间的空隙；汉字占两格，字距算两次。留空 = 自动（约字高的 13%）' },
  { k: 'line_spacing', label: '行距', unit: '× 字高', step: 0.1, min: 0.8, max: 5, auto: '自动', help: '行与行的间距是字高的几倍。留空 = 自动（内置字体 1.6，其他字体 1.45）' },
  { k: 'margin', label: '边距', unit: 'mm', step: 1, min: 0, max: 100 },
  { k: 'z_up', label: '行进抬笔 Z', unit: 'mm', step: 0.5, min: 0, max: 20, auto: '机器默认', help: '字间移动时的抬笔高度；留空 = 机器配置的抬笔位。笔尖 3–4 mm 就离纸时调小可明显提速' },
  { k: 'paper_w', label: '纸宽', unit: 'mm', step: 1, min: 20, max: 2000 },
  { k: 'paper_h', label: '纸高', unit: 'mm', step: 1, min: 20, max: 2000 },
  { k: 'max_backlog', label: '积压上限', unit: '字', step: 100, min: 50, max: 100000, help: '终端模式：待写字数超过上限后，后续输出不再上纸，之后补一行省略说明' },
]
const NULLABLE: NumKey[] = ['z_up', 'letter_spacing', 'line_spacing']

const PRESETS: { id: string; label: string; w: number; h: number }[] = [
  { id: 'a4', label: 'A4 竖 210×297', w: 210, h: 297 },
  { id: 'a4l', label: 'A4 横 297×210', w: 297, h: 210 },
  { id: 'a5', label: 'A5 竖 148×210', w: 148, h: 210 },
  { id: 'b5', label: 'B5 竖 176×250', w: 176, h: 250 },
  { id: 'letter', label: 'Letter 216×279', w: 216, h: 279 },
]

/** Font choice: the built-in monospace ASCII font (default, terminal mode) or any font in the library. */
export function FontSelect({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const fonts = useFonts({})
  const options: ComboboxOption[] = [
    { value: MONO_FONT, label: '内置等宽（ASCII）', description: '最快，终端模式固定使用；汉字画成方框' },
    ...(fonts.data ?? []).map((f) => ({ value: f.id, label: f.display_name, description: `${f.glyph_count} 字`, keywords: [f.id] })),
  ]
  if (!options.some((o) => o.value === value)) options.push({ value, label: value })
  return (
    <Combobox
      value={value}
      onValueChange={onChange}
      options={options}
      disabled={disabled}
      placeholder="选择字体"
      searchPlaceholder="搜索字库"
      aria-label="书写字体"
    />
  )
}

/**
 * Session settings. Before a session: the form for POST /teletype/session. During a session:
 * POST /teletype/action settings (speed / Z apply to new chars; font / size / spacing / paper / margin on an empty
 * page or the next sheet).
 */
export function SettingsForm({
  disabled, form, onFormChange,
}: { disabled: boolean; form: SessionForm; onFormChange: (f: SessionForm) => void }) {
  const active = useTeletype((s) => s.active)
  const cfg = useTeletype((s) => s.cfg)
  const mode = useTeletype((s) => s.mode)
  const showBacklog = useTeletype((s) => s.terminalEnabled)
  const fields = FIELDS.filter((f) => f.k !== 'max_backlog' || showBacklog)
  const [busy, setBusy] = React.useState(false)
  const live: SessionForm | null = cfg
    ? {
        char_h: cfg.char_h, feed: cfg.feed, margin: cfg.margin, paper_w: cfg.paper_w, paper_h: cfg.paper_h, z_up: cfg.z_up,
        max_backlog: cfg.max_backlog, set_zero: true, font_id: cfg.font_id ?? MONO_FONT,
        letter_spacing: cfg.letter_spacing ?? null, line_spacing: cfg.line_spacing ?? null,
      }
    : null
  const [draft, setDraft] = React.useState<SessionForm>(live ?? form)
  const liveKey = JSON.stringify(live)
  React.useEffect(() => {
    if (live) setDraft(live)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey])
  const value = active ? draft : form
  const change = (f: SessionForm) => (active ? setDraft(f) : onFormChange(f))
  const preview = useTeletypePreview(value)
  const geo = preview.data?.geo ?? (value.font_id === MONO_FONT ? geometryFor(value) : null)
  const previewErr = preview.error ? describeError(preview.error).title : null
  const dirty = active && live != null && (FIELDS.some((f) => draft[f.k] !== live[f.k]) || draft.font_id !== live.font_id)
  const preset = PRESETS.find((p) => p.w === value.paper_w && p.h === value.paper_h)?.id ?? 'custom'

  const apply = async () => {
    setBusy(true)
    try {
      await runAction('应用设置失败', async () => {
        const { set_zero: _s, ...args } = draft
        void _s
        applyTeletypeState(await teletypeApi.action('settings', args))
      }, '已应用设置')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-footnote text-secondary-label">
        字体
        <FontSelect value={value.font_id} disabled={disabled} onChange={(id) => change({ ...value, font_id: id })} />
      </label>
      {preview.data && !preview.data.font.cjk && value.font_id !== MONO_FONT ? (
        <p className="-mt-1 text-footnote text-orange">这款字体没有汉字，汉字会画成方框。</p>
      ) : null}
      {mode === 'term' && active ? <p className="-mt-1 text-footnote text-secondary-label">终端模式始终用内置等宽字体书写，字体只影响打字模式。</p> : null}
      <label className="flex flex-col gap-1 text-footnote text-secondary-label">
        纸张
        <Select
          value={preset}
          disabled={disabled}
          aria-label="纸张尺寸"
          onValueChange={(id) => {
            const p = PRESETS.find((x) => x.id === id)
            if (p) change({ ...value, paper_w: p.w, paper_h: p.h })
          }}
          options={[...PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: 'custom', label: '自定义尺寸', disabled: true }]}
        />
      </label>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        {fields.map((f) => (
          <label key={f.k} className="flex min-w-0 flex-col gap-1 text-footnote text-secondary-label" title={f.help}>
            <span className="flex items-center gap-1 truncate">
              {f.label}
              <span className="text-tertiary-label"> · {f.unit}</span>
              {NULLABLE.includes(f.k) && value[f.k] != null && !disabled ? (
                <button type="button" className="ml-auto text-accent" onClick={(e) => { e.preventDefault(); change({ ...value, [f.k]: null }) }}>
                  {f.auto}
                </button>
              ) : null}
            </span>
            <NumberField
              value={value[f.k]}
              onChange={(v) => change({ ...value, [f.k]: v })}
              min={f.min}
              max={f.max}
              step={f.step}
              stepper={false}
              disabled={disabled}
              placeholder={f.auto}
              aria-label={`${f.label}（${f.unit}）`}
            />
          </label>
        ))}
      </div>
      {!active ? (
        <label className="flex items-start justify-between gap-3 text-callout text-label">
          <span className="min-w-0">
            把笔现在的位置设为原点
            <span className="block text-footnote text-secondary-label">
              开始前：把笔（抬起状态）停在要写内容的左上角。关闭后沿用已设的原点。
            </span>
          </span>
          <Switch checked={value.set_zero} disabled={disabled} onCheckedChange={(v: boolean) => change({ ...value, set_zero: v })} aria-label="开始时设为原点" />
        </label>
      ) : null}
      <p className="text-footnote text-secondary-label tabular-nums" data-testid="tt-grid">
        {previewErr ? <span className="text-red">{previewErr}</span>
        : geo ? <>每页 {geo.rows} 行，每行 {geo.cols} 个半角字（约 {Math.floor(geo.cols / 2)} 个汉字）。</> : '正在计算版面…'}
        {active ? ' 速度和抬笔高度对新字立即生效；字体、字高、间距、纸张在空白页或下一页生效。' : null}
      </p>
      {active ? (
        <div className="flex gap-2">
          <Button variant="filled" loading={busy} disabled={disabled || !dirty} onClick={apply}>
            应用设置
          </Button>
          <Button variant="gray" disabled={!dirty} onClick={() => live && setDraft(live)}>
            还原
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export { DEFAULT_FORM }
