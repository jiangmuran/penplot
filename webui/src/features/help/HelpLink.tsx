/**
 * Contextual help: a small ⓘ button next to a term that opens a popover with a plain-language
 * explanation and a「了解更多」link into the help center.
 *
 *   import { HelpLink } from '@/features/help/HelpLink'
 *
 *   <label>原点 <HelpLink topic="origin" /></label>
 *   <HelpLink topic="原点" />                         // Chinese alias works too
 *   <HelpLink topic="pen">落笔高度</HelpLink>          // children = custom trigger text (rendered as a link-style button)
 *   <HelpLink topic="frame" side="bottom" className="ml-1" />
 *
 * Topics (id · aliases): origin 原点 · frame 走边框 · pen 抬笔/落笔/笔压 · gcode G代码 · travel 行程/工作区 ·
 * jitter 抖动 · seed 种子 · single-line-font 单线字体 · missing-glyph 缺字 · font-size 字号 · paper 纸张 ·
 * offset 偏移 · variables 变量 · batch 批量 · flow-text 流式 · image-trace 描线 · lease 控制权 · estop 急停 ·
 * alarm 报警 · gcode-error 错误码 · feed-rate 速度 · optimize 优化路径 · api-token 令牌 · teletype 电传 ·
 * disconnect 断线 · wifi. Full list: `HELP_TOPICS` in ./topics.ts (add new ones there).
 *
 * Unknown topics render a link to the help-center search instead of failing. This module is
 * deliberately light (no article bodies) so features can import it eagerly.
 */
import { CircleHelp } from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui'
import { cn } from '@/lib/cn'
import { findTopic, topicHref } from './topics'

export { HELP_TOPICS, findTopic, topicHref, type HelpTopic } from './topics'

export interface HelpLinkProps {
  /** Topic id or Chinese alias, e.g. "origin" / "原点". */
  topic: string
  /** Optional trigger content; default is a 14px ⓘ icon. */
  children?: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}

export function HelpLink({ topic, children, side = 'top', className }: HelpLinkProps) {
  const t = findTopic(topic)
  const [open, setOpen] = React.useState(false)
  const title = t?.title ?? topic
  const href = t ? topicHref(t) : `/help?q=${encodeURIComponent(topic)}`
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`什么是「${title}」？`}
          onClick={(e) => e.stopPropagation()}
          className={cn(
            'focus-ring inline-flex shrink-0 items-center gap-0.5 rounded-full align-middle text-tertiary-label transition-colors hover:text-accent',
            'pointer-coarse:-m-2 pointer-coarse:p-2',
            children ? 'text-accent underline decoration-dotted underline-offset-2' : 'size-4 justify-center',
            className,
          )}
        >
          {children ?? <CircleHelp className="size-3.5" strokeWidth={2.25} aria-hidden />}
        </button>
      </PopoverTrigger>
      <PopoverContent side={side} className="w-72" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col gap-1.5">
          <p className="text-headline text-label">{title}</p>
          <p className="text-subheadline leading-relaxed text-secondary-label">{t?.short ?? '帮助中心里有更多说明。'}</p>
          <Link to={href} onClick={() => setOpen(false)} className="mt-1 self-start text-subheadline font-medium text-accent hover:underline">
            了解更多 →
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default HelpLink
