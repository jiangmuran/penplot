import { Link as LinkIcon } from 'lucide-react'
import * as React from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { describeError } from '@/api/errors'
import { unlockMachine } from '@/api/machine'
import { Button, EmptyState, SearchField } from '@/components/ui'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { GRBL_ALARMS, GRBL_ERRORS, GRBL_SETTINGS_META, type GrblCode } from './grbl-codes'

type Kind = 'error' | 'ALARM' | '$'

/** Row key used in `?code=`: `error:20`, `ALARM:3`, `$110`. */
function codeKey(kind: Kind, code: number) {
  return kind === '$' ? `$${code}` : `${kind}:${code}`
}
function normalizeKey(raw: string | null): string | null {
  if (!raw) return null
  const t = raw.trim()
  const m = /^(error|alarm):?(\d+)$/i.exec(t)
  if (m) return `${m[1].toLowerCase() === 'alarm' ? 'ALARM' : 'error'}:${Number(m[2])}`
  const s = /^\$(\d+)$/.exec(t)
  return s ? `$${Number(s[1])}` : null
}

function AlarmActions({ code }: { code: number }) {
  const navigate = useNavigate()
  const [busy, setBusy] = React.useState(false)
  const homing = code >= 6 && code <= 9
  const unlock = async () => {
    setBusy(true)
    try {
      await unlockMachine()
      toast.success('已解锁', { description: '请先抬笔，再确认原点是否还准确。' })
    } catch (e) {
      const d = describeError(e)
      toast.error(`解锁失败：${d.title}`, { description: d.hint })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {homing ? (
        <Button size="sm" variant="tinted" className="pointer-coarse:h-11" onClick={() => navigate('/console?tab=grbl&set=22:0')}>
          去关闭 $22
        </Button>
      ) : null}
      <Button size="sm" variant="gray" className="pointer-coarse:h-11" loading={busy} onClick={() => void unlock()}>
        解锁（$X）
      </Button>
    </div>
  )
}

function CodeTable({
  title, kind, codes, tone, target,
}: {
  title: string
  kind: Kind
  codes: GrblCode[]
  tone: 'red' | 'orange' | 'gray'
  target: string | null
}) {
  if (!codes.length) return null
  return (
    <section className="flex flex-col" aria-label={title}>
      <h3 className="mb-1.5 px-4 text-footnote font-medium text-secondary-label">
        {title} <span className="tabular-nums">· {codes.length}</span>
      </h3>
      <ul className="overflow-hidden rounded-lg bg-bg-grouped-secondary shadow-sm [&>*+*]:hairline-t">
        {codes.map((c) => {
          const key = codeKey(kind, c.code)
          const hit = target === key
          return (
            <li
              key={c.code}
              id={`code-${key.replace(/[:$]/g, '-')}`}
              data-code={key}
              tabIndex={hit ? -1 : undefined}
              aria-current={hit || undefined}
              className={cn(
                'group flex scroll-mt-24 items-start gap-3 px-4 py-3 outline-none transition-colors duration-[var(--dur-slow)]',
                hit && 'bg-accent/10 shadow-[inset_3px_0_0_rgb(var(--accent))]',
              )}
            >
              <span
                className={cn(
                  'mt-px inline-flex h-5 min-w-[72px] shrink-0 items-center justify-center rounded-xs px-1.5 font-mono text-caption font-semibold',
                  tone === 'red' && 'bg-red/15 text-on-tint-red',
                  tone === 'orange' && 'bg-orange/15 text-on-tint-orange',
                  tone === 'gray' && 'bg-fill text-secondary-label',
                )}
              >
                {key}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-body font-medium text-label">{c.title}</p>
                {c.hint ? (
                  <p className="mt-0.5 text-footnote text-secondary-label">
                    <span className="font-medium text-label">含义 </span>
                    {c.hint}
                  </p>
                ) : null}
                {c.fix ? (
                  <p className="mt-0.5 text-footnote text-secondary-label">
                    <span className="font-medium text-on-tint-green">处理 </span>
                    {c.fix}
                  </p>
                ) : null}
                {kind === 'ALARM' && (c.code <= 3 || c.code >= 6) ? <AlarmActions code={c.code} /> : null}
              </div>
              {kind !== '$' ? (
                <button
                  type="button"
                  aria-label={`复制 ${key} 的链接`}
                  className="focus-ring -mr-2 flex size-8 shrink-0 items-center justify-center rounded-md text-tertiary-label opacity-0 hover:bg-quaternary-fill hover:text-label focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:size-11 pointer-coarse:opacity-100"
                  onClick={() => {
                    const url = `${location.origin}/console?tab=codes&code=${encodeURIComponent(key)}`
                    void navigator.clipboard?.writeText(url).then(
                      () => toast.success('已复制链接'),
                      () => toast.info(url),
                    )
                  }}
                >
                  <LinkIcon className="size-4" />
                </button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function CodesTab() {
  const [params] = useSearchParams()
  const target = normalizeKey(params.get('code'))
  const [q, setQ] = React.useState('')
  const ql = q.trim().toLowerCase()
  const match = (s: string) => s.toLowerCase().includes(ql)
  const filt = (rec: Record<number, GrblCode>, kind: Kind) =>
    Object.values(rec).filter((c) => !ql || codeKey(kind, c.code) === target || match(`${codeKey(kind, c.code)} ${c.code} ${c.title} ${c.hint} ${c.fix}`))
  const errors = filt(GRBL_ERRORS, 'error')
  const alarms = filt(GRBL_ALARMS, 'ALARM')
  const settings = Object.entries(GRBL_SETTINGS_META)
    .map(([n, m]) => ({ code: Number(n), title: `${m.name}${m.unit ? `（${m.unit}）` : ''}`, hint: m.desc, fix: m.caution ?? '' }))
    .filter((c) => !ql || match(`$${c.code} ${c.title} ${c.hint} ${c.fix}`))
  const none = !errors.length && !alarms.length && !settings.length

  // Deep link: scroll the target row into view and focus it.
  React.useEffect(() => {
    if (!target) return
    const t = setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-code="${CSS.escape(target)}"]`)
      if (!el) return
      el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
      el.focus({ preventScroll: true })
    }, 50)
    return () => clearTimeout(t)
  }, [target])

  return (
    <div className="flex flex-col gap-5 pb-6">
      <SearchField value={q} onValueChange={setQ} placeholder="搜索代码或说明，例如 20、报警、行程" className="md:max-w-80" aria-label="搜索代码" />
      {none ? <EmptyState title="没有匹配的代码" description="换个关键词试试。" /> : null}
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <div className="flex flex-col gap-5">
          <CodeTable title="报警码 ALARM" kind="ALARM" codes={alarms} tone="red" target={target} />
          <CodeTable title="设置 $n" kind="$" codes={settings} tone="gray" target={target} />
        </div>
        <CodeTable title="错误码 error" kind="error" codes={errors} tone="orange" target={target} />
      </div>
    </div>
  )
}
