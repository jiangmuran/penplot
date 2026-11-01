/**
 * SVG element: how its <text> is drawn (text_mode / text_font_id / text_font_map / text_size_scale).
 * Text runs come from the file's import metadata (GET /files/{id} → meta.text_runs); files imported before
 * text support have none, so the controls are shown anyway and the render tells the rest.
 */
import { useQuery } from '@tanstack/react-query'
import { Type } from 'lucide-react'
import { api } from '@/api/client'
import { qk } from '@/api/query'
import type { components } from '@/api/schema'
import type { FileInfo, SvgElement } from '@/api/studio'
import { useElementRender } from './canvas/element-view'
import { Note, Row, Section, SegRow, SliderRow } from './inspector/controls'
import { FontPicker } from './inspector/font-picker'
import { studio } from './store'

type SvgTextRun = components['schemas']['SvgTextRun']
type TextMode = 'font' | 'outline' | 'skip'

export function SvgTextSection({ el }: { el: SvgElement }) {
  const p = el.props
  const set = (patch: Record<string, unknown>) => studio.setProps(el.id, patch, 'svg-text')
  const file = useQuery({
    queryKey: qk.files.detail(p.file_id),
    queryFn: () => api.get<FileInfo>(`/files/${encodeURIComponent(p.file_id)}`),
    staleTime: 5 * 60_000,
  })
  const { r } = useElementRender(el)
  const meta = (file.data?.meta ?? {}) as { text_runs?: SvgTextRun[]; text_families?: string[] }
  const runs = meta.text_runs ?? []
  const known = file.isSuccess && Array.isArray(meta.text_runs)
  if (known && runs.length === 0) return null
  const families = (meta.text_families ?? []).filter((f) => f.trim())
  const blocks = new Set(runs.map((x) => x.text_index)).size
  const sample = runs.map((x) => x.content).join('')
  const mode = (p.text_mode ?? 'font') as TextMode
  const map = p.text_font_map ?? {}
  const setMap = (fam: string, fid: string | null) => {
    const next = { ...map }
    if (fid) next[fam] = fid
    else delete next[fam]
    set({ text_font_map: Object.keys(next).length ? next : null })
  }
  return (
    <Section title="SVG 文字">
      {known ? (
        <Note icon={<Type />}>
          SVG 中有 {blocks} 段文字（{runs.reduce((n, x) => n + x.chars, 0)} 字
          {families.length ? ` · ${families.length} 种字体` : ''}）
          <span className="mt-0.5 block truncate text-caption text-tertiary-label" title={sample}>
            {sample.slice(0, 40)}
          </span>
        </Note>
      ) : null}
      <SegRow<TextMode>
        label="文字"
        value={mode}
        onChange={(v) => set({ text_mode: v })}
        options={[
          { value: 'font', label: '单线字体' },
          { value: 'outline', label: '原轮廓' },
          { value: 'skip', label: '忽略' },
        ]}
      />
      {mode === 'font' ? (
        <>
          <Row label="字体">
            <FontPicker value={p.text_font_id} onChange={(v) => set({ text_font_id: v })} text={sample} />
          </Row>
          {families.length > 1
            ? families.map((fam) => (
                <Row key={fam} label={<span className="truncate" title={fam}>{fam}</span>}>
                  <FontPicker value={map[fam] ?? p.text_font_id} onChange={(v) => setMap(fam, v === p.text_font_id ? null : v)} text={runs.filter((x) => x.font_family === fam).map((x) => x.content).join('')} />
                </Row>
              ))
            : null}
          <SliderRow label="字号缩放" value={p.text_size_scale ?? 1} onChange={(v) => set({ text_size_scale: v })} min={0.3} max={3} step={0.05} unit="×" />
          {r?.status === 'ok' && r.missing?.length ? (
            <Note tone="orange">缺字 {r.missing.length} 个：{r.missing.slice(0, 12).join('')}，换一个覆盖更全的字体</Note>
          ) : null}
        </>
      ) : mode === 'outline' ? (
        <Note tone="orange">只保留文件中已转为路径的文字；仍是文字的部分不会绘制（请在设计软件中“创建轮廓”）。</Note>
      ) : null}
    </Section>
  )
}
