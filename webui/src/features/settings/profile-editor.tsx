/**
 * Structured editor for a machine profile doc (01 §12 K2/K3, 04 §10). Every change is saved
 * immediately (debounced PATCH deep-merge) with an inline status.
 */
import { ChevronRight, Info, RefreshCw } from 'lucide-react'
import * as React from 'react'
import { useLive } from '@/api/store'
import { patchProfile, useMachinePorts, type Profile, type ProfileDoc } from '@/api/profiles'
import { queryClient, qk } from '@/api/query'
import {
  Combobox, FormRow, GroupedList, IconButton, Select, Textarea,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { HelpLink } from '@/features/help/HelpLink'
import { NumberRow, SaveIndicator, SwitchRow, useSaveStatus } from './shared'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

type Dict = Record<string, unknown>
type Draft = Record<string, unknown>

const BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 250000]
const MACHINE_TYPES = [
  { value: 'Grbl', label: 'GRBL' },
  { value: 'Marlin', label: 'Marlin' },
  { value: 'Ebb', label: 'EBB（AxiDraw）' },
  { value: 'K_AT', label: 'K_AT' },
]
const GRBL_PEN = [
  { value: 'Stepper', label: 'Z 步进电机' },
  { value: 'Servo', label: '舵机' },
  { value: 'Servo_bachin', label: '舵机（Bachin）' },
  { value: 'Laser', label: '激光' },
]
const MARLIN_PEN = [
  { value: 'Servo', label: '舵机' },
  { value: 'Stepper', label: 'Z 步进电机' },
]
const CORNERS = ['左上', '右上', '左下', '右下']

function deepMerge(a: Dict, b: Dict): Dict {
  const out: Dict = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k]
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' && !Array.isArray(prev) ? deepMerge(prev as Dict, v as Dict) : v
  }
  return out
}

/** Baseline values for 恢复默认 (configs/grbl-zpen.json + penplot/settings.py defaults). */
export const PROFILE_DEFAULTS: Record<string, Dict> = {
  connection: { baud: 115200, auto_connect: true, reset_on_connect: false },
  speed: { 'settings.feedRate': 1500, 'settings.jogSpeed': 2500 },
  grbl: { type: 'Stepper', penUpPos: 50, penDownPos: 0, ecoServo: false, zOn: 8, zOff: 0, zSpeed: 5000, laserS: 1000 },
  marlin: { type: 'Servo', penUpPos: 50, penDownPos: 0, penUpMM: 0, penDownMM: 2, zSpeed: 3000, fanSpeed: 255 },
  ebb: { mmToSteps: 100, penUpPos: 12000, penDownPos: 18000, penUpSpeed: 750, penDownSpeed: 750 },
  kat: { penUpE: 0.2, penDownE: 6, penSpeed: 4000 },
  delays: { 'settings.toolOnDelay': 0, 'settings.toolOffDelay': 0 },
  origin: { 'axes.pos': 0, 'axes.revxy': false, 'axes.xAxeRev': false, 'axes.yAxeRev': false, 'settings.offsetX': 0, 'settings.offsetY': 0, 'settings.rotate': 0 },
  work_area: { w_mm: 0, h_mm: 0 },
  general: {
    'settings.nearDst': 0.3, 'settings.dpi': 96, 'settings.maxImageSize': 4000, 'settings.autoSetZero': true,
    'settings.autoSleep': false, 'settings.singleStep': false, 'settings.alertFileComplete': true,
  },
  print_defaults: { optimize: null, stop_on_error: null, simplify: null, multi_page: null },
  macros: { 'advanced.macro1': '', 'advanced.macro2': '', 'advanced.macro3': '', 'advanced.zJogStep': 1 },
}

/** {group:{k:v}} from a defaults entry (`group` = target section unless keys are dotted). */
function defaultsPatch(group: string): Dict {
  const d = PROFILE_DEFAULTS[group] ?? {}
  const out: Dict = {}
  for (const [k, v] of Object.entries(d)) {
    const [sec, key] = k.includes('.') ? k.split('.') : [group, k]
    out[sec] = { ...(out[sec] as Dict | undefined), [key]: v }
  }
  return out
}

