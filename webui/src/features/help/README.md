# help — 帮助中心 + contextual help

- Route `/help/:article?` (`?q=` search, `#anchor` jumps to a section) → `index.tsx`.
- Articles: `articles/NN-<id>.md` (Chinese). Header: `# 标题`, `> 摘要`, `<!-- keywords: … -->`; sections
  `## 名称 {#anchor}`. Order = NN. `docs/manual/` is a copy (`cp articles/*.md ../../../../docs/manual/`).
- Renderer: `markdown.tsx` (headings, lists, tables, code, `>` tips, bold, code, links; internal links use the router).

## `<HelpLink>` (for other features)

```tsx
import { HelpLink } from '@/features/help/HelpLink'

<label>原点 <HelpLink topic="origin" /></label>   // ⓘ → popover: short explanation + 「了解更多」
<HelpLink topic="原点" />                         // Chinese aliases work
<HelpLink topic="pen">落笔高度</HelpLink>          // custom trigger text
```

Props: `topic` (id or alias), `children?`, `side?` (`top` default), `className?`. Unknown topics link to the search.
Topics live in `topics.ts` (`HELP_TOPICS`): origin, frame, pen, gcode, travel, jitter, seed, single-line-font,
missing-glyph, font-size, paper, offset, variables, batch, flow-text, image-trace, lease, estop, alarm, gcode-error,
feed-rate, optimize, api-token, teletype, disconnect, wifi. `HelpLink.tsx` imports no article bodies, so it is cheap
to import eagerly.
