/**
 * 帮助中心 /help, /help/:article(#section), /help?q=搜索词
 * Regular: article list (or search results) on the left, article on the right.
 * Compact: list → push article (iOS style), large title.
 */
import {
  BookOpen, ChevronLeft, CircleAlert, Code2, Compass, FileText, Image as ImageIcon, Keyboard, Mail, PenLine, Rocket, ShieldCheck, Type, Users, Wand2,
  type LucideIcon,
} from 'lucide-react'
import * as React from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Page } from '@/app/page'
import { Button, EmptyState, GroupedList, ListRow, SearchField } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useIsCompact } from '@/lib/media'
import { ARTICLES, articleById, searchHelp, type Article, type SearchHit } from './articles'
import { Inline, Markdown } from './markdown'

const ICON: Record<string, [LucideIcon, string]> = {
  'quick-start': [Rocket, 'bg-blue'],
  glossary: [BookOpen, 'bg-indigo'],
  paper: [FileText, 'bg-teal'],
  fonts: [Type, 'bg-purple'],
  'image-trace': [ImageIcon, 'bg-pink'],
  batch: [Mail, 'bg-orange'],
  'multi-user': [Users, 'bg-green'],
  teletype: [Keyboard, 'bg-gray'],
  troubleshooting: [CircleAlert, 'bg-red'],
  safety: [ShieldCheck, 'bg-yellow'],
  api: [Code2, 'bg-gray'],
}
const iconOf = (id: string) => ICON[id] ?? [FileText, 'bg-gray']

export default function HelpPage() {
  const { article: articleId } = useParams()
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const compact = useIsCompact()
  const article = articleById(articleId)
  const hits = React.useMemo(() => searchHelp(q), [q])
  const setQ = (v: string) => setParams(v ? { q: v } : {}, { replace: true })

  const search = <SearchField value={q} onValueChange={setQ} placeholder="搜索帮助（如：原点、ALARM、缺字）" className="w-full min-w-0 sm:w-72" aria-label="搜索帮助" />

  if (compact) {
    return (
      <Page title={article ? article.title : '帮助'} largeTitle={!article}>
        {article ? (
          <div className="flex flex-col gap-4">
            <Link to={q ? `/help?q=${encodeURIComponent(q)}` : '/help'} className="-ml-1 inline-flex items-center gap-0.5 self-start text-body text-accent">
              <ChevronLeft className="size-5" aria-hidden /> 帮助
            </Link>
            <ArticleView article={article} highlight={q} />
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {search}
            {q ? <SearchResults hits={hits} q={q} /> : <><HomeHero /><ArticleList /></>}
          </div>
        )}
      </Page>
    )
  }

  return (
    <Page title="帮助" toolbar={search} padded={false}>
      <div className="absolute inset-0 flex">
        <nav aria-label="帮助文章" className="hairline-r w-72 shrink-0 overflow-y-auto bg-bg-grouped p-4">
          {q ? <SearchResults hits={hits} q={q} current={article?.id} /> : <ArticleList current={article?.id} />}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto bg-bg">
          <div className="mx-auto max-w-[720px] px-8 py-8">{article ? <ArticleView article={article} highlight={q} /> : <HelpHome />}</div>
        </div>
      </div>
    </Page>
  )
}

function ArticleList({ current }: { current?: string }) {
  const groups: [string, string[]][] = [
    ['入门', ['quick-start', 'glossary', 'safety']],
    ['使用', ['paper', 'fonts', 'image-trace', 'batch', 'multi-user', 'teletype']],
    ['遇到问题', ['troubleshooting']],
    ['开发者', ['api']],
  ]
  const listed = new Set(groups.flatMap((g) => g[1]))
  const rest = ARTICLES.filter((a) => !listed.has(a.id)).map((a) => a.id)
  if (rest.length) groups.push(['其他', rest])
  return (
    <div className="flex flex-col gap-5">
      {groups.map(([label, ids]) => (
        <GroupedList key={label} header={label}>
          {ids
            .map((id) => articleById(id))
            .filter((a): a is Article => !!a)
            .map((a) => {
              const [icon, color] = iconOf(a.id)
              return <ListRow key={a.id} icon={icon} iconColor={color} label={a.title} to={`/help/${a.id}`} selected={a.id === current} />
            })}
        </GroupedList>
      ))}
    </div>
  )
}

function SearchResults({ hits, q, current }: { hits: SearchHit[]; q: string; current?: string }) {
  if (!hits.length)
    return (
      <EmptyState
        icon={Compass}
        title="没有找到"
        description={<>换个说法试试，比如「位置不对」「方框」「报警」。也可以看看 <Link className="text-accent" to="/help/troubleshooting">故障排除</Link>。</>}
      />
    )
  return (
    <div className="flex flex-col gap-1.5" role="list" aria-label={`搜索「${q}」的结果`}>
      <p className="px-1 pb-1 text-footnote text-secondary-label">{hits.length} 篇相关文章</p>
      {hits.map((h) => {
        const [Icon, color] = iconOf(h.article.id)
        const to = `/help/${h.article.id}?q=${encodeURIComponent(q)}${h.section ? `#${h.section.id}` : ''}`
        return (
          <Link
            role="listitem"
            key={h.article.id}
            to={to}
            className={cn(
              'focus-ring flex gap-3 rounded-lg bg-bg-grouped-secondary p-3 shadow-sm transition-colors hover:bg-quaternary-fill',
              current === h.article.id && 'ring-2 ring-accent',
            )}
          >
            <span className={cn('flex size-[22px] shrink-0 items-center justify-center rounded-[6px] text-white', color)}>
              <Icon className="size-3.5" strokeWidth={2.25} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium text-label">
                {h.article.title}
                {h.section ? <span className="font-normal text-secondary-label"> · {h.section.title}</span> : null}
              </span>
              {h.snippet ? (
                <span className="mt-0.5 line-clamp-2 block text-footnote text-secondary-label">
                  <Inline text={h.snippet} highlight={q.trim().split(/\s+/)[0]} />
                </span>
              ) : null}
            </span>
          </Link>
        )
      })}
    </div>
  )
}

