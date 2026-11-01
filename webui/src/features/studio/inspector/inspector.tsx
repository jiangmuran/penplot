/** Context inspector (02-ux §3.1.4): groups change with the selection; document settings when nothing is selected. */
import { Crosshair, TriangleAlert, Users } from 'lucide-react'
import * as React from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Element, OriginSpec, PaperBase } from '@/api/studio'
import { Segmented } from '@/components/ui'
import { elementAABB } from '../actions'
import { usePeersEditing } from '../collab'
import { contains } from '../geometry'
import { elementName, originAnchor, paperDims, TYPE_LABEL, workAreaRect } from '../model'
import { useRender } from '../render-engine'
import { currentPage, useStudio } from '../store'
import { ArrangeSection } from './arrange'
import { BackgroundSection } from '../sheets/background-panel'
import { Note } from './controls'
import { Help } from '../ext'
import { LetterSection, OriginSection, PaperCard, VariablesSection } from './document'
import { GcodeSection, ImageSection, ShapeSection, VectorSection } from './element-sections'
import { SvgTextSection } from '../inspector-svg-text'
import { Handwriting, TextContent, TextStyle } from './text'

export interface InspectorProps {
  paper: PaperBase
  origin: OriginSpec
  originOverridden: boolean
  profileName: string
  workArea: { w_mm: number; h_mm: number } | null
  onOpenPaper: () => void
  onOpenPosition: () => void
}

type Group = 'main' | 'style' | 'arrange'

export function Inspector(props: InspectorProps) {
  const { selection, doc, view } = useStudio(useShallow((s) => ({ selection: s.selection, doc: s.doc, view: s.view })))
  const page = currentPage({ doc, view })
  const els = page && view.sub === 0 ? page.elements.filter((e) => selection.includes(e.id)) : []
  const [group, setGroup] = React.useState<Group>('main')
  const single = els.length === 1 ? els[0] : null
  React.useEffect(() => setGroup('main'), [single?.id])

  if (!doc || !page) return null
  if (!els.length) return <DocumentInspector {...props} />

  const groups = single ? groupsFor(single) : null
  const g = groups?.some((x) => x.value === group) ? group : 'main'
  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 mat-thick hairline-b px-3 pb-2 pt-3">
        <div className="mb-2 flex items-baseline justify-between gap-2 px-1">
          <h2 className="truncate text-headline text-label">{single ? elementName(single) : `已选 ${els.length} 个元素`}</h2>
          {single ? <span className="shrink-0 text-caption text-secondary-label">{TYPE_LABEL[single.type]}</span> : null}
        </div>
        {groups && groups.length > 1 ? <Segmented value={g} onValueChange={setGroup} options={groups} block size="sm" aria-label="检查器分组" /> : null}
      </div>
      <Warnings els={els} paper={props.paper} origin={props.origin} workArea={props.workArea} />
      {single ? <ElementGroups el={single} group={g} paper={props.paper} /> : <ArrangeSection els={els} paper={props.paper} />}
    </div>
  )
}

function groupsFor(el: Element): { value: Group; label: string }[] {
  switch (el.type) {
    case 'text':
      return [{ value: 'main', label: '文本' }, { value: 'style', label: '手写' }, { value: 'arrange', label: '排列' }]
    case 'flow_text':
      return [{ value: 'main', label: '信笺' }, { value: 'style', label: '手写' }, { value: 'arrange', label: '位置' }]
    case 'image':
      return [{ value: 'main', label: '转换' }, { value: 'arrange', label: '排列' }]
    case 'gcode':
      return [{ value: 'main', label: '信息' }, { value: 'arrange', label: '排列' }]
    default:
      return [{ value: 'main', label: '样式' }, { value: 'arrange', label: '排列' }]
  }
}

function ElementGroups({ el, group, paper }: { el: Element; group: Group; paper: PaperBase }) {
  if (group === 'arrange') return <ArrangeSection els={[el]} paper={paper} />
  if (el.type === 'text' || el.type === 'flow_text') {
    if (group === 'style') return <Handwriting el={el} />
    return (
      <>
        <TextContent el={el} />
        <TextStyle el={el} />
      </>
    )
  }
  if (el.type === 'image') return <ImageSection el={el} />
  if (el.type === 'svg') return <><VectorSection el={el} /><SvgTextSection el={el} /></>
  if (el.type === 'dxf') return <VectorSection el={el} />
  if (el.type === 'shape') return <ShapeSection el={el} />
  if (el.type === 'gcode') return <GcodeSection el={el} />
  return null
}