function useProfileDraft(profile: Profile) {
  const [draft, setDraft] = React.useState<Draft>(() => clone(profile.doc) as Draft)
  const draftRef = React.useRef(draft)
  draftRef.current = draft
  const pending = React.useRef<Dict>({})
  const undoPending = React.useRef<Dict>({})
  const [lastUndo, setLastUndo] = React.useState<Dict | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const save = useSaveStatus()
  const id = profile.id

  const flush = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const patch = pending.current
    const undo = undoPending.current
    pending.current = {}
    undoPending.current = {}
    if (!Object.keys(patch).length) return
    setLastUndo(undo)
    save
      .run(() => patchProfile(id, { doc: patch }))
      .then((p) => {
        if (p) queryClient.setQueryData<Profile[]>(qk.profiles.list(), (list) => list?.map((x) => (x.id === p.id ? p : x)))
      })
      .catch(() => {
        /* status shows the failure; reload the server copy */
        void queryClient.invalidateQueries({ queryKey: qk.profiles.all })
      })
  }, [id, save])

  React.useEffect(() => () => flush(), [flush])

  /** Apply a {section:{key:value}} (or top-level) patch; remembers previous values for 撤销. */
  const apply = React.useCallback(
    (patch: Dict) => {
      const cur = draftRef.current
      for (const [k, v] of Object.entries(patch)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const prevSec = (cur[k] ?? {}) as Dict
          const u = (undoPending.current[k] ?? {}) as Dict
          for (const kk of Object.keys(v as Dict)) if (!(kk in u)) u[kk] = prevSec[kk] ?? null
          undoPending.current[k] = u
        } else if (!(k in undoPending.current)) undoPending.current[k] = cur[k] ?? null
      }
      setDraft((d) => deepMerge(d, patch))
      pending.current = deepMerge(pending.current, patch)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(flush, 600)
    },
    [flush],
  )
  const set = React.useCallback(
    (group: string | null, key: string, value: unknown) => apply(group ? { [group]: { [key]: value } } : { [key]: value }),
    [apply],
  )
  const undo = React.useCallback(() => {
    if (!lastUndo) return
    apply(lastUndo)
    setLastUndo(null)
  }, [apply, lastUndo])
  const get = <T,>(group: string | null, key: string, fallback: T): T => {
    const src = group ? (draft[group] as Dict | undefined) : draft
    const v = src?.[key]
    return (v === undefined || v === null ? fallback : v) as T
  }
  return { draft, set, apply, get, save, flush, undo: lastUndo ? undo : undefined }
}

/** 2×2 corner picker (axes.pos / origin.corner): 0 LeftUp, 1 RightUp, 2 LeftDown, 3 RightDown. */
function CornerPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div role="radiogroup" aria-label="原点所在角" className="relative h-[72px] w-[56px] shrink-0 rounded-[3px] bg-canvas-paper shadow-paper">
      {CORNERS.map((label, i) => {
        const pos = ['left-0 top-0', 'right-0 top-0', 'left-0 bottom-0', 'right-0 bottom-0'][i]
        const on = value === i
        return (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={label}
            title={label}
            onClick={() => onChange(i)}
            className={cn('focus-ring absolute flex size-6 items-center justify-center rounded-full pointer-coarse:size-9', pos, '-m-2.5 pointer-coarse:-m-4')}
          >
            <span className={cn('block rounded-full transition-all', on ? 'size-3.5 bg-accent ring-2 ring-accent/30' : 'size-2.5 bg-tertiary-label hover:bg-secondary-label')} />
          </button>
        )
      })}
    </div>
  )
}

