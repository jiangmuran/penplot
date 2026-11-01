/**
 * 批量生成 (mail merge, 02-ux §3.4, 03 §3.5, 05-review §1.4): template variables ↔ CSV/XLSX columns →
 * step through previews of each record → one queued job per record (sharing a batch id).
 */
import {
  Check, ChevronLeft, ChevronRight, CircleAlert, Eye, FileSpreadsheet, ListChecks, TriangleAlert, Upload,
} from 'lucide-react'
import * as React from 'react'
import { useNavigate } from 'react-router-dom'
import { pickFile } from '@/api/download'
import {
  importTable, previewSvgUrl, runBatch, useProject, type BatchResult, type ProjectSummary, type ProjectVariable, type TableImportResult,
} from '@/api/projects'
import { isTaskFinished, isTaskRef, useTask } from '@/api/tasks'
import {
  Badge, Button, EmptyState, ErrorState, FormRow, GroupedList, IconButton, Input, NumberField, ProgressBar, Segmented, Select, Sheet,
  SheetContent, Skeleton, Spinner, Switch,
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { toast } from '@/lib/toast'
import { errParts, errText } from './ext'
import { autoMap, fetchCsvRows } from './table-data'

const NONE = '__none__'
const varTitle = (v: ProjectVariable) => (v.label ? `${v.name}（${v.label}）` : v.name)

export function BatchSheet({ project, onOpenChange }: { project: ProjectSummary | null; onOpenChange: (o: boolean) => void }) {
  return (
    <Sheet open={!!project} onOpenChange={onOpenChange}>
      <SheetContent title="批量生成" description={project?.name} width={600}>
        {project ? <BatchBody key={project.id} project={project} onDone={() => onOpenChange(false)} /> : null}
      </SheetContent>
    </Sheet>
  )
}

type Preview = { row: number; result?: BatchResult; error?: string }

function BatchBody({ project, onDone }: { project: ProjectSummary; onDone: () => void }) {
  const navigate = useNavigate()
  const detail = useProject(project.id)
  const variables = React.useMemo(() => detail.data?.doc.variables ?? [], [detail.data])

  // ---- data source
  const [table, setTable] = React.useState<TableImportResult | null>(null)
  const [fullRows, setFullRows] = React.useState<string[][] | null>(null)
  const [uploading, setUploading] = React.useState(false)
  const [uploadError, setUploadError] = React.useState<string | null>(null)
  const [sheetName, setSheetName] = React.useState<string | null>(null)
  const [mapping, setMapping] = React.useState<Record<string, string>>({})
  const [autoMapped, setAutoMapped] = React.useState<Set<string>>(new Set())

  const sheet = table?.sheets.find((s) => s.name === sheetName) ?? table?.sheets[0] ?? null
  const columns = React.useMemo(() => sheet?.columns ?? [], [sheet])
  const rowCount = sheet?.row_count ?? 0
  /** Rows we can inspect: the whole CSV when parsed client-side, else the server's sample. */
  const rows: unknown[][] = React.useMemo(() => {
    if (fullRows && table?.sheets.length === 1 && fullRows.length === rowCount) return fullRows
    return sheet?.sample_rows ?? []
  }, [fullRows, sheet, table, rowCount])
  const allRowsKnown = rows.length === rowCount

  const resetForSheet = React.useCallback(
    (cols: string[]) => {
      const m = autoMap(variables, cols)
      setMapping(m)
      setAutoMapped(new Set(Object.keys(m)))
    },
    [variables],
  )

  const upload = async () => {
    const f = await pickFile('.csv,.xlsx,.xls,text/csv')
    if (!f) return
    setUploading(true)
    setUploadError(null)
    try {
      const t = await importTable(f)
      const first = t.sheets[0]
      setTable(t)
      setSheetName(first?.name ?? null)
      setFullRows(null)
      setPreviews({})
      setRange([1, Math.max(1, first?.row_count ?? 1)])
      setPreviewRow(1)
      if (first) resetForSheet(first.columns)
      void fetchCsvRows(t.file.id, t.file.name).then(setFullRows)
    } catch (e) {
      setUploadError(errText(e))
    } finally {
      setUploading(false)
    }
  }

  const changeSheet = (name: string) => {
    setSheetName(name)
    const s = table?.sheets.find((x) => x.name === name)
    if (s) {
      resetForSheet(s.columns)
      setRange([1, Math.max(1, s.row_count)])
    }
    setPreviewRow(1)
    setPreviews({})
  }

  // ---- validation
  const required = variables.filter((v) => !v.default)
  const missingRequired = required.filter((v) => !mapping[v.name])
  const colIndex = (c: string) => columns.indexOf(c)
  const mappedKey = Object.values(mapping).map(colIndex).filter((i) => i >= 0).join(',')
  const emptyRows = React.useMemo(() => {
    const idx = mappedKey ? mappedKey.split(',').map(Number) : []
    const set = new Set<number>()
    rows.forEach((r, i) => {
      if (idx.some((j) => r[j] == null || String(r[j]).trim() === '')) set.add(i)
    })
    return set
  }, [rows, mappedKey])

  // ---- range
  const [rowsMode, setRowsMode] = React.useState<'all' | 'range'>('all')
  const [range, setRange] = React.useState<[number, number]>([1, 1])
  const [skipEmpty, setSkipEmpty] = React.useState(true)
  const [namePattern, setNamePattern] = React.useState('')
  React.useEffect(() => {
    if (!namePattern && variables[0]) setNamePattern(`{{${variables[0].name}}}`)
  }, [variables, namePattern])

  const selected = React.useMemo(() => {
    const [a, b] = rowsMode === 'all' ? [1, rowCount] : range
    const out: number[] = []
    for (let i = a - 1; i < b; i++) if (!(skipEmpty && emptyRows.has(i))) out.push(i)
    return out
  }, [rowsMode, range, rowCount, skipEmpty, emptyRows])

  const body = (extra: object) => ({
    data_file_id: table!.file.id,
    sheet: sheet?.name ?? null,
    mapping,
    name_pattern: namePattern || '{{_row}}',
    ...extra,
  })

  // ---- previews (cached per row; ←/→ steps through records)
  const [previewRow, setPreviewRow] = React.useState(1)
  const [previews, setPreviews] = React.useState<Record<number, Preview>>({})
  const [pending, setPending] = React.useState<{ row: number; task: string | null } | null>(null)
  const previewTask = useTask(pending?.task ?? null)
  React.useEffect(() => {
    if (!pending || !previewTask || !isTaskFinished(previewTask)) return
    const row = pending.row
    setPending(null)
    setPreviews((p) => ({
      ...p,
      [row]: previewTask.state === 'done' ? { row, result: previewTask.result as BatchResult } : { row, error: previewTask.error?.message ?? '预览失败' },
    }))
  }, [pending, previewTask])
  // a mapping change invalidates every cached preview
  const mapKey = JSON.stringify(mapping) + (sheet?.name ?? '')
  React.useEffect(() => setPreviews({}), [mapKey])

  const runPreview = async (row: number) => {
    if (!table) return
    setPreviewRow(row)
    if (previews[row]?.result || pending) return
    setPending({ row, task: null })
    try {
      const r = await runBatch(project.id, body({ preview_row: row - 1 }) as never, 8)
      if (isTaskRef(r)) setPending({ row, task: r.task_id })
      else {
        setPending(null)
        setPreviews((p) => ({ ...p, [row]: { row, result: r } }))
      }
    } catch (e) {
      setPending(null)
      setPreviews((p) => ({ ...p, [row]: { row, error: errText(e) } }))
    }
  }
  const step = (d: -1 | 1) => {
    const next = Math.min(Math.max(1, previewRow + d), Math.max(1, rowCount))
    if (next !== previewRow) void runPreview(next)
  }
  const current = previews[previewRow]
  const page = current?.result?.render?.pages?.[0]
  const glyphSummary = Object.values(previews)
    .filter((p) => p.result?.render?.pages.some((pg) => pg.warnings?.missing_glyphs?.length))
    .map((p) => ({ row: p.row, chars: [...new Set(p.result!.render!.pages.flatMap((pg) => pg.warnings?.missing_glyphs ?? []))] }))
    .sort((a, b) => a.row - b.row)

  // ---- create jobs
  const [createTaskId, setCreateTaskId] = React.useState<string | null>(null)
  const [creating, setCreating] = React.useState(false)
  const createTask = useTask(createTaskId)
  const finish = React.useCallback(
    (r: BatchResult) => {
      toast.success(`已创建 ${r.jobs?.length ?? 0} 个任务`, {
        description: `${r.rows ?? 0} 条记录已排进任务队列。写完一张、换好纸后，在「任务」里开始下一张。`,
        action: { label: '查看任务', onClick: () => navigate('/jobs') },
      })
      onDone()
    },
    [navigate, onDone],
  )
  React.useEffect(() => {
    if (!createTask || !isTaskFinished(createTask)) return
    setCreateTaskId(null)
    setCreating(false)
    if (createTask.state === 'done') finish(createTask.result as BatchResult)
    else toast.error('批量生成失败', { description: createTask.state === 'cancelled' ? '生成已取消。' : (createTask.error?.message ?? '服务端渲染出错。') })
  }, [createTask, finish])
  const create = async () => {
    setCreating(true)
    try {
      const all = rowsMode === 'all' && selected.length === rowCount
      const r = await runBatch(project.id, body({ rows: all ? 'all' : selected }) as never, 5)
      if (isTaskRef(r)) setCreateTaskId(r.task_id)
      else {
        setCreating(false)
        finish(r)
      }
    } catch (e) {
      setCreating(false)
      const p = errParts(e, '批量生成失败')
      toast.error(p.title, { description: p.description })
    }
  }

  if (detail.isLoading) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    )
  }
  if (detail.error) return <ErrorState error={detail.error} onRetry={() => detail.refetch()} />

  const blockReason =
    missingRequired.length > 0
      ? `${missingRequired.map(varTitle).join('、')} 还没对应到 ${table?.file.name.split('.').pop()?.toUpperCase() ?? 'CSV'} 的某一列`
      : selected.length === 0
        ? '没有可生成的记录'
        : selected.length > 500
          ? '一次最多生成 500 条记录，请缩小范围'
          : null

  return (
    <div className="flex flex-col gap-6 px-4 pb-24 pt-2">
      {/* 1. variables */}
      <GroupedList header="模板变量" footer={variables.length ? '文本里的 {{变量名}} 会换成每条记录里对应列的内容。没有默认值的变量必须对应到某一列。' : undefined}>
        {variables.length ? (
          <div className="flex flex-wrap gap-1.5 px-4 py-3">
            {variables.map((v) => (
              <Badge key={v.name} tone={v.default ? 'gray' : 'accent'} size="md" className="font-mono">
                {`{{${v.name}}}`}
                {v.label ? <span className="font-sans">{v.label}</span> : null}
                {v.default ? <span className="font-sans text-secondary-label">默认「{v.default}」</span> : null}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="px-4 py-3 text-footnote text-secondary-label">
            这个项目还没有变量。在创作台的文字里写 <code className="font-mono">{'{{收件人}}'}</code> 这样的占位符，再在文档检查器的「数据」里添加变量。
          </p>
        )}
      </GroupedList>

      {/* 2. data source */}
      <section className="flex flex-col gap-1.5">
        <h3 className="px-4 text-footnote font-medium text-secondary-label">数据表</h3>
        {!table ? (
          <button
            type="button"
            onClick={upload}
            disabled={uploading}
            className="focus-ring press flex flex-col items-center gap-2 rounded-lg border border-dashed border-separator bg-bg-grouped-secondary px-4 py-8 text-center hover:bg-quaternary-fill"
          >
            {uploading ? <Spinner size={28} /> : <FileSpreadsheet className="size-8 text-secondary-label" strokeWidth={1.5} />}
            <span className="text-headline text-label">{uploading ? '正在读取表格…' : '导入 CSV / XLSX'}</span>
            <span className="text-footnote text-secondary-label">第一行是表头；UTF-8 和 GBK 编码都可以</span>
          </button>
        ) : (
          <GroupedList>
            <div className="flex items-center gap-3 px-4 py-2">
              <FileSpreadsheet className="size-5 shrink-0 text-green" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-body text-label">{table.file.name}</p>
                <p className="text-footnote text-secondary-label">
                  {rowCount} 条记录 · {columns.length} 列
                </p>
              </div>
              <Button size="sm" icon={<Upload />} onClick={upload} loading={uploading}>
                换一个
              </Button>
            </div>
            {table.sheets.length > 1 ? (
              <FormRow label="工作表" htmlFor="batch-sheet">
                <Select
                  id="batch-sheet"
                  value={sheet?.name}
                  onValueChange={changeSheet}
                  options={table.sheets.map((s) => ({ value: s.name, label: `${s.name}（${s.row_count} 行）` }))}
                />
              </FormRow>
            ) : null}
          </GroupedList>
        )}
        {uploadError ? (
          <p role="alert" className="px-4 text-footnote text-red">
            {uploadError}
          </p>
        ) : null}
      </section>

      {sheet ? (
        <>
          {/* 3. mapping */}
          {variables.length ? (
            <GroupedList
              header="变量对应的列"
              footer={
                missingRequired.length
                  ? `还有 ${missingRequired.length} 个必填变量没有对应的列。`
                  : '没有对应列的变量会使用默认值。'
              }
            >
              {variables.map((v) => {
                const col = mapping[v.name]
                const missing = !col && !v.default
                return (
                  <FormRow
                    key={v.name}
                    htmlFor={`map-${v.name}`}
                    error={missing ? `${varTitle(v)} 还没对应到表格的某一列` : undefined}
                    label={
                      <span className="flex items-center gap-1.5">
                        {missing ? (
                          <CircleAlert className="size-4 text-orange" aria-label="未对应" />
                        ) : col ? (
                          <Check className="size-4 text-green" strokeWidth={2.75} aria-label={autoMapped.has(v.name) ? '已自动对应' : '已对应'} />
                        ) : (
                          <span className="size-4" aria-hidden />
                        )}
                        <span className="font-mono">{v.name}</span>
                        {v.label ? <span className="text-secondary-label">{v.label}</span> : null}
                      </span>
                    }
                  >
                    <Select
                      id={`map-${v.name}`}
                      value={col ?? NONE}
                      onValueChange={(c) => {
                        setAutoMapped((s) => {
                          const n = new Set(s)
                          n.delete(v.name)
                          return n
                        })
                        setMapping((m) => {
                          const n = { ...m }
                          if (c === NONE) delete n[v.name]
                          else n[v.name] = c
                          return n
                        })
                      }}
                      className={cn('min-w-40', missing && 'shadow-[inset_0_0_0_1px_rgb(var(--orange))]')}
                      options={[
                        { value: NONE, label: v.default ? `用默认值「${v.default}」` : '不对应（留空）' },
                        ...columns.map((c) => ({ value: c, label: c })),
                      ]}
                    />
                  </FormRow>
                )
              })}
            </GroupedList>
          ) : null}

          {/* 4. data table */}
          <section className="flex flex-col gap-1.5">
            <h3 className="flex items-baseline gap-2 px-4 text-footnote font-medium text-secondary-label">
              <span>{allRowsKnown ? `全部 ${rowCount} 条记录` : `前 ${rows.length} 条记录（共 ${rowCount} 条）`}</span>
              {emptyRows.size ? (
                <span className="text-on-tint-orange">
                  · {emptyRows.size} 条有空值{allRowsKnown ? '' : '（仅检查了预览的行）'}
                </span>
              ) : null}
            </h3>
            <div className="max-h-72 overflow-auto rounded-lg bg-bg-grouped-secondary shadow-sm">
              <table className="w-full border-collapse text-left text-footnote">
                <thead className="sticky top-0 z-10 bg-bg-grouped-secondary">
                  <tr className="hairline-b">
                    <th scope="col" className="w-12 px-3 py-2 font-medium text-secondary-label">
                      #
                    </th>
                    {columns.map((c) => {
                      const used = Object.values(mapping).includes(c)
                      return (
                        <th key={c} scope="col" className={cn('whitespace-nowrap px-3 py-2 font-semibold', used ? 'text-accent' : 'text-secondary-label')}>
                          {c}
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 200).map((row, i) => {
                    const empty = emptyRows.has(i)
                    return (
                      <tr
                        key={i}
                        onClick={() => runPreview(i + 1)}
                        aria-selected={previewRow === i + 1}
                        className={cn(
                          'cursor-pointer [&+&]:hairline-t hover:bg-quaternary-fill',
                          previewRow === i + 1 && 'bg-accent/10',
                          empty && skipEmpty && 'opacity-55',
                        )}
                      >
                        <td className="px-3 py-1.5 tabular-nums text-secondary-label">
                          <span className="inline-flex items-center gap-1">
                            {empty ? <TriangleAlert className="size-3.5 text-orange" aria-label="有空值" /> : null}
                            {i + 1}
                          </span>
                        </td>
                        {columns.map((c, j) => {
                          const v = row[j]
                          const blank = v == null || String(v).trim() === ''
                          return (
                            <td key={j} className="max-w-48 truncate whitespace-nowrap px-3 py-1.5 text-label">
                              {blank ? <span className={Object.values(mapping).includes(c) ? 'text-on-tint-orange' : 'text-secondary-label'}>（空）</span> : String(v)}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* 5. preview */}
          <GroupedList header="逐条预览" footer="点表格里的一行，或用 ← → 一条条翻看，确认名字等内容都换进去了。">
            <div
              className="flex items-center gap-2 px-4 py-2"
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') step(-1)
                if (e.key === 'ArrowRight') step(1)
              }}
            >
              <IconButton label="上一条" variant="gray" size="lg" onClick={() => step(-1)} disabled={previewRow <= 1 || !!pending}>
                <ChevronLeft />
              </IconButton>
              <NumberField
                aria-label="第几条记录"
                value={previewRow}
                onChange={(v) => setPreviewRow(v)}
                min={1}
                max={Math.max(1, rowCount)}
                stepper={false}
                className="w-20"
              />
              <span className="text-footnote tabular-nums text-secondary-label">/ {rowCount}</span>
              <IconButton label="下一条" variant="gray" size="lg" onClick={() => step(1)} disabled={previewRow >= rowCount || !!pending}>
                <ChevronRight />
              </IconButton>
              <span className="flex-1" />
              <Button icon={<Eye />} onClick={() => runPreview(previewRow)} loading={!!pending} disabled={!!current?.result}>
                预览
              </Button>
            </div>
            <div className="px-4 pb-4 pt-1">
              {rows[previewRow - 1] && Object.keys(mapping).length ? (
                <p className="mb-2 flex flex-wrap gap-1.5 text-footnote">
                  {variables
                    .filter((v) => mapping[v.name])
                    .map((v) => {
                      const val = rows[previewRow - 1]?.[colIndex(mapping[v.name])]
                      const blank = val == null || String(val).trim() === ''
                      return (
                        <span key={v.name} className={cn('rounded-xs px-1.5 py-0.5', blank ? 'bg-orange/15 text-on-tint-orange' : 'bg-accent/10 text-label')}>
                          <span className="text-secondary-label">{v.label || v.name}：</span>
                          {blank ? '（空）' : String(val)}
                        </span>
                      )
                    })}
                </p>
              ) : null}
              {pending?.row === previewRow ? (
                <div className="flex aspect-[209/296] max-h-[60vh] w-full flex-col items-center justify-center gap-2 rounded-md bg-canvas-desk text-footnote text-secondary-label">
                  <ProgressBar value={previewTask?.progress != null ? previewTask.progress * 100 : null} className="max-w-48" label="预览进度" />
                  正在生成第 {previewRow} 条的预览…
                </div>
              ) : current?.error ? (
                <p role="alert" className="text-footnote text-red">
                  {current.error}
                </p>
              ) : page && current?.result?.render ? (
                <div className="flex flex-col gap-2">
                  <div className="flex justify-center rounded-md bg-canvas-desk p-3">
                    <img
                      src={previewSvgUrl(current.result.render.rid, page.index)}
                      alt={`第 ${previewRow} 条记录的预览`}
                      className="max-h-[60vh] w-auto max-w-full bg-canvas-paper shadow-paper"
                      style={{ aspectRatio: `${page.width_mm} / ${page.height_mm}` }}
                    />
                  </div>
                  <p className="text-center text-footnote tabular-nums text-secondary-label">
                    {Math.round(page.width_mm)}×{Math.round(page.height_mm)} mm · {current.result.render.pages.length} 页 · 约 {formatDuration(page.est_s)}
                    {page.out_of_work_area ? <span className="text-red"> · 超出机器行程</span> : null}
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => runPreview(previewRow)}
                  className="focus-ring flex aspect-[209/296] max-h-64 w-full items-center justify-center rounded-md bg-canvas-desk text-footnote text-secondary-label hover:text-label"
                >
                  点「预览」查看第 {previewRow} 条写出来的样子
                </button>
              )}
              {glyphSummary.length ? (
                <div className="mt-3 rounded-md bg-orange/10 px-3 py-2 text-footnote text-on-tint-orange" role="status">
                  <span className="font-medium">有缺字：</span>
                  {glyphSummary.map((g, i) => (
                    <React.Fragment key={g.row}>
                      {i ? '、' : ''}
                      <button type="button" className="focus-ring rounded-xs underline underline-offset-2" onClick={() => runPreview(g.row)}>
                        第 {g.row} 条（{g.chars.join('')}）
                      </button>
                    </React.Fragment>
                  ))}
                  。这些字会画成方框，可以换字体或在字库里补全。
                </div>
              ) : null}
            </div>
          </GroupedList>

          {/* 6. range + naming */}
          <GroupedList header="生成" footer="每条记录（每一页）生成一个排队任务。写完一张、换好纸后，在「任务」里开始下一张。">
            <FormRow label="记录范围" htmlFor="batch-rows">
              <Segmented
                aria-label="记录范围"
                value={rowsMode}
                onValueChange={setRowsMode}
                options={[
                  { value: 'all', label: `全部 ${rowCount} 条` },
                  { value: 'range', label: '指定范围' },
                ]}
              />
            </FormRow>
            {rowsMode === 'range' ? (
              <FormRow label="从第几条到第几条" htmlFor="batch-from">
                <NumberField id="batch-from" aria-label="起始记录" value={range[0]} min={1} max={range[1]} onChange={(v) => setRange([v, range[1]])} className="w-28" />
                <span className="text-secondary-label">–</span>
                <NumberField aria-label="结束记录" value={range[1]} min={range[0]} max={Math.max(1, rowCount)} onChange={(v) => setRange([range[0], v])} className="w-28" />
              </FormRow>
            ) : null}
            {emptyRows.size ? (
              <FormRow label={`跳过有空值的记录（${emptyRows.size} 条）`} htmlFor="batch-skip-empty" help={allRowsKnown ? undefined : '只能检查已读取的行；其余记录照常生成。'}>
                <Switch id="batch-skip-empty" checked={skipEmpty} onCheckedChange={setSkipEmpty} />
              </FormRow>
            ) : null}
            <FormRow label="任务名称" htmlFor="batch-name" help="可以用 {{变量}}；{{_row}} 是行号">
              <Input id="batch-name" value={namePattern} onChange={(e) => setNamePattern(e.currentTarget.value)} className="max-w-56 font-mono" />
            </FormRow>
          </GroupedList>

          <div className="flex flex-col gap-2">
            {createTask && !isTaskFinished(createTask) ? (
              <ProgressBar value={(createTask.progress ?? 0) * 100} label="批量生成进度" valueText={`${Math.round((createTask.progress ?? 0) * 100)}%`} />
            ) : null}
            {blockReason ? (
              <p role="alert" className="flex items-center justify-center gap-1.5 text-center text-footnote text-on-tint-orange">
                <CircleAlert className="size-4 shrink-0" aria-hidden />
                {blockReason}
              </p>
            ) : null}
            <Button variant="filled" size="lg" block icon={<ListChecks />} onClick={create} loading={creating} disabled={!!blockReason}>
              {creating ? '正在生成…' : `生成 ${selected.length} 个任务`}
            </Button>
          </div>
        </>
      ) : !table ? null : (
        <EmptyState icon={FileSpreadsheet} title="表格是空的" description="没有读到任何工作表。检查文件是否有表头和数据后再试。" />
      )}
    </div>
  )
}
