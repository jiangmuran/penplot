/**
 * Global drag-and-drop handlers for the studio (02-ux §2.7). Imported once from src/app/import-handlers.ts.
 * Keep this module light: only the registry, the queue and icons.
 */
import { FileImage, FileInput, FileText, FolderOpen, ImagePlus, PenTool, ScrollText } from 'lucide-react'
import { api } from '@/api/client'
import { registerImportHandler } from '@/lib/import-registry'
import { toast } from '@/lib/toast'
import { enqueueImport } from './import-queue'

const goStudio = (pathname: string, navigate: (to: string) => void) => {
  if (!pathname.startsWith('/studio')) navigate('/studio')
}

registerImportHandler({
  id: 'studio.add-vector',
  label: '添加到当前页',
  description: '矢量元素，保留路径',
  icon: PenTool,
  priority: 50,
  accept: ['.svg', '.dxf'],
  run: (files, { navigate, pathname }) => {
    enqueueImport({ files })
    goStudio(pathname, navigate)
  },
})

registerImportHandler({
  id: 'studio.add-image',
  label: '添加到当前页',
  description: '图片元素，可描摹为路径',
  icon: ImagePlus,
  priority: 50,
  accept: ['.png', '.jpg', '.jpeg', '.webp'],
  run: (files, { navigate, pathname }) => {
    enqueueImport({ files })
    goStudio(pathname, navigate)
  },
})

registerImportHandler({
  id: 'studio.background',
  label: '设为参考背景',
  description: '笔记模板 / 扫描件，垫在下面对齐用，不会写出来',
  icon: FileImage,
  priority: 45,
  accept: ['.pdf', '.png', '.jpg', '.jpeg', '.webp'],
  run: (files, { navigate, pathname }) => {
    enqueueImport({ files: files.slice(0, 1), as: 'background' })
    goStudio(pathname, navigate)
  },
})

registerImportHandler({
  id: 'studio.add-gcode',
  label: '添加到当前页',
  description: 'G 代码元素（只读路径，可变换）',
  icon: FileInput,
  priority: 50,
  accept: ['.gcode', '.nc', '.gco'],
  run: (files, { navigate, pathname }) => {
    enqueueImport({ files })
    goStudio(pathname, navigate)
  },
})

registerImportHandler({
  id: 'studio.add-text',
  label: '添加为文本框',
  icon: FileText,
  priority: 50,
  accept: ['.txt'],
  run: (files, { navigate, pathname }) => {
    enqueueImport({ files })
    goStudio(pathname, navigate)
  },
})

registerImportHandler({
  id: 'studio.letter-text',
  label: '作为信笺正文',
  description: '跨页自动排版',
  icon: ScrollText,
  priority: 40,
  accept: ['.txt'],
  run: (files, { navigate, pathname }) => {
    enqueueImport({ files: files.slice(0, 1), as: 'letter' })
    goStudio(pathname, navigate)
  },
})

registerImportHandler({
  id: 'studio.open-project',
  label: '打开为项目',
  description: '导入 .penplot.json 并在创作台打开',
  icon: FolderOpen,
  priority: 30,
  accept: ['.penplot.json', '.json'],
  run: async (files, { navigate }) => {
    let last: string | null = null
    for (const f of files) {
      const fd = new FormData()
      fd.append('file', f, f.name)
      const r = await api.post<{ project: { id: string; name: string }; missing_fonts: string[] }>('/projects/import', fd, { timeoutMs: 120_000 })
      last = r.project.id
      if (r.missing_fonts?.length) toast.warning(`缺少 ${r.missing_fonts.length} 个字体`, { description: r.missing_fonts.join('、') })
      else toast.success('已导入项目', { description: r.project.name })
    }
    if (last) navigate(`/studio/${last}`)
  },
})
