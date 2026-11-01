import { Check, Monitor, Moon, Sun } from 'lucide-react'
import * as React from 'react'
import { FormRow, GroupedList, Segmented } from '@/components/ui'
import { cn } from '@/lib/cn'
import {
  getAccent, getDensity, getTheme, setAccent, setDensity, setTheme, type AccentPref, type DensityPref, type ThemePref,
} from '@/lib/theme'

const ACCENTS: { value: AccentPref; label: string; cls: string }[] = [
  { value: 'blue', label: '蓝色', cls: 'bg-blue' },
  { value: 'purple', label: '紫色', cls: 'bg-purple' },
  { value: 'pink', label: '粉色', cls: 'bg-pink' },
  { value: 'orange', label: '橙色', cls: 'bg-orange' },
  { value: 'green', label: '绿色', cls: 'bg-green' },
  { value: 'indigo', label: '靛蓝', cls: 'bg-indigo' },
  { value: 'teal', label: '青色', cls: 'bg-teal' },
]

const THEMES: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: '跟随系统', icon: Monitor },
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
]

function ThemeCard({ value, label, icon: Icon, selected, onSelect }: { value: ThemePref; label: string; icon: typeof Sun; selected: boolean; onSelect: () => void }) {
  const pane = (dark: boolean) => (
    <div className={cn('flex h-full flex-col gap-1 p-1.5', dark ? 'bg-[#1c1c1e]' : 'bg-[#f2f2f7]')}>
      <div className={cn('h-1.5 w-8 rounded-full', dark ? 'bg-white/30' : 'bg-black/20')} />
      <div className={cn('flex-1 rounded-[3px]', dark ? 'bg-[#2c2c2e]' : 'bg-white')} />
    </div>
  )
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="focus-ring press group flex flex-col items-center gap-1.5 rounded-lg p-1"
    >
      <span
        className={cn(
          'block h-[58px] w-[86px] overflow-hidden rounded-md shadow-sm ring-1 ring-separator transition-shadow',
          selected && 'ring-[3px] ring-accent',
        )}
        aria-hidden
      >
        {value === 'system' ? (
          <span className="grid h-full grid-cols-2">
            {pane(false)}
            {pane(true)}
          </span>
        ) : (
          pane(value === 'dark')
        )}
      </span>
      <span className={cn('inline-flex items-center gap-1 text-footnote', selected ? 'font-medium text-label' : 'text-secondary-label')}>
        <Icon className="size-3.5" aria-hidden />
        {label}
      </span>
    </button>
  )
}

export function AppearanceSection() {
  const [theme, setT] = React.useState<ThemePref>(getTheme)
  const [accent, setA] = React.useState<AccentPref>(getAccent)
  const [density, setD] = React.useState<DensityPref>(getDensity)

  return (
    <div className="flex flex-col gap-6">
      <GroupedList header="外观" footer="「跟随系统」会随操作系统的浅色 / 深色模式自动切换。">
        <div role="radiogroup" aria-label="外观模式" className="flex flex-wrap justify-center gap-4 px-4 py-4 sm:justify-start">
          {THEMES.map((t) => (
            <ThemeCard key={t.value} {...t} selected={theme === t.value} onSelect={() => { setTheme(t.value); setT(t.value) }} />
          ))}
        </div>
      </GroupedList>

      <GroupedList header="强调色" footer="用于主按钮、选中项、链接与进度。状态颜色（红 / 橙 / 绿）不受影响。">
        <div className="px-4 py-3">
          <div role="radiogroup" aria-label="强调色" className="flex flex-wrap items-center justify-between gap-2 sm:justify-start sm:gap-3.5">
            {ACCENTS.map((a) => (
              <button
                key={a.value}
                type="button"
                role="radio"
                aria-checked={accent === a.value}
                aria-label={a.label}
                title={a.label}
                onClick={() => { setAccent(a.value); setA(a.value) }}
                className={cn(
                  'focus-ring press flex size-7 items-center justify-center rounded-full shadow-sm pointer-coarse:size-9',
                  a.cls,
                  accent === a.value && 'ring-2 ring-offset-2 ring-offset-bg-grouped-secondary ring-[currentColor] text-label',
                )}
              >
                {accent === a.value ? <Check className="size-3.5 text-white pointer-coarse:size-4" strokeWidth={3} /> : null}
              </button>
            ))}
          </div>
        </div>
      </GroupedList>

      <GroupedList header="密度" footer="「自动」：鼠标操作时紧凑，触控设备（如 iPad）上自动使用舒适密度。">
        <FormRow label="界面密度">
          <Segmented
            aria-label="界面密度"
            value={density}
            onValueChange={(v) => { setDensity(v); setD(v) }}
            options={[
              { value: 'auto', label: '自动' },
              { value: 'compact', label: '紧凑' },
              { value: 'comfortable', label: '舒适' },
            ]}
          />
        </FormRow>
      </GroupedList>
    </div>
  )
}
