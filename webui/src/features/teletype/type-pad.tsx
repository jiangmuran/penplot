import { CornerDownLeft, Delete, Keyboard, Space } from 'lucide-react'
import * as React from 'react'
import { describeError } from '@/api/errors'
import { orderedSender } from '@/api/teletype'
import { Button } from '@/components/ui'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { loadTeletype, onTeletypeTyped } from './store'

const SENTINEL = '​'
const MAX_LINES = 300

/** Tiny typewriter echo model: overstrike on backspace, \r / \n = new line, ANSI escapes stripped. */
class Echo {
  lines: string[][] = [[]]
  col = 0
  feed(data: string) {
    const s = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[\]PX^_][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && s[i + 1] === '\n') i++
        this.lines.push([])
        this.col = 0
      } else if (ch === '\x7f' || ch === '\b') {
        this.col = Math.max(0, this.col - 1)
      } else if (ch === '\t') {
        this.col = (Math.floor(this.col / 8) + 1) * 8
      } else if (ch >= ' ') {
        const line = this.lines[this.lines.length - 1]
        while (line.length < this.col) line.push(' ')
        const prev = line[this.col]
        line[this.col] = prev && prev !== ' ' && prev !== ch && !prev.endsWith('̸') ? ch + '̸' : ch
        this.col++
      }
    }
    if (this.lines.length > MAX_LINES) this.lines = this.lines.slice(-MAX_LINES)
  }
  reset() {
    this.lines = [[]]
    this.col = 0
  }
}

/**
 * Typing mode input (02-ux-style HIG card). A real <textarea> receives keys so that the iOS / Android
 * on-screen keyboard and IMEs work: composition is committed on compositionend (the committed text is sent as is;
 * the server decides cells / glyph fallback), a sentinel character detects backspace on Android keyboards (keyCode 229).
 */
