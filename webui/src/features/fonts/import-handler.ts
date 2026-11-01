/**
 * Global drag-and-drop: install fonts (02-ux §2.7). Imported once from src/app/import-handlers.ts.
 * Kept light: no React components here.
 */
import { Type } from 'lucide-react'
import { registerImportHandler } from '@/lib/import-registry'
import { FONT_EXTS, TTF_EXTS } from './store'
import { installFontFiles } from './upload'

registerImportHandler({
  id: 'fonts.install',
  label: '安装到字库',
  description: '单线字体文件直接安装；TTF 等字体先转成单线字',
  icon: Type,
  priority: 10,
  accept: [...FONT_EXTS, ...TTF_EXTS],
  run: async (files, { navigate }) => {
    const hasTtf = files.some((f) => TTF_EXTS.some((e) => f.name.toLowerCase().endsWith(e)))
    navigate(hasTtf ? '/fonts?convert=1' : '/fonts')
    const id = await installFontFiles(files)
    if (id) navigate(`/fonts?font=${encodeURIComponent(id)}`)
  },
})
