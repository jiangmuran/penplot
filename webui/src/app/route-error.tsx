import { isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { ErrorState } from '@/components/ui'

/** Route error boundary: chunk load failures (after a deploy) and render errors. */
export function RouteError() {
  const err = useRouteError()
  const chunk = err instanceof Error && /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(err.message)
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg-grouped">
      <ErrorState
        title={chunk ? '界面已更新' : isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : '页面出错了'}
        error={chunk ? new Error('需要重新加载页面以获取最新版本。') : err}
        onRetry={() => location.reload()}
      />
    </div>
  )
}