export function TypePad({ enabled, reason, cols, cjk }: { enabled: boolean; reason: string | null; cols: number; cjk: boolean }) {
  const ta = React.useRef<HTMLTextAreaElement>(null)
  const padRef = React.useRef<HTMLDivElement>(null)
  const echo = React.useRef(new Echo())
  const serverEcho = React.useRef(false)
  const [, force] = React.useReducer((x: number) => x + 1, 0)
  const composing = React.useRef(false)
  const [focused, setFocused] = React.useState(false)
  const [preedit, setPreedit] = React.useState('')

  const send = React.useMemo(
    () =>
      orderedSender((e) => {
        const d = describeError(e)
        if (d.code === 'need_paper') {
          // the page is full: the paper prompt is on screen; resync so it shows
          void loadTeletype()
          return
        }
        toast.error('这几个字没有发出去', { description: d.hint ? `${d.title}。${d.hint}` : d.title, key: 'teletype-keys' })
      }),
    [],
  )

  React.useEffect(
    () =>
      onTeletypeTyped((data, reset) => {
        serverEcho.current = true
        if (reset) echo.current.reset()
        echo.current.feed(data)
        force()
      }),
    [],
  )

  const emit = React.useCallback(
    (data: string) => {
      if (!enabled || !data) return
      send(data)
      if (!serverEcho.current) {
        echo.current.feed(data)
        force()
      }
    },
    [enabled, send],
  )

  const resetValue = () => {
    const el = ta.current
    if (!el) return
    el.value = SENTINEL
    el.setSelectionRange(1, 1)
  }

  const flushValue = () => {
    const el = ta.current
    if (!el) return
    const v = el.value
    const text = v.replace(/\u200b/g, '').replace(/\r?\n/g, '\r')
    if (!v.includes(SENTINEL)) emit('\x7f') // sentinel deleted: backspace from a keyboard that sends keyCode 229
    if (text) emit(text)
    resetValue()
  }

  // keep the pad visible above the on-screen keyboard (iOS visualViewport)
  React.useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => {
      if (document.activeElement === ta.current) padRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
    vv.addEventListener('resize', onResize)
    return () => vv.removeEventListener('resize', onResize)
  }, [])

  React.useEffect(() => resetValue(), [])

  const lines = echo.current.lines.slice(-14)
  return (
    <div className="flex flex-col gap-2">
      <div
        ref={padRef}
        className={cn(
          'relative min-h-44 cursor-text overflow-hidden rounded-lg bg-[#101215] px-3 py-2.5 font-mono text-[13px] leading-[19px] text-[#d6f5df] ring-offset-2 ring-offset-bg-grouped-secondary transition-shadow',
          focused && 'ring-2 ring-accent',
          !enabled && 'opacity-60',
        )}
        onClick={() => ta.current?.focus()}
      >
        <div aria-hidden className="whitespace-pre">
          {lines.map((l, i) => (
            <div key={i} className="min-h-[19px] overflow-hidden text-ellipsis">
              {l.join('')}
              {i === lines.length - 1 ? (
                <>
                  {preedit ? <span className="underline decoration-accent">{preedit}</span> : null}
                  <span className={cn('inline-block h-[15px] w-[8px] translate-y-[3px] bg-[#e8b04a]', focused ? 'motion-safe:animate-pulse' : 'opacity-40')} />
                </>
              ) : null}
            </div>
          ))}
        </div>
        {!focused && enabled ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1.5 bg-gradient-to-t from-[#101215] to-transparent pb-3 pt-8 text-footnote text-[#8a91a0]">
            <Keyboard className="size-4" /> 点按这里开始打字
          </div>
        ) : null}
        <textarea
          ref={ta}
          aria-label="打字输入：每个按键都会立刻写到纸上"
          data-testid="tt-input"
          disabled={!enabled}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="enter"
          rows={1}
          className="absolute inset-0 size-full resize-none bg-transparent text-[16px] text-transparent caret-transparent outline-none selection:bg-transparent"
          onFocus={() => {
            setFocused(true)
            resetValue()
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return
            if (e.ctrlKey || e.metaKey || e.altKey) return
            if (e.key === 'Backspace') {
              e.preventDefault()
              emit('\x7f')
            } else if (e.key === 'Enter') {
              e.preventDefault()
              emit('\r')
            } else if (e.key === 'Tab') {
              e.preventDefault()
              emit('\t')
            }
          }}
          onCompositionStart={() => {
            composing.current = true
          }}
          onCompositionUpdate={(e) => setPreedit(e.data)}
          onCompositionEnd={() => {
            composing.current = false
            setPreedit('')
            flushValue()
          }}
          onInput={() => {
            if (composing.current) return
            flushValue()
          }}
        />
      </div>
      <div className="grid grid-cols-4 gap-2">
        <Button variant="gray" icon={<Delete />} disabled={!enabled} onClick={() => emit('\x7f')} aria-label="退格（字车回退一格，下一个字叠打）">
          退格
        </Button>
        <Button variant="gray" icon={<Space />} disabled={!enabled} onClick={() => emit(' ')}>
          空格
        </Button>
        <Button variant="gray" disabled={!enabled} onClick={() => emit('\t')}>
          Tab
        </Button>
        <Button variant="gray" icon={<CornerDownLeft />} disabled={!enabled} onClick={() => emit('\r')}>
          换行
        </Button>
      </div>
      <p className="text-footnote text-secondary-label">
        {enabled
          ? cjk
            ? `每个按键立刻写到纸上（每行 ${cols} 个半角字，汉字和全角标点占两格）。退格 = 字车回退一个字，下一个字叠打；支持中文输入法。`
            : `每个按键立刻写到纸上（每行 ${cols} 字）。退格 = 字车回退一格，下一个字叠打；全角标点会转成 ASCII，汉字会画成方框（换一款中文字体即可书写汉字）。`
          : reason}
      </p>
    </div>
  )
}
