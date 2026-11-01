/**
 * Registration point for global drag-and-drop import handlers (see '@/lib/import-registry').
 * Imported once at startup. Phase-2 features: add one line importing your own small module that
 * calls `registerImportHandler(...)` (keep it light — no heavy feature code at module scope).
 *
 * The foundation registers only a low-priority fallback: upload to the file library.
 */
import { FolderUp } from 'lucide-react'
import { api } from '@/api/client'
import { queryClient, qk } from '@/api/query'
import { registerImportHandler } from '@/lib/import-registry'
import { toast } from '@/lib/toast'

registerImportHandler({
  id: 'files.upload',
  label: '上传到文件库',
  description: '稍后可在项目中引用',
  icon: FolderUp,
  priority: -100,
  accept: ['.svg', '.dxf', '.png', '.jpg', '.jpeg', '.webp', '.gcode', '.nc', '.gco', '.txt', '.csv', '.xlsx'],
  run: async (files) => {
    for (const f of files) {
      const fd = new FormData()
      fd.append('file', f, f.name)
      await api.post('/files', fd, { timeoutMs: 120_000 })
    }
    void queryClient.invalidateQueries({ queryKey: qk.files.all })
    toast.success(files.length > 1 ? `已上传 ${files.length} 个文件` : `已上传 ${files[0].name}`)
  },
})

// Phase-2 registrations go below, e.g.:
// import '@/features/fonts/import-handler'
// import '@/features/studio/import-handler'
import '@/features/studio/import-handler'
import '@/features/fonts/import-handler'
import '@/features/projects/import-handler'
