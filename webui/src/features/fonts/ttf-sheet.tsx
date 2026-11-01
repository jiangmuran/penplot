import { ChevronRight, FileUp, Info } from 'lucide-react'
import * as React from 'react'
import { errorMessage } from '@/api/client'
import { pickFile } from '@/api/download'
import { uploadFont, type TtfConvertOptions } from '@/api/fonts'
import { isTaskRef } from '@/api/tasks'
import {
  Button, FormRow, GroupedList, Input, NumberField, Segmented, Select, Sheet, SheetContent, Textarea,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { useIsCompact } from '@/lib/media'
import { toast } from '@/lib/toast'
import { useFontsUi, TTF_EXTS } from './store'

const CHARSETS: { value: TtfConvertOptions['charset']; label: string; hint: string }[] = [
  { value: 'gb2312-1', label: '常用字（3,755 字）', hint: '常用汉字，加英文字母、数字和中文标点。在开发板上大约要 4–6 分钟。' },
  { value: 'gb2312-2', label: '常用字 + 次常用字（6,763 字）', hint: '覆盖绝大多数中文。在开发板上大约要 8–10 分钟。' },
  { value: 'latin', label: '只要英文和数字', hint: '字母、数字和常用标点，十几秒就好。' },
  { value: 'custom', label: '自定义字符', hint: '只转换下面输入的字，最快。适合临时为一段文字做字体。' },
]

function stem(name: string) {
  return name.replace(/\.(ttf|otf|ttc)$/i, '')
}

export function TtfConvertSheet({ sampleText }: { sampleText?: string }) {
  const { ttfOpen, ttfFile, closeTtf, addTask } = useFontsUi()
  const [file, setFile] = React.useState<File | null>(null)
  const [name, setName] = React.useState('')
  const [mode, setMode] = React.useState<TtfConvertOptions['mode']>('skeleton')
  const [charset, setCharset] = React.useState<TtfConvertOptions['charset']>('gb2312-1')
  const [chars, setChars] = React.useState('')
  const [sizePx, setSizePx] = React.useState(256)
  const [simplify, setSimplify] = React.useState(1.2)
  const [face, setFace] = React.useState(0)
  const [busy, setBusy] = React.useState(false)
  const [advanced, setAdvanced] = React.useState(false)
  const compact = useIsCompact()

  React.useEffect(() => {
    if (!ttfOpen) return
    setFile(ttfFile)
    setName('')
  }, [ttfOpen, ttfFile])

  const isTtc = !!file && file.name.toLowerCase().endsWith('.ttc')
  const charsetInfo = CHARSETS.find((c) => c.value === charset)!
  const customChars = [...new Set([...chars].filter((c) => c.trim()))]
  // name is optional: empty → the server uses the font's own family name (e.g. 「Noto Sans CJK SC 手写」)
  const valid = !!file && (charset !== 'custom' || customChars.length > 0)

  const choose = async () => {
    const f = await pickFile(TTF_EXTS.join(','))
    if (f) setFile(f)
  }

  const submit = async () => {
    if (!file || !valid) return
    setBusy(true)
    try {
      const r = await uploadFont(file, {
        name: name.trim() || undefined,
        mode,
        charset,
        chars: charset === 'custom' ? customChars.join('') : undefined,
        size_px: sizePx,
        simplify_tol: simplify,
        face_index: isTtc ? face : 0,
      })
      if (isTaskRef(r)) {
        addTask({ id: r.task_id, label: `转换「${name.trim() || stem(file.name)}」`, kind: 'ttf' })
        toast.info('已开始转换', { description: '转换在后台进行，可以先去做别的，进度显示在字体列表上方。' })
      } else {
        toast.success(`已安装「${r.display_name}」`)
      }
      closeTtf()
    } catch (e) {
      toast.error('没能开始转换', { description: `${errorMessage(e)}。检查文件是不是有效的 TTF / OTF 字体，再试一次。` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={ttfOpen} onOpenChange={(v) => (v ? undefined : closeTtf())}>
      <SheetContent
        title="TTF → 单线字体"
        description="把电脑里的字体转成写字机能写的单线字"
        width={460}
        className={compact ? undefined : 'top-[60px]'}
      >
        <form
          className="flex flex-col gap-5 px-4 pb-4 pt-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <GroupedList header="源文件">
            <div className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-orange/15 text-orange">
                <FileUp className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-body text-label">{file ? file.name : '未选择文件'}</p>
                <p className="text-footnote text-secondary-label">{file ? formatBytes(file.size) : 'TTF、OTF 或 TTC 字体，不超过 30 MB'}</p>
              </div>
              <Button variant="gray" onClick={() => void choose()}>
                {file ? '更换…' : '选择…'}
              </Button>
            </div>
            <FormRow label="字体名称" htmlFor="ttf-name">
              <Input id="ttf-name" value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="自动（用字体自带的名称）" className="max-w-56 text-right" maxLength={64} />
            </FormRow>
            {isTtc ? (
              <FormRow label="字体集序号" htmlFor="ttf-face" help=".ttc 中包含多个字体，0 为第一个">
                <NumberField id="ttf-face" value={face} onChange={setFace} min={0} max={63} step={1} className="w-28 pointer-coarse:w-44" />
              </FormRow>
            ) : null}
          </GroupedList>

          <GroupedList header="转换方式" footer={mode === 'skeleton' ? '提取笔画的中心线，写出来是单笔画，适合写字机（推荐）。' : '⚠️ 沿字的外轮廓描一圈，写出来是空心字（每一笔都是两条边线、中间有空腔）。这是给激光雕刻用的，写字机请选「手写单笔画」。'}>
            <FormRow label="模式">
              <Segmented
                aria-label="转换模式"
                value={mode}
                onValueChange={setMode}
                options={[
                  { value: 'skeleton', label: '手写单笔画' },
                  { value: 'outline', label: '空心轮廓（激光用）' },
                ]}
              />
            </FormRow>
            <FormRow label="精细度">
              <Segmented
                aria-label="精细度"
                value={sizePx >= 224 ? 'fine' : 'standard'}
                onValueChange={(v) => setSizePx(v === 'fine' ? 256 : 160)}
                options={[
                  { value: 'standard', label: '标准' },
                  { value: 'fine', label: '精细（更慢）' },
                ]}
              />
            </FormRow>
          </GroupedList>

          <GroupedList header="字符集" footer={charsetInfo.hint}>
            <FormRow label="范围" htmlFor="ttf-charset">
              <Select id="ttf-charset" value={charset} onValueChange={(v) => setCharset(v as TtfConvertOptions['charset'])} options={CHARSETS} className="max-w-60" />
            </FormRow>
            {charset === 'custom' ? (
              <FormRow label="字符" htmlFor="ttf-chars" stacked help={`${customChars.length} 个不同字符`}>
                <div className="flex w-full flex-col gap-2">
                  <Textarea id="ttf-chars" value={chars} onChange={(e) => setChars(e.currentTarget.value)} placeholder="输入要转换的文字" rows={4} />
                  {sampleText ? (
                    <Button size="sm" variant="tinted" className="self-start" onClick={() => setChars(sampleText)}>
                      使用当前测试文字
                    </Button>
                  ) : null}
                </div>
              </FormRow>
            ) : null}
          </GroupedList>

          <div className="flex flex-col">
            <button
              type="button"
              className="focus-ring flex items-center gap-1 self-start rounded-sm px-4 text-footnote font-medium text-secondary-label hover:text-label"
              aria-expanded={advanced}
              onClick={() => setAdvanced(!advanced)}
            >
              <ChevronRight className={cn('size-3.5 transition-transform', advanced && 'rotate-90')} />
              高级
            </button>
            {advanced ? (
              <GroupedList className="mt-1.5">
                <FormRow label="栅格尺寸（px）" htmlFor="ttf-size" help="把每个字画成多大的图再提取笔画。越大越精细，也越慢。">
                  <NumberField id="ttf-size" value={sizePx} onChange={setSizePx} min={64} max={512} step={16} className="w-32 pointer-coarse:w-48" />
                </FormRow>
                <FormRow label="简化程度（px）" htmlFor="ttf-simplify" help="越大笔画越平滑、点越少；太大会丢细节。">
                  <NumberField id="ttf-simplify" value={simplify} onChange={setSimplify} min={0} max={5} step={0.1} className="w-32 pointer-coarse:w-48" />
                </FormRow>
              </GroupedList>
            ) : null}
          </div>

          <p className="flex gap-2 rounded-lg bg-blue/10 px-3 py-2.5 text-footnote text-secondary-label">
            <Info className="mt-px size-4 shrink-0 text-blue" />
            转换作为后台任务运行，可以随时取消。字体里没有的字会自动跳过，完成后会告诉你缺了哪些。
          </p>
          <button type="submit" hidden />
        </form>
        <div className={cn('sticky bottom-0 flex items-center gap-2 bg-bg-elevated px-4 py-3 hairline-t', compact ? 'justify-start pr-24' : 'justify-end')}>
          <Button variant="gray" onClick={closeTtf}>
            取消
          </Button>
          <Button variant="filled" disabled={!valid} loading={busy} onClick={() => void submit()}>
            开始转换
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