function Warnings({ els, paper, origin, workArea }: { els: Element[]; paper: PaperBase; origin: OriginSpec; workArea: InspectorProps['workArea'] }) {
  useRender((s) => s.els)
  const peers = usePeersEditing(els.length === 1 ? els[0].id : null)
  const { w, h } = paperDims(paper)
  const work = workArea ? workAreaRect(origin, w, h, workArea.w_mm, workArea.h_mm) : null
  let outPaper = 0
  let outWork = 0
  for (const e of els) {
    if (e.hidden) continue
    const b = elementAABB(e, paper)
    if (!contains({ x: 0, y: 0, w, h }, b)) outPaper++
    if (work && !contains(work, b, 1)) outWork++
  }
  if (!outPaper && !outWork && !peers.length) return null
  return (
    <div className="flex flex-col gap-1.5 px-3 pt-3">
      {peers.length ? (
        <Note tone="blue" icon={<Users />}>
          {peers.map((p) => p.name).join('、')} 正在编辑此元素。你的修改会实时同步给对方。
        </Note>
      ) : null}
      {outWork ? (
        <Note tone="red" icon={<TriangleAlert />}>
          {els.length > 1 ? `${outWork} 个元素` : '元素'}超出机器行程，这部分无法绘制。
        </Note>
      ) : outPaper ? (
        <Note tone="orange" icon={<TriangleAlert />}>
          {els.length > 1 ? `${outPaper} 个元素` : '元素'}超出纸张边界。
        </Note>
      ) : null}
    </div>
  )
}

function DocumentInspector({ paper, origin, originOverridden, profileName, onOpenPaper, onOpenPosition }: InspectorProps) {
  const doc = useStudio((s) => s.doc)!
  const view = useStudio((s) => s.view)
  const page = doc.pages[view.page]
  const flow = doc.pages.flatMap((p) => p.elements).find((e) => e.type === 'flow_text')
  const pageRender = useRender((s) => s.page)
  const out = pageRender.result?.pages.filter((p) => p.source_page === view.page) ?? []
  const warn = out.find((p) => p.out_of_work_area || p.warnings.clipped)
  const [group, setGroup] = React.useState<'paper' | 'origin' | 'data'>('paper')
  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 mat-thick hairline-b px-3 pb-2 pt-3">
        <h2 className="mb-2 px-1 text-headline text-label">文稿</h2>
        <Segmented
          value={group}
          onValueChange={setGroup}
          options={[{ value: 'paper', label: '纸张' }, { value: 'origin', label: '原点' }, { value: 'data', label: '数据' }]}
          block
          size="sm"
          aria-label="文稿设置分组"
        />
      </div>
      <div className="px-3 pt-3">
        <Note tone="blue" icon={<Crosshair />}>
          开始前：把笔（抬起状态）停在{originAnchor(origin) === 'content' ? '要写内容的' : '纸张'}<b className="font-semibold">{['左上', '右上', '左下', '右下'][origin.corner]}角</b>（原点）。写字机没有回零开关，每次开工都以笔所在的位置为起点。 <Help topic="原点" />
        </Note>
      </div>
      {warn ? (
        <div className="px-3 pt-3">
          <Note tone={warn.out_of_work_area ? 'red' : 'orange'} icon={<TriangleAlert />}>
            {warn.out_of_work_area ? `本页内容超出机器行程。${warn.warnings.messages.join('；')}` : '本页有内容超出纸张。'}
          </Note>
        </div>
      ) : null}
      {group === 'paper' ? (
        <>
          <div className="px-3 pt-3">
            <PaperCard paper={paper} onOpen={onOpenPaper} pageOverride={!!page?.paper} />
          </div>
          <BackgroundSection />
          {flow ? <LetterSection onSelectFlow={() => useStudio.setState({ selection: [flow.id], view: { page: doc.pages.findIndex((p) => p.elements.includes(flow)), sub: 0 } })} /> : null}
        </>
      ) : null}
      {group === 'origin' ? <OriginSection origin={origin} overridden={originOverridden} paper={paper} profileName={profileName} onOpenPosition={onOpenPosition} /> : null}
      {group === 'data' ? <VariablesSection /> : null}
    </div>
  )
}
