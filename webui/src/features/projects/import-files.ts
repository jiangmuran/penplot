import { importProject, invalidateProjects } from '@/api/projects'
import { toast } from '@/lib/toast'
import { errParts } from './ext'

/** Import project files one by one; toasts results. Returns the id of the last imported project. */
export async function importProjectFiles(files: File[]): Promise<string | null> {
  let last: string | null = null
  for (const f of files) {
    try {
      const r = await importProject(f)
      last = r.project.id
      if (r.missing_fonts?.length) {
        toast.warning(`已导入“${r.project.name}”，但缺少 ${r.missing_fonts.length} 个字体`, {
          description: `缺失：${r.missing_fonts.join('、')}。这些文字会改用默认字体书写；可以在字库里导入缺少的字体。`,
        })
      } else {
        toast.success(`已导入“${r.project.name}”`, {
          description: r.imported_files ? `含 ${r.imported_files} 个资源文件` : undefined,
        })
      }
    } catch (e) {
      const m = errParts(e, `没能导入 ${f.name}`)
      toast.error(m.title, { description: m.description })
    }
  }
  void invalidateProjects()
  return last
}
