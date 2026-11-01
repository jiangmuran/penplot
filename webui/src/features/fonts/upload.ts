/** Font file intake shared by the toolbar button and the global drop handler. */
import { errorMessage } from '@/api/client'
import { uploadFont } from '@/api/fonts'
import { isTaskRef } from '@/api/tasks'
import { fileExt } from '@/lib/format'
import { toast } from '@/lib/toast'
import { FONT_EXTS, TTF_EXTS, useFontsUi } from './store'

/**
 * Install .gfont/.psf files directly; the first .ttf/.otf/.ttc opens the conversion sheet.
 * Returns the id of the last installed font (to select it).
 */
export async function installFontFiles(files: File[]): Promise<string | null> {
  const direct = files.filter((f) => FONT_EXTS.includes(fileExt(f.name)))
  const ttf = files.filter((f) => TTF_EXTS.includes(fileExt(f.name)))
  const other = files.filter((f) => !direct.includes(f) && !ttf.includes(f))
  if (other.length) toast.warning('有文件不是字体', { description: `${other.map((f) => f.name).join('、')} 不能安装。可以导入单线字体文件，或 TTF、OTF、TTC 字体。` })
  if (ttf.length) {
    useFontsUi.getState().openTtf(ttf[0])
    if (ttf.length > 1) toast.info('一次只能转换一个 TTF 字体', { description: `已选择 ${ttf[0].name}` })
  }
  let last: string | null = null
  let ok = 0
  for (const f of direct) {
    try {
      const r = await uploadFont(f)
      if (!isTaskRef(r)) {
        last = r.id
        ok++
      }
    } catch (e) {
      toast.error(`没能导入 ${f.name}`, { description: `${errorMessage(e)}。确认文件没有损坏，再试一次。` })
    }
  }
  if (ok) toast.success(ok > 1 ? `已安装 ${ok} 个字体` : `已安装 ${direct[0].name}`)
  return last
}
