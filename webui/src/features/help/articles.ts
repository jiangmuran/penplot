/**
 * Help articles: `./articles/NN-<id>.md` (single source; `docs/manual/` is a copy of the same files).
 * Header convention: `# 标题`, then `> 摘要`, then `<!-- keywords: … -->`; sections are `## 名称 {#anchor}`.
 */
import { blocksText, parseMarkdown, stripInline, type Block } from './markdown'

const raw = import.meta.glob('./articles/*.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>

export interface Section {
  id: string
  title: string
  text: string
}
export interface Article {
  id: string
  order: number
  title: string
  summary: string
  keywords: string[]
  blocks: Block[]
  sections: Section[]
  text: string
}

function build(path: string, src: string): Article {
  const m = /(\d+)-([\w-]+)\.md$/.exec(path)!
  const kw = /<!--\s*keywords:\s*(.*?)\s*-->/.exec(src)?.[1] ?? ''
  let blocks = parseMarkdown(src)
  const title = blocks[0]?.t === 'h' ? blocks[0].text : m[2]
  let summary = ''
  blocks = blocks.slice(blocks[0]?.t === 'h' ? 1 : 0)
  if (blocks[0]?.t === 'tip') {
    summary = stripInline(blocks[0].text)
    blocks = blocks.slice(1)
  }
  const sections: Section[] = []
  let cur: { id: string; title: string; blocks: Block[] } | null = null
  for (const b of blocks) {
    if (b.t === 'h' && b.level === 2) {
      if (cur) sections.push({ id: cur.id, title: cur.title, text: blocksText(cur.blocks) })
      cur = { id: b.id ?? b.text, title: b.text, blocks: [] }
    } else cur?.blocks.push(b)
  }
  if (cur) sections.push({ id: cur.id, title: cur.title, text: blocksText(cur.blocks) })
  return { id: m[2], order: Number(m[1]), title, summary, keywords: kw.split(/\s+/).filter(Boolean), blocks, sections, text: blocksText(blocks) }
}

export const ARTICLES: Article[] = Object.entries(raw)
  .map(([p, s]) => build(p, s))
  .sort((a, b) => a.order - b.order)

export const articleById = (id: string | undefined) => ARTICLES.find((a) => a.id === id)

export interface SearchHit {
  article: Article
  section?: Section
  snippet?: string
  score: number
}

function snippet(text: string, q: string) {
  const i = text.toLowerCase().indexOf(q)
  if (i < 0) return undefined
  const start = Math.max(0, i - 24)
  return (start > 0 ? '…' : '') + text.slice(start, i + q.length + 48).replace(/\s+/g, ' ') + '…'
}

/** Ranked search over titles, keywords, section titles and body text. Each term must match. */
export function searchHelp(query: string): SearchHit[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const hits: SearchHit[] = []
  for (const a of ARTICLES) {
    const hay = (a.title + ' ' + a.summary + ' ' + a.keywords.join(' ') + ' ' + a.text).toLowerCase()
    if (!terms.every((t) => hay.includes(t))) continue
    const t0 = terms[0]
    let score = 0
    if (a.title.toLowerCase().includes(t0)) score += 10
    if (a.keywords.some((k) => k.toLowerCase().includes(t0))) score += 5
    if (a.summary.toLowerCase().includes(t0)) score += 3
    // best section
    let best: Section | undefined
    let bestScore = -1
    for (const s of a.sections) {
      const st = s.title.toLowerCase()
      const sb = s.text.toLowerCase()
      const sc = (st.includes(t0) ? 6 : 0) + (sb.includes(t0) ? 2 : 0) + terms.filter((t) => sb.includes(t) || st.includes(t)).length
      if (sc > bestScore && (st.includes(t0) || sb.includes(t0))) {
        best = s
        bestScore = sc
      }
    }
    score += Math.max(0, bestScore)
    hits.push({ article: a, section: best, snippet: best ? snippet(best.text, t0) : snippet(a.text, t0), score })
  }
  return hits.sort((x, y) => y.score - x.score || x.article.order - y.article.order)
}
