/**
 * Tiny markdown renderer for the help articles (no dependency). Supports the subset the articles use:
 * `#`/`##`/`###` headings (optional `{#anchor}`), paragraphs, `-`/`1.` lists (with indented
 * continuation lines and fenced code inside), tables, ``` fences, `>` tip callouts, `**bold**`,
 * `` `code` `` and `[text](link)` (internal links → react-router <Link>).
 */
import { Lightbulb } from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/cn'

export type Block =
  | { t: 'h'; level: number; text: string; id?: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: Block[][] }
  | { t: 'code'; text: string }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'tip'; text: string }

const HEAD = /^(#{1,3})\s+(.*?)(?:\s*\{#([\w-]+)\})?\s*$/

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r/g, '').replace(/<!--[\s\S]*?-->/g, '').split('\n')
  return parseLines(lines)
}

function parseLines(lines: string[]): Block[] {
  const out: Block[] = []
  let i = 0
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ t: 'p', text: para.join(' ').trim() })
    para = []
  }
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) {
      flush()
      i++
      continue
    }
    if (trimmed.startsWith('```')) {
      flush()
      const buf: string[] = []
      const indent = line.indexOf('```')
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i].slice(Math.min(indent, lines[i].length - lines[i].trimStart().length)))
        i++
      }
      i++
      out.push({ t: 'code', text: buf.join('\n') })
      continue
    }
    const h = HEAD.exec(line)
    if (h) {
      flush()
      out.push({ t: 'h', level: h[1].length, text: h[2], id: h[3] })
      i++
      continue
    }
    if (trimmed.startsWith('>')) {
      flush()
      const buf: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      out.push({ t: 'tip', text: buf.join(' ') })
      continue
    }
    if (trimmed.startsWith('|')) {
      flush()
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells)
        i++
      }
      out.push({ t: 'table', head: rows[0] ?? [], rows: rows.slice(1) })
      continue
    }
    const li = /^(\s*)(-|\d+\.)\s+(.*)$/.exec(line)
    if (li && li[1].length === 0) {
      flush()
      const ordered = li[2] !== '-'
      const items: Block[][] = []
      while (i < lines.length) {
        const m = /^(-|\d+\.)\s+(.*)$/.exec(lines[i])
        if (!m || (m[1] !== '-') !== ordered) break
        const body: string[] = [m[2]]
        i++
        // continuation: indented lines or blank lines followed by indented lines
        while (i < lines.length) {
          if (/^\s{2,}\S/.test(lines[i])) {
            body.push(lines[i].replace(/^\s{2,3}/, ''))
            i++
          } else if (!lines[i].trim() && i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) {
            body.push('')
            i++
          } else break
        }
        items.push(parseLines(body))
      }
      out.push({ t: ordered ? 'ol' : 'ul', items })
      continue
    }
    para.push(trimmed)
    i++
  }
  flush()
  return out
}

/** Plain text of a block list (search index, snippets). */
export function blocksText(blocks: Block[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case 'h':
        case 'p':
        case 'tip':
        case 'code':
          return stripInline(b.text)
        case 'table':
          return [b.head, ...b.rows].map((r) => r.map(stripInline).join(' ')).join('\n')
        default:
          return b.items.map(blocksText).join('\n')
      }
    })
    .join('\n')
}

export function stripInline(s: string) {
  return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

const INLINE = /(\*\*.+?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g

export function Inline({ text, highlight }: { text: string; highlight?: string }) {
  const parts = text.split(INLINE)
  return (
    <>
      {parts.map((p, k) => {
        if (!p) return null
        if (p.startsWith('**') && p.endsWith('**')) return <strong key={k} className="font-semibold text-label">{mark(p.slice(2, -2), highlight)}</strong>
        if (p.startsWith('`') && p.endsWith('`'))
          return (
            <code key={k} className="rounded-xs bg-quaternary-fill px-1 py-px font-mono text-[0.92em] text-label">
              {p.slice(1, -1)}
            </code>
          )
        const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p)
        if (m) return <MdLink key={k} href={m[2]}>{m[1]}</MdLink>
        return <React.Fragment key={k}>{mark(p, highlight)}</React.Fragment>
      })}
    </>
  )
}

function mark(s: string, q?: string): React.ReactNode {
  if (!q) return s
  const i = s.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return s
  return (
    <>
      {s.slice(0, i)}
      <mark className="rounded-xs bg-yellow/35 text-label">{s.slice(i, i + q.length)}</mark>
      {mark(s.slice(i + q.length), q)}
    </>
  )
}

function MdLink({ href, children }: { href: string; children: React.ReactNode }) {
  const cls = 'text-accent underline-offset-2 hover:underline'
  // /api/v1/docs is served by the backend, not the SPA
  if (/^https?:/.test(href) || href.startsWith('/api/')) {
    return (
      <a className={cls} href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    )
  }
  return (
    <Link className={cls} to={href}>
      {children}
    </Link>
  )
}

export function Markdown({ blocks, highlight, className }: { blocks: Block[]; highlight?: string; className?: string }) {
  return <div className={cn('flex flex-col gap-3 text-body leading-relaxed text-label', className)}>{blocks.map((b, k) => <BlockView key={k} b={b} q={highlight} />)}</div>
}

function BlockView({ b, q }: { b: Block; q?: string }) {
  switch (b.t) {
    case 'h': {
      if (b.level === 1) return <h1 className="text-title1 font-bold">{b.text}</h1>
      if (b.level === 2)
        return (
          <h2 id={b.id} className="mt-4 scroll-mt-20 text-title3 font-semibold">
            {b.text}
          </h2>
        )
      return (
        <h3 id={b.id} className="mt-2 scroll-mt-20 text-headline">
          {b.text}
        </h3>
      )
    }
    case 'p':
      return (
        <p className="text-secondary-label">
          <Inline text={b.text} highlight={q} />
        </p>
      )
    case 'tip':
      return (
        <div className="flex gap-2.5 rounded-lg bg-accent/10 px-3.5 py-3 text-callout text-label">
          <Lightbulb className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
          <p>
            <Inline text={b.text} highlight={q} />
          </p>
        </div>
      )
    case 'code':
      return <pre className="overflow-x-auto rounded-lg bg-quaternary-fill p-3 font-mono text-footnote leading-snug text-label">{b.text}</pre>
    case 'table':
      return (
        <div className="overflow-x-auto rounded-lg bg-bg-grouped-secondary shadow-sm">
          <table className="w-full border-collapse text-left text-callout">
            <thead>
              <tr className="hairline-b">
                {b.head.map((c, k) => (
                  <th key={k} className="whitespace-nowrap px-3 py-2 font-semibold text-label">
                    <Inline text={c} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, k) => (
                <tr key={k} className="hairline-b last:after:hidden">
                  {r.map((c, j) => (
                    <td key={j} className={cn('px-3 py-2 align-top text-secondary-label', j === 0 && 'whitespace-nowrap text-label')}>
                      <Inline text={c} highlight={q} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    default: {
      const Tag = b.t === 'ol' ? 'ol' : 'ul'
      return (
        <Tag className={cn('flex flex-col gap-1.5 pl-6 text-secondary-label', b.t === 'ol' ? 'list-decimal' : 'list-disc', 'marker:text-tertiary-label')}>
          {b.items.map((it, k) => (
            <li key={k} className="pl-1 [&>div>p]:text-secondary-label">
              <Markdown blocks={it} highlight={q} className="gap-2" />
            </li>
          ))}
        </Tag>
      )
    }
  }
}
