import { FileQuestion, Upload } from 'lucide-react'
import * as React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { cn } from '@/lib/cn'
import { fileExt } from '@/lib/format'
import {
  KNOWN_IMPORT_EXTS, extFromMime, handlersFor, handlersForExts, useImportRegistryVersion, type ImportContext, type ImportHandler,
} from '@/lib/import-registry'
import { toast } from '@/lib/toast'
import { errorMessage } from '@/api/client'

type Phase =
  | { kind: 'idle' }
  | { kind: 'drag'; exts: string[] | null }
  | { kind: 'choose'; files: File[]; handlers: ImportHandler[] }
  | { kind: 'unsupported'; exts: string[] }

function hasFiles(e: DragEvent) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
}

/** Global drag-and-drop import overlay (02-ux §2.7). Handlers come from '@/lib/import-registry'. */
export function DropOverlay() {
  const [phase, setPhase] = React.useState<Phase>({ kind: 'idle' })
  const [hover, setHover] = React.useState<string | null>(null)
  const depth = React.useRef(0)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  useImportRegistryVersion()
  const ctx: ImportContext = React.useMemo(() => ({ navigate, pathname }), [navigate, pathname])
  const ctxRef = React.useRef(ctx)
  ctxRef.current = ctx

  const run = React.useCallback(async (h: ImportHandler, files: File[]) => {
    setPhase({ kind: 'idle' })
    try {
      await h.run(files, ctxRef.current)
    } catch (e) {
      toast.error(`${h.label}失败`, { description: errorMessage(e) })
    }
  }, [])

  const handleFiles = React.useCallback(
    (files: File[], target?: ImportHandler) => {
      if (!files.length) return setPhase({ kind: 'idle' })
      const hs = handlersFor(files, ctxRef.current)
      if (target && hs.some((h) => h.id === target.id)) return void run(target, files)
      if (hs.length === 1) return void run(hs[0], files)
      if (hs.length > 1) return setPhase({ kind: 'choose', files, handlers: hs })
      const exts = [...new Set(files.map((f) => fileExt(f.name) || '(无扩展名)'))]
      setPhase({ kind: 'unsupported', exts })
      setTimeout(() => setPhase((p) => (p.kind === 'unsupported' ? { kind: 'idle' } : p)), 2200)
    },
    [run],
  )

  React.useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      if (depth.current === 1) {
        const items = Array.from(e.dataTransfer?.items ?? []).filter((i) => i.kind === 'file')
        const exts = items.map((i) => extFromMime(i.type))
        setPhase({ kind: 'drag', exts: exts.length && exts.every(Boolean) ? (exts as string[]) : null })
      }
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setPhase((p) => (p.kind === 'drag' ? { kind: 'idle' } : p))
    }
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      // Card-specific drops are handled by the card's own onDrop (it stops propagation).
      handleFiles(Array.from(e.dataTransfer?.files ?? []))
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [handleFiles])

  React.useEffect(() => {
    if (phase.kind !== 'choose') return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPhase({ kind: 'idle' })
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase.kind])

  if (phase.kind === 'idle') return null

  const guessed = phase.kind === 'drag' && phase.exts ? handlersForExts(phase.exts, ctx) : []
  const cards = phase.kind === 'choose' ? phase.handlers : guessed
  const unknownGuess = phase.kind === 'drag' && phase.exts?.find((x) => !KNOWN_IMPORT_EXTS.includes(x))

  return (
    <div
      className="mat-thick fixed inset-0 z-[85] flex flex-col items-center justify-center gap-6 p-6 animate-fade-in"
      onClick={() => phase.kind === 'choose' && setPhase({ kind: 'idle' })}
    >
      {phase.kind === 'unsupported' || unknownGuess ? (
        <div className="flex flex-col items-center gap-2 text-center">
          <FileQuestion className="size-12 text-orange" strokeWidth={1.5} />
          <p className="text-title3 text-on-tint-orange">不支持 {phase.kind === 'unsupported' ? phase.exts.join('、') : unknownGuess}</p>
          <p className="text-subheadline text-secondary-label">支持 SVG、DXF、图片、G 代码、TXT、CSV、字体与项目文件</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col items-center gap-1 text-center">
            <h2 className="text-title2 text-label">{phase.kind === 'choose' ? `导入 ${phase.files.length} 个文件` : '松开以导入'}</h2>
            <p className="text-subheadline text-secondary-label">{phase.kind === 'choose' ? '选择导入方式' : cards.length ? '拖到下方的目标上' : '文件类型将在松开后识别'}</p>
          </div>
          {cards.length ? (
            <div className="flex w-full max-w-3xl flex-wrap items-stretch justify-center gap-4">
              {cards.map((h, i) => {
                const Icon = h.icon ?? Upload
                const highlighted = hover ? hover === h.id : i === 0
                return (
                  <button
                    key={h.id}
                    type="button"
                    onDragEnter={() => setHover(h.id)}
                    onDragLeave={() => setHover((x) => (x === h.id ? null : x))}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      depth.current = 0
                      setHover(null)
                      handleFiles(Array.from(e.dataTransfer.files), h)
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (phase.kind === 'choose') void run(h, phase.files)
                    }}
                    autoFocus={phase.kind === 'choose' && i === 0}
                    className={cn(
                      'focus-ring flex w-56 flex-col items-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-[transform,background-color,border-color] duration-[var(--dur-fast)]',
                      highlighted ? 'scale-[1.02] border-accent bg-accent/10' : 'border-separator bg-bg-elevated/60',
                    )}
                  >
                    <Icon className={cn('size-9', highlighted ? 'text-accent' : 'text-secondary-label')} strokeWidth={1.5} />
                    <span className="text-headline text-label">{h.label}</span>
                    {h.description ? <span className="text-footnote text-secondary-label">{h.description}</span> : null}
                  </button>
                )
              })}
            </div>
          ) : phase.kind === 'drag' ? (
            <div className="flex h-48 w-full max-w-xl items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-accent/5">
              <Upload className="size-10 text-accent" strokeWidth={1.5} />
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
