/** 导出 Sheet (02-ux §3.5): G 代码 / SVG / PNG / PDF / 项目 JSON. */
import { Download } from 'lucide-react'
import * as React from 'react'
import { downloadProjectJson, exportRender, type RenderExport } from '@/api/studio'
import { Button, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle, Segmented, Switch } from '@/components/ui'
import { toast } from '@/lib/toast'
import { errText } from '../ext'
import { renderForOutput } from '../print'
import { outputIndex } from '../render-engine'
import { saveNow } from '../project-io'
import { useStudio } from '../store'

type Fmt = 'gcode' | 'svg' | 'png' | 'pdf' | 'json'

export function ExportSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [fmt, setFmt] = React.useState<Fmt>('gcode')
  const [range, setRange] = React.useState<'current' | 'all'>('current')
  const [dpi, setDpi] = React.useState('300')
  const [space, setSpace] = React.useState<'page' | 'machine'>('page')
  const [busy, setBusy] = React.useState(false)
  const [withBg, setWithBg] = React.useState(true)
  const project = useStudio((s) => s.project)
  const view = useStudio((s) => s.view)
  const hasBg = useStudio((s) => !!s.doc?.pages[s.view.page]?.background?.visible)
  if (!project) return null

  const run = async () => {
    setBusy(true)
    try {
      if (fmt === 'json') {
        await saveNow()
        await downloadProjectJson(project.id, project.name)
      } else {
        const r = await renderForOutput()
        const idx = outputIndex(r, view.page, view.sub) ?? 0
        const pages = range === 'all' ? ('all' as const) : [idx]
        const body: RenderExport = { format: fmt, pages: fmt === 'png' && range === 'all' ? [0] : pages, dpi: Number(dpi), space, background: fmt === 'png' && hasBg && withBg }
        await exportRender(r.rid, body, `${project.name}.${fmt}`)
      }
      toast.success('已导出')
      onOpenChange(false)
    } catch (e) {
      toast.error('导出失败', { description: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>导出</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <Segmented value={fmt} onValueChange={setFmt} block options={[{ value: 'gcode', label: 'G 代码' }, { value: 'svg', label: 'SVG' }, { value: 'png', label: 'PNG' }, { value: 'pdf', label: 'PDF' }, { value: 'json', label: '项目' }]} aria-label="格式" />
          {fmt !== 'json' ? (
            <>
              <label className="flex items-center justify-between gap-3 text-body">
                范围
                <Segmented value={range} onValueChange={setRange} options={[{ value: 'current', label: '当前页' }, { value: 'all', label: '全部页' }]} size="sm" />
              </label>
              {fmt === 'png' ? (
                <label className="flex items-center justify-between gap-3 text-body">
                  分辨率
                  <Segmented value={dpi} onValueChange={setDpi} options={[{ value: '96', label: '1×' }, { value: '192', label: '2×' }, { value: '300', label: '300 dpi' }]} size="sm" />
                </label>
              ) : null}
              {fmt === 'png' && hasBg ? (
                <label className="flex items-center justify-between gap-3 text-body">
                  <span>
                    淡显参考背景
                    <span className="block text-footnote text-secondary-label">只在 PNG 预览里垫一层，G 代码 / SVG / PDF 永远不含背景</span>
                  </span>
                  <Switch checked={withBg} onCheckedChange={setWithBg} aria-label="PNG 里淡显参考背景" />
                </label>
              ) : null}
              {fmt === 'svg' ? (
                <label className="flex items-center justify-between gap-3 text-body">
                  坐标
                  <Segmented value={space} onValueChange={setSpace} options={[{ value: 'page', label: '纸面' }, { value: 'machine', label: '机器' }]} size="sm" />
                </label>
              ) : null}
              <p className="text-footnote text-secondary-label">
                {fmt === 'gcode'
                  ? '使用当前机器配置和打印设置生成；多页会打包成 .zip（page-1.gcode …）。'
                  : fmt === 'pdf'
                    ? '矢量 PDF，每页一页。'
                    : fmt === 'png'
                      ? 'PNG 只导出一页（全部页时导出第 1 页）。'
                      : '路径矢量；多页打包为 .zip。'}
              </p>
            </>
          ) : (
            <p className="text-footnote text-secondary-label">.penplot.json 包含页面、元素、纸张、原点和打印设置；字体按名称引用。</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="filled" icon={<Download />} loading={busy} onClick={run}>
            导出
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