function HomeHero() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-accent/10 p-5">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-lg bg-accent text-white">
          <Wand2 className="size-5" aria-hidden />
        </span>
        <div>
          <p className="text-headline text-label">第一次用？</p>
          <p className="text-subheadline text-secondary-label">设置向导会带你连接机器、调好笔、写出第一张。</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="filled" icon={<Wand2 />} onClick={() => navigate('/welcome')}>
          打开设置向导
        </Button>
        <Button variant="tinted" icon={<PenLine />} onClick={() => navigate('/help/quick-start')}>
          快速开始
        </Button>
      </div>
    </div>
  )
}

function HelpHome() {
  const popular: [string, string, string][] = [
    ['原点是什么？', 'glossary', 'origin'],
    ['字变成了方框', 'fonts', 'missing'],
    ['笔压不住 / 划纸', 'troubleshooting', 'pen-pressure'],
    ['位置偏了', 'troubleshooting', 'offset'],
    ['出现 ALARM 报警', 'troubleshooting', 'alarm'],
    ['一次写 50 个信封', 'batch', 'steps'],
  ]
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-large-title font-bold text-label">有什么可以帮你？</h1>
        <p className="mt-1 text-body text-secondary-label">在上方搜索，或者从左侧挑一篇。所有内容也收录在 docs/manual 里。</p>
      </div>
      <HomeHero />
      <section>
        <h2 className="mb-2 text-title3 font-semibold text-label">常见问题</h2>
        <div className="grid grid-cols-2 gap-2">
          {popular.map(([label, a, s]) => (
            <Link key={label} to={`/help/${a}#${s}`} className="focus-ring rounded-lg bg-bg-grouped-secondary px-3.5 py-3 text-body text-label shadow-sm transition-colors hover:bg-quaternary-fill">
              {label}
            </Link>
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-title3 font-semibold text-label">全部文章</h2>
        <div className="grid grid-cols-2 gap-2">
          {ARTICLES.map((a) => {
            const [Icon, color] = iconOf(a.id)
            return (
              <Link key={a.id} to={`/help/${a.id}`} className="focus-ring flex gap-3 rounded-lg bg-bg-grouped-secondary p-3.5 shadow-sm transition-colors hover:bg-quaternary-fill">
                <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-md text-white', color)}>
                  <Icon className="size-4" strokeWidth={2.25} />
                </span>
                <span className="min-w-0">
                  <span className="block text-headline text-label">{a.title}</span>
                  <span className="line-clamp-2 block text-footnote text-secondary-label">{a.summary}</span>
                </span>
              </Link>
            )
          })}
        </div>
      </section>
    </div>
  )
}

function ArticleView({ article, highlight }: { article: Article; highlight?: string }) {
  const { hash } = useLocation()
  const ref = React.useRef<HTMLElement>(null)
  React.useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''))
    const el = id ? document.getElementById(id) : null
    if (el) {
      el.scrollIntoView({ block: 'start' })
      el.classList.add('animate-pulse')
      const t = setTimeout(() => el.classList.remove('animate-pulse'), 1200)
      return () => clearTimeout(t)
    }
    ref.current?.scrollIntoView({ block: 'start' })
  }, [article.id, hash])
  const idx = ARTICLES.findIndex((a) => a.id === article.id)
  const prev = ARTICLES[idx - 1]
  const next = ARTICLES[idx + 1]
  return (
    <article ref={ref} className="scroll-mt-20">
      <header className="mb-5">
        <h1 className="text-title1 font-bold text-label">{article.title}</h1>
        {article.summary ? <p className="mt-1 text-callout text-secondary-label">{article.summary}</p> : null}
        {article.sections.length > 2 ? (
          <nav aria-label="本页目录" className="mt-4 flex flex-wrap gap-1.5">
            {article.sections.map((s) => (
              <Link key={s.id} to={`#${s.id}`} replace className="rounded-full bg-fill px-2.5 py-1 text-footnote text-label hover:bg-secondary-fill">
                {s.title.replace(/^\d+\.\s*/, '')}
              </Link>
            ))}
          </nav>
        ) : null}
      </header>
      <Markdown blocks={article.blocks} highlight={highlight?.trim().split(/\s+/)[0]} />
      <footer className="hairline-t mt-10 flex justify-between gap-4 pt-4 text-subheadline">
        {prev ? <Link to={`/help/${prev.id}`} className="text-accent hover:underline">← {prev.title}</Link> : <span />}
        {next ? <Link to={`/help/${next.id}`} className="text-accent hover:underline">{next.title} →</Link> : <span />}
      </footer>
    </article>
  )
}
