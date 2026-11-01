/**
 * Global drop target: .penplot.json / .json / .zip → 导入为项目 (02-ux §2.7). Kept light: no feature code at module scope.
 */
import { FolderInput } from 'lucide-react'
import { registerImportHandler } from '@/lib/import-registry'

registerImportHandler({
  id: 'projects.import',
  label: '导入为项目',
  description: '项目 JSON 或 ZIP 包',
  icon: FolderInput,
  priority: 10,
  accept: ['.penplot.json', '.json', '.zip'],
  run: async (files, { navigate }) => {
    const { importProjectFiles } = await import('./import-files')
    const id = await importProjectFiles(files)
    if (id) navigate(`/studio/${id}`)
  },
})
