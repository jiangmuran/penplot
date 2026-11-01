import { ListChecks, RotateCw, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { isRouteErrorResponse, useLocation, useNavigate, useRouteError } from 'react-router-dom'
import { describeError } from '@/api/errors'
import { Button, Card } from '@/components/ui'
import { Page } from './page'

const CHUNK_RE = /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch dynamically/i

/**
 * Error card rendered *inside* the shell's outlet when a page crashes (route errorElement), so the
 * sidebar, toolbar, status, mini-player and E-stop stay alive. 05-review §0-1.
 */
export function PageError({ error: errorProp, onReset }: { error?: unknown; onReset?: () => void }) {
  const routeError = useRouteErrorSafe()
  const error = errorProp ?? routeError
  const navigate = useNavigate()
  const loc = useLocation()
  const [open, setOpen] = React.useState(false)
  const chunk = error instanceof Error && CHUNK_RE.test(error.message)
  const notFound = isRouteErrorResponse(error) && error.status === 404
  const d = describeError(error)
  const stack = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : (d.technical ?? String(error))
  return (
    <Page title={chunk ? '界面已更新' : '这一页出错了'} maxWidth={560}>
      <Card className="mt-2 px-6 py-8 text-center md:mt-10" role="alert">
        <TriangleAlert className="mx-auto mb-3 size-12 text-orange" strokeWidth={1.5} aria-hidden />
        <h2 className="text-title3 text-label">{chunk ? '界面已更新，需要重新加载' : notFound ? '页面不存在' : '这一页出错了'}</h2>
        <p className="mx-auto mt-1.5 max-w-sm text-balance text-subheadline text-secondary-label">
          {chunk
            ? '设备上的 PenPlot 刚刚更新过，重新加载即可使用新版本。'
            : '写字机不受影响：正在进行的任务会继续，急停随时可用。你可以重试这一页，或去任务页查看进度。'}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Button
            variant="filled"
            icon={<RotateCw />}
            onClick={() => {
              if (chunk) location.reload()
              else if (onReset) onReset()
              // Re-navigating to the same URL clears the route error and re-renders the page.
              else navigate(loc.pathname + loc.search, { replace: true })
            }}
          >
            {chunk ? '重新加载' : '重试'}
          </Button>
          <Button variant="gray" icon={<ListChecks />} onClick={() => navigate('/jobs')}>
            回到任务
          </Button>
        </div>
        {!chunk ? (
          <div className="mt-4">
            <button type="button" className="min-h-8 text-footnote text-secondary-label hover:text-label" onClick={() => setOpen(!open)} aria-expanded={open}>
              技术详情 {open ? '▴' : '▾'}
            </button>
            {open ? (
              <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md bg-quaternary-fill p-3 text-left font-mono text-caption text-secondary-label">
                {stack}
              </pre>
            ) : null}
          </div>
        ) : null}
      </Card>
    </Page>
  )
}

/** useRouteError throws outside a data-router error context; tolerate that for boundary use. */
function useRouteErrorSafe(): unknown {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useRouteError()
  } catch {
    return undefined
  }
}