function SelectRow({ label, help, value, onChange, options }: { label: React.ReactNode; help?: React.ReactNode; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const id = React.useId()
  return (
    <FormRow label={label} htmlFor={id} help={help}>
      <Select id={id} value={value} onValueChange={onChange} options={options} className="min-w-36" />
    </FormRow>
  )
}

/** Tri-state for print_defaults booleans: inherit / on / off. */
function TriRow({ label, help, value, onChange }: { label: React.ReactNode; help?: React.ReactNode; value: boolean | null | undefined; onChange: (v: boolean | null) => void }) {
  return (
    <SelectRow
      label={label}
      help={help}
      value={value == null ? 'inherit' : value ? 'on' : 'off'}
      onChange={(v) => onChange(v === 'inherit' ? null : v === 'on')}
      options={[
        { value: 'inherit', label: '默认' },
        { value: 'on', label: '开启' },
        { value: 'off', label: '关闭' },
      ]}
    />
  )
}

function GcodeField({ label, value, onChange, placeholder, rows = 4 }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  const [text, setText] = React.useState(value)
  const id = React.useId()
  React.useEffect(() => setText(value), [value])
  return (
    <FormRow label={label} htmlFor={id} stacked>
      <Textarea
        id={id}
        rows={rows}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={() => text !== value && onChange(text)}
        className="font-mono text-footnote"
      />
    </FormRow>
  )
}

function PortRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ports = useMachinePorts()
  const id = React.useId()
  const options = React.useMemo(() => {
    const list = (ports.data ?? []).map((p) => ({
      value: p.by_id || p.path,
      label: (p.by_id || p.path).replace('/dev/serial/by-id/', ''),
      description: [p.by_id ? p.path : null, p.description && p.description !== 'n/a' ? p.description : null, p.busy_pid ? `被进程 ${p.busy_pid} 占用` : null].filter(Boolean).join(' · ') || undefined,
      keywords: [p.path, p.description ?? ''],
    }))
    // USB serial adapters first
    list.sort((a, b) => Number(/ttyS\d/.test(a.value)) - Number(/ttyS\d/.test(b.value)))
    if (value && !list.some((o) => o.value === value)) list.unshift({ value, label: value.replace('/dev/serial/by-id/', ''), description: '当前配置（未检测到）', keywords: [] })
    return list
  }, [ports.data, value])
  return (
    <FormRow label="串口" htmlFor={id} help={ports.isError ? '无法读取串口列表' : undefined}>
      <Combobox id={id} value={value} onValueChange={onChange} options={options} placeholder="选择串口" searchPlaceholder="搜索串口" emptyText="未发现串口设备" className="max-w-64 flex-1" />
      <IconButton label="刷新串口列表" onClick={() => void ports.refetch()} loading={ports.isFetching}>
        <RefreshCw />
      </IconButton>
    </FormRow>
  )
}

function Group({ title, footer, onReset, children }: { title: React.ReactNode; footer?: React.ReactNode; onReset?: () => void; children: React.ReactNode }) {
  return (
    <GroupedList
      header={
        <span className="flex items-center justify-between gap-2 normal-case tracking-normal">
          <span>{title}</span>
          {onReset ? (
            <button type="button" onClick={onReset} className="focus-ring -my-1 rounded-sm px-1.5 py-1 text-footnote font-normal text-accent hover:bg-accent/10 pointer-coarse:min-h-11">
              恢复默认
            </button>
          ) : null}
        </span>
      }
      footer={footer}
    >
      {children}
    </GroupedList>
  )
}

const ADV_KEY = 'penplot.settings.machineAdvanced'

