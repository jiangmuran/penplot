import { ArrowUpRight, PenTool } from 'lucide-react'
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { qk } from '@/api/query'
import type { SystemHealth } from '@/api/types'
import { cn } from '@/lib/cn'

/** Centered card on secondarySystemBackground (02-ux §3.12). Compact: full-width form, no card. */
export function AuthLayout({ title, subtitle, children, shake }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode; shake?: number }) {
  const health = useQuery({
    queryKey: qk.system.health,
    queryFn: () => api.get<SystemHealth>('/system/health', { skipAuthHandling: true, timeoutMs: 5000 }),
    retry: false,
    staleTime: 60_000,
  })
  React.useEffect(() => {
    document.title = `${title} · PenPlot`
  }, [title])
  return (
    <div className="flex min-h-dvh flex-col items-center bg-bg-secondary px-4 pt-safe pb-safe sm:justify-center">
      <div className="flex w-full flex-1 flex-col justify-center sm:flex-none">
        <div
          key={shake}
          className={cn(
            'mx-auto w-full max-w-[360px] sm:rounded-xl sm:bg-bg-elevated sm:p-8 sm:pt-9 sm:shadow-lg',
            shake ? 'motion-safe:animate-shake' : '',
          )}
        >
          <div className="mb-7 flex flex-col items-center text-center">
            <span className="mb-3 flex size-14 items-center justify-center rounded-[14px] bg-gradient-to-b from-accent to-accent/75 text-white shadow-md">
              <PenTool className="size-7" strokeWidth={2} />
            </span>
            <h1 className="text-large-title">{title}</h1>
            {subtitle ? <p className="mt-1 text-subheadline text-secondary-label">{subtitle}</p> : null}
          </div>
          {children}
        </div>
      </div>
      <footer className="flex shrink-0 items-center gap-2 py-6 text-footnote text-secondary-label">
        <span>{health.data?.version ? `v${health.data.version}` : health.isError ? '设备离线' : 'PenPlot'}</span>
        <span aria-hidden>·</span>
        <a href="/api/v1/docs" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-secondary-label hover:text-label">
          API 文档 <ArrowUpRight className="size-3" />
        </a>
      </footer>
    </div>
  )
}
