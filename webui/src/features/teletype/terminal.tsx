/**
 * Terminal mode: xterm.js bound to the device PTY over `WS /api/v1/teletype/pty` (lazy chunk).
 * Server → client: binary frames = terminal output (first = replay); a JSON text frame = error, then close 4403.
 * Client → server: text frames = keystrokes; `{"type":"resize","rows":N}` resizes (columns = paper columns).
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import * as React from 'react'
import { API_BASE } from '@/api/client'

export default function TeletypeTerminal({ cols, enabled }: { cols: number; enabled: boolean }) {
  const host = React.useRef<HTMLDivElement>(null)
  const term = React.useRef<Terminal | null>(null)
  const enabledRef = React.useRef(enabled)
  enabledRef.current = enabled
  const [status, setStatus] = React.useState<string | null>('正在连接终端…')

  React.useEffect(() => {
    const el = host.current
    if (!el) return
    const t = new Terminal({
      cols,
      rows: 24,
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, "JetBrains Mono", monospace',
      theme: { background: '#101215', foreground: '#d6f5df', cursor: '#e8b04a', selectionBackground: '#3a4a6a' },
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(el)
    term.current = t
    const dec = new TextDecoder()
    let sock: WebSocket | null = null
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null
    let lastRows = 0
    let first = true

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const s = new WebSocket(`${proto}//${location.host}${API_BASE}/teletype/pty`, ['penplot.v1'])
      s.binaryType = 'arraybuffer'
      sock = s
      first = true
      s.onopen = () => {
        setStatus(null)
        if (lastRows) s.send(JSON.stringify({ type: 'resize', rows: lastRows }))
      }
      s.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const e = JSON.parse(ev.data) as { error?: { message?: string } }
            setStatus(e.error?.message ?? '终端不可用')
          } catch {
            t.write(ev.data)
          }
          return
        }
        if (first) {
          t.reset()
          first = false
        }
        t.write(dec.decode(ev.data as ArrayBuffer, { stream: true }))
      }
      s.onclose = (ev) => {
        if (closed) return
        if (ev.code === 4401 || ev.code === 4403) {
          setStatus((st) => st ?? (ev.code === 4401 ? '登录已过期' : '终端不可用'))
          return
        }
        setStatus('终端连接中断，正在重连…')
        retry = setTimeout(connect, 2000)
      }
    }
    connect()

    const sub = t.onData((d) => {
      if (enabledRef.current && sock?.readyState === WebSocket.OPEN) sock.send(d)
    })
    // The PTY width equals the paper's column count (the shell wraps at the paper width); only rows follow the box.
    const resize = () => {
      const dims = fit.proposeDimensions()
      if (!dims) return
      const rows = Math.max(8, dims.rows)
      t.resize(cols, rows)
      if (rows !== lastRows) {
        lastRows = rows
        if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'resize', rows }))
      }
    }
    const ro = new ResizeObserver(() => resize())
    ro.observe(el)
    resize()
    t.focus()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      sock?.close()
      ro.disconnect()
      sub.dispose()
      t.dispose()
      term.current = null
    }
  }, [cols])

  return (
    <div
      className="relative h-full min-h-64 w-full overflow-x-auto rounded-lg bg-[#101215] p-2"
      onClick={() => term.current?.focus()}
      role="region"
      aria-label="设备终端"
    >
      <div ref={host} className="h-full min-h-60" />
      {status ? (
        <div className="pointer-events-none absolute inset-x-2 top-2 rounded-md bg-black/60 px-3 py-1.5 text-footnote text-[#d6f5df]">{status}</div>
      ) : null}
    </div>
  )
}