export function ProfileEditor({ profile }: { profile: Profile }) {
  const { draft, set, apply, get, save, undo } = useProfileDraft(profile)
  const connected = useLive((s) => !!s.machine?.connected)
  const [connChanged, setConnChanged] = React.useState(false)
  const [advanced, setAdvanced] = React.useState(() => localStorage.getItem(ADV_KEY) === '1')
  const type = get<string>(null, 'type', 'Grbl')
  const grblType = get<string>('grbl', 'type', 'Stepper')
  const marlinType = get<string>('marlin', 'type', 'Servo')
  const pd = (draft.print_defaults ?? {}) as NonNullable<ProfileDoc['print_defaults']>
  const setConn = (k: string, v: unknown) => {
    set('connection', k, v)
    // the legacy settings.autoConnect mirrors connection.auto_connect (one switch in the UI)
    if (k === 'auto_connect') set('settings', 'autoConnect', v)
    if (profile.is_active && (k === 'port' || k === 'baud')) setConnChanged(true)
  }
  const reset = (g: string) => () => apply(defaultsPatch(g))
  const toggleAdvanced = () => {
    setAdvanced((a) => {
      localStorage.setItem(ADV_KEY, a ? '0' : '1')
      return !a
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-3 px-1">
        <h3 className="min-w-0 truncate text-headline text-label">编辑「{profile.name}」</h3>
        <SaveIndicator status={save.status} error={save.error} onUndo={undo} />
      </div>

      {connChanged && connected ? (
        <div role="status" className="flex items-start gap-2 rounded-lg bg-orange/15 px-3 py-2.5 text-callout text-on-tint-orange">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>串口设置已修改。断开后重新连接，新设置才会生效。</span>
        </div>
      ) : null}

      <Group title="机器类型" footer="只显示当前机型用到的设置。切换类型后要重新连接。">
        <SelectRow label="控制器" value={type} onChange={(v) => set(null, 'type', v)} options={MACHINE_TYPES} />
      </Group>

      <Group title="连接" onReset={reset('connection')}>
        <PortRow value={get<string>('connection', 'port', '')} onChange={(v) => setConn('port', v)} />
        <SelectRow label="波特率" value={String(get<number>('connection', 'baud', 115200))} onChange={(v) => setConn('baud', Number(v))} options={BAUDS.map((b) => ({ value: String(b), label: String(b) }))} />
        <SwitchRow label="启动时自动连接" checked={get('connection', 'auto_connect', true)} onChange={(v) => setConn('auto_connect', v)} />
        <SwitchRow
          label="连接时复位控制板"
          help="复位后坐标和笔的位置都会丢失，需要重新设原点。CH340 串口在打开时本身也可能让主板复位。"
          checked={get('connection', 'reset_on_connect', false)}
          onChange={(v) => setConn('reset_on_connect', v)}
        />
      </Group>

      <Group title="速度" onReset={reset('speed')}>
        <NumberRow label={<>写字速度<HelpLink topic="feed-rate" className="ml-1" /></>} unit="mm/分" min={1} max={100000} step={50} value={get('settings', 'feedRate', 1500)} onChange={(v) => set('settings', 'feedRate', v)} />
        <NumberRow label="空走 / 点动速度" help="抬笔移动和手动点动时的速度。" unit="mm/分" min={1} max={100000} step={50} value={get('settings', 'jogSpeed', 2500)} onChange={(v) => set('settings', 'jogSpeed', v)} />
      </Group>

      {type === 'Grbl' ? (
        <Group title="笔（GRBL）" onReset={reset('grbl')} footer={grblType === 'Stepper' ? 'Z 步进笔：Z 0 是抬笔位（静止位置），数字越大笔压得越深。本机落笔深度一般是 8 mm。' : undefined}>
          <SelectRow label="笔类型" value={grblType} onChange={(v) => set('grbl', 'type', v)} options={GRBL_PEN} />
          {grblType === 'Stepper' ? (
            <>
              <NumberRow label={<>落笔深度<HelpLink topic="pen" className="ml-1" /></>} unit="mm" min={0} max={20} step={0.1} value={get('grbl', 'zOn', 8)} onChange={(v) => set('grbl', 'zOn', v)} />
              <NumberRow label="抬笔位" unit="mm" min={0} max={20} step={0.1} value={get('grbl', 'zOff', 0)} onChange={(v) => set('grbl', 'zOff', v)} />
              <NumberRow label="抬落笔速度" unit="mm/分" min={1} max={100000} step={100} value={get('grbl', 'zSpeed', 5000)} onChange={(v) => set('grbl', 'zSpeed', v)} />
            </>
          ) : grblType === 'Laser' ? (
            <NumberRow label="激光功率 S" min={0} max={100000} step={10} value={get('grbl', 'laserS', 1000)} onChange={(v) => set('grbl', 'laserS', v)} />
          ) : (
            <>
              <NumberRow label="抬笔角度" min={0} max={255} value={get('grbl', 'penUpPos', 50)} onChange={(v) => set('grbl', 'penUpPos', v)} />
              <NumberRow label="落笔角度" min={0} max={255} value={get('grbl', 'penDownPos', 0)} onChange={(v) => set('grbl', 'penDownPos', v)} />
              <SwitchRow label="节能舵机" checked={get('grbl', 'ecoServo', false)} onChange={(v) => set('grbl', 'ecoServo', v)} />
            </>
          )}
        </Group>
      ) : type === 'Marlin' ? (
        <Group title="笔（Marlin）" onReset={reset('marlin')}>
          <SelectRow label="笔类型" value={marlinType} onChange={(v) => set('marlin', 'type', v)} options={MARLIN_PEN} />
          {marlinType === 'Stepper' ? (
            <>
              <NumberRow label="落笔深度" unit="mm" min={0} max={20} step={0.1} value={get('marlin', 'penDownMM', 2)} onChange={(v) => set('marlin', 'penDownMM', v)} />
              <NumberRow label="抬笔位" unit="mm" min={0} max={20} step={0.1} value={get('marlin', 'penUpMM', 0)} onChange={(v) => set('marlin', 'penUpMM', v)} />
              <NumberRow label="抬落笔速度" unit="mm/分" min={1} max={100000} step={100} value={get('marlin', 'zSpeed', 3000)} onChange={(v) => set('marlin', 'zSpeed', v)} />
            </>
          ) : (
            <>
              <NumberRow label="抬笔角度" min={0} max={255} value={get('marlin', 'penUpPos', 50)} onChange={(v) => set('marlin', 'penUpPos', v)} />
              <NumberRow label="落笔角度" min={0} max={255} value={get('marlin', 'penDownPos', 0)} onChange={(v) => set('marlin', 'penDownPos', v)} />
            </>
          )}
          <NumberRow label="风扇速度" min={0} max={255} value={get('marlin', 'fanSpeed', 255)} onChange={(v) => set('marlin', 'fanSpeed', v)} />
        </Group>
      ) : type === 'Ebb' ? (
        <Group title="笔（EBB）" onReset={reset('ebb')}>
          <NumberRow label="每毫米步数" min={1} max={10000} value={get('ebb', 'mmToSteps', 100)} onChange={(v) => set('ebb', 'mmToSteps', v)} />
          <NumberRow label="抬笔位置" min={0} max={65535} step={100} value={get('ebb', 'penUpPos', 12000)} onChange={(v) => set('ebb', 'penUpPos', v)} />
          <NumberRow label="落笔位置" min={0} max={65535} step={100} value={get('ebb', 'penDownPos', 18000)} onChange={(v) => set('ebb', 'penDownPos', v)} />
          <NumberRow label="抬笔速度" min={1} max={10000} step={10} value={get('ebb', 'penUpSpeed', 750)} onChange={(v) => set('ebb', 'penUpSpeed', v)} />
          <NumberRow label="落笔速度" min={1} max={10000} step={10} value={get('ebb', 'penDownSpeed', 750)} onChange={(v) => set('ebb', 'penDownSpeed', v)} />
        </Group>
      ) : (
        <Group title="笔（K_AT）" onReset={reset('kat')} footer="出纸位置和停靠位置目前由固件决定，暂时不能修改。">
          <NumberRow label="抬笔 E" unit="mm" min={0} max={50} step={0.1} value={get('kat', 'penUpE', 0.2)} onChange={(v) => set('kat', 'penUpE', v)} />
          <NumberRow label="落笔 E" unit="mm" min={0} max={50} step={0.1} value={get('kat', 'penDownE', 6)} onChange={(v) => set('kat', 'penDownE', v)} />
          <NumberRow label="抬落笔速度" unit="mm/分" min={1} max={100000} step={100} value={get('kat', 'penSpeed', 4000)} onChange={(v) => set('kat', 'penSpeed', v)} />
        </Group>
      )}

      <Group
        title={<>机器行程（可选）<HelpLink topic="travel" className="ml-1" /></>}
        onReset={reset('work_area')}
        footer={
          get('work_area', 'w_mm', 0) > 0 && get('work_area', 'h_mm', 0) > 0
            ? '笔从原点能走到的范围。超出行程的任务会在开始前被拦下。'
            : '留空 / 0 = 不检查行程（本机没有回零开关，开机时笔可能在任何位置）。只检查内容是否在纸内。'
        }
      >
        <NumberRow label="宽度（X）" unit="mm" min={0} max={5000} step={1} value={get('work_area', 'w_mm', 0)} onChange={(v) => set('work_area', 'w_mm', v)} />
        <NumberRow label="高度（Y）" unit="mm" min={0} max={5000} step={1} value={get('work_area', 'h_mm', 0)} onChange={(v) => set('work_area', 'h_mm', v)} />
      </Group>

      <Group title={<>原点与方向<HelpLink topic="origin" className="ml-1" /></>} onReset={reset('origin')} footer="原点＝开始写字时笔所在的位置。默认是要写内容的左上角（纸夹常挡住纸角）；偏移从所选的角向内测量。">
        <SelectRow
          label="原点对齐"
          help="内容：笔停在要写内容的角上；纸张：笔停在纸张的角上。"
          value={((draft.print_defaults as Dict | undefined)?.origin as Dict | undefined)?.anchor === 'content' ? 'content' : 'paper'}
          onChange={(v) => apply({ print_defaults: { origin: { anchor: v } } })}
          options={[{ value: 'content', label: '内容的角' }, { value: 'paper', label: '纸张的角' }]}
        />
        <div className="flex items-center gap-5 px-4 py-3">
          <CornerPicker value={get('axes', 'pos', 0)} onChange={(v) => set('axes', 'pos', v)} />
          <div className="min-w-0 flex-1">
            <p className="text-body text-label">原点在{((draft.print_defaults as Dict | undefined)?.origin as Dict | undefined)?.anchor === 'content' ? '内容' : '纸张'}{CORNERS[get('axes', 'pos', 0)] ?? '左上'}角</p>
            <p className="text-footnote text-secondary-label">点小圆点，选择开始时笔停在哪个角。</p>
          </div>
        </div>
        <SwitchRow label="交换 X / Y" checked={get('axes', 'revxy', false)} onChange={(v) => set('axes', 'revxy', v)} />
        <SwitchRow label="X 轴反向" checked={get('axes', 'xAxeRev', false)} onChange={(v) => set('axes', 'xAxeRev', v)} />
        <SwitchRow label="Y 轴反向" checked={get('axes', 'yAxeRev', false)} onChange={(v) => set('axes', 'yAxeRev', v)} />
        <SwitchRow label="开始时自动设原点" help="开始写字时，把笔当前的位置设为原点。" checked={get('settings', 'autoSetZero', true)} onChange={(v) => set('settings', 'autoSetZero', v)} />
      </Group>

      <button
        type="button"
        onClick={toggleAdvanced}
        aria-expanded={advanced}
        aria-controls="profile-advanced"
        className="focus-ring flex min-h-11 items-center gap-2 rounded-lg px-4 text-left text-body text-label hover:bg-quaternary-fill"
      >
        <ChevronRight className={cn('size-4 text-secondary-label transition-transform duration-[var(--dur-fast)]', advanced && 'rotate-90')} aria-hidden />
        <span className="flex-1 font-medium">高级设置</span>
        <span className="text-footnote text-secondary-label">偏移、延时、起止 G 代码、宏…</span>
      </button>

      {advanced ? (
        <div id="profile-advanced" className="flex flex-col gap-6">
          <Group title={<>位置微调<HelpLink topic="offset" className="ml-1" /></>} onReset={reset('origin')}>
            <NumberRow label="X 偏移" unit="mm" min={-1000} max={1000} step={0.5} value={get('settings', 'offsetX', 0)} onChange={(v) => set('settings', 'offsetX', v)} />
            <NumberRow label="Y 偏移" unit="mm" min={-1000} max={1000} step={0.5} value={get('settings', 'offsetY', 0)} onChange={(v) => set('settings', 'offsetY', v)} />
            <NumberRow label="旋转" unit="°" min={-360} max={360} step={90} value={get('settings', 'rotate', 0)} onChange={(v) => set('settings', 'rotate', v)} />
          </Group>

          <Group title="延时" onReset={reset('delays')} footer="落笔后、抬笔前停一下，给墨水或舵机留出时间。">
            <NumberRow label="落笔后等待" unit="秒" min={0} max={10} step={0.05} value={get('settings', 'toolOnDelay', 0)} onChange={(v) => set('settings', 'toolOnDelay', v)} />
            <NumberRow label="抬笔前等待" unit="秒" min={0} max={10} step={0.05} value={get('settings', 'toolOffDelay', 0)} onChange={(v) => set('settings', 'toolOffDelay', v)} />
          </Group>

          <Group title="通用" onReset={reset('general')}>
            <NumberRow label="合并距离" help="两笔的端点距离小于这个值时不抬笔，直接连上。" unit="mm" min={0} max={10} step={0.05} value={get('settings', 'nearDst', 0.3)} onChange={(v) => set('settings', 'nearDst', v)} />
            <NumberRow label="图片分辨率（DPI）" help="导入没有尺寸信息的图片时，按这个分辨率换算毫米。" min={10} max={2400} value={get('settings', 'dpi', 96)} onChange={(v) => set('settings', 'dpi', v)} />
            <NumberRow label="图片最大边长" unit="像素" min={100} max={20000} step={100} value={get('settings', 'maxImageSize', 4000)} onChange={(v) => set('settings', 'maxImageSize', v)} />
            <SwitchRow
              label="写完后休眠"
              help="写完后给电机断电。断电后可以用手推动笔架，原点就不准了：下次写字前要重新设原点。"
              checked={get('settings', 'autoSleep', false)}
              onChange={(v) => set('settings', 'autoSleep', v)}
            />
            <SwitchRow label="单步模式" help="每发一行都等写字机回应，速度很慢，只在排查问题时使用。" checked={get('settings', 'singleStep', false)} onChange={(v) => set('settings', 'singleStep', v)} />
            <SwitchRow label="写完时提醒" checked={get('settings', 'alertFileComplete', true)} onChange={(v) => set('settings', 'alertFileComplete', v)} />
          </Group>

          <Group title="打印默认值" onReset={reset('print_defaults')} footer="「默认」表示沿用上面的设置；项目和单次任务还可以再覆盖。">
            <TriRow label={<>路径优化<HelpLink topic="optimize" className="ml-1" /></>} help="重新排列笔画顺序，减少空走。" value={pd.optimize} onChange={(v) => set('print_defaults', 'optimize', v)} />
            <TriRow label="写字机报错时停止" value={pd.stop_on_error} onChange={(v) => set('print_defaults', 'stop_on_error', v)} />
            <NumberRow label="简化容差" unit="mm" min={0} max={5} step={0.05} value={pd.simplify ?? 0} onChange={(v) => set('print_defaults', 'simplify', v)} />
            <SelectRow
              label="多页任务"
              value={String(pd.multi_page ?? 'inherit')}
              onChange={(v) => set('print_defaults', 'multi_page', v === 'inherit' ? null : v)}
              options={[
                { value: 'inherit', label: '默认' },
                { value: 'separate_jobs', label: '每页一个任务' },
                { value: 'one_job_pause_between', label: '一个任务，页间暂停换纸' },
                { value: 'first_only', label: '只写第一页' },
              ]}
            />
          </Group>

          <Group title="起止 G 代码" footer="开始写字前、正常写完后发送。可以使用 {{变量}}。">
            <GcodeField label="开始 G 代码" value={get('advanced', 'startGcode', '')} onChange={(v) => set('advanced', 'startGcode', v)} placeholder="; 例如：G21 G90" />
            <GcodeField label="结束 G 代码" value={get('advanced', 'endGcode', '')} onChange={(v) => set('advanced', 'endGcode', v)} placeholder="; 例如：G0 X0 Y0" />
          </Group>

          <Group title="宏" onReset={reset('macros')} footer="在「控制」页一键运行。多行命令会逐行发送。">
            {[1, 2, 3].map((n) => (
              <GcodeField key={n} label={`宏 ${n}`} rows={2} value={get('advanced', `macro${n}`, '')} onChange={(v) => set('advanced', `macro${n}`, v)} placeholder="; 留空就不显示" />
            ))}
            <NumberRow label="Z 点动步长" unit="mm" min={0.01} max={10} step={0.1} value={get('advanced', 'zJogStep', 1)} onChange={(v) => set('advanced', 'zJogStep', v)} />
          </Group>
        </div>
      ) : null}
    </div>
  )
}
