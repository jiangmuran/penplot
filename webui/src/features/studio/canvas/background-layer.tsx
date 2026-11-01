/** Reference background <image> in page-mm SVG space (canvas, position preview, print thumbnail). Never printed. */
import { fileContentUrl } from '@/api/studio-background'
import { bgSvgTransform, type PageBackground } from '../background'

export function BackgroundImage({ bg, opacity, force }: { bg: PageBackground | null | undefined; opacity?: number; force?: boolean }) {
  if (!bg || (!bg.visible && !force)) return null
  return (
    <image
      href={fileContentUrl(bg.file_id)}
      width={bg.px_w}
      height={bg.px_h}
      transform={bgSvgTransform(bg)}
      opacity={opacity ?? bg.opacity}
      preserveAspectRatio="none"
      className="pointer-events-none"
      data-background
      aria-hidden
    />
  )
}
