/** 在线用户 (presence) on the 概览 tab. */
import { Users } from 'lucide-react'
import { clientLabel, isUnavailable, ROLE_LABEL, usePresence } from '@/api/collab'
import { useLive } from '@/api/store'
import { Badge, Card, CardHeader, ErrorState, Skeleton } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'

const TINTS = ['bg-blue', 'bg-purple', 'bg-pink', 'bg-orange', 'bg-green', 'bg-teal', 'bg-indigo']
const tint = (s: string) => TINTS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length]

const PAGES: [string, string][] = [
  ['/studio', '创作台'], ['/projects', '项目'], ['/fonts', '字库'], ['/teletype', '电传'], ['/machine', '控制'],
  ['/jobs', '任务'], ['/console', '调试'], ['/settings', '设置'], ['/system', '系统'],
]
function pageLabel(p?: string | null) {
  if (!p) return null
  return PAGES.find(([k]) => p === k || p.startsWith(k + '/'))?.[1] ?? null
}

export function PresenceCard() {
  const presence = usePresence()
  const connId = useLive((s) => s.connId)
  const list = presence.data ?? []
  return (
    <Card className="overflow-hidden">
      <CardHeader title="在线用户" subtitle={presence.data ? `${list.length} 个连接` : undefined} />
      {presence.isLoading ? (
        <div className="flex flex-col gap-3 px-4 pb-4">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-full" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      ) : isUnavailable(presence.error) ? (
        <p className="hairline-t px-4 py-3 text-footnote text-secondary-label">尚不可用（后端尚未提供）</p>
      ) : presence.error ? (
        <ErrorState error={presence.error} onRetry={() => presence.refetch()} className="py-6" />
      ) : list.length === 0 ? (
        <div className="hairline-t flex items-center gap-2 px-4 py-3 text-footnote text-secondary-label">
          <Users className="size-4" aria-hidden />
          没有其他在线用户
        </div>
      ) : (
        <ul className="hairline-t [&>*+*]:hairline-t">
          {list.map((p) => {
            const name = p.user.display_name || p.user.username
            const role = p.user.role
            const me = !!connId && p.conn_id === connId
            const idle = false
            return (
              <li key={p.conn_id} className="flex min-h-11 items-center gap-3 px-4 py-2">
                <span
                  aria-hidden
                  className={cn('relative flex size-8 shrink-0 items-center justify-center rounded-full text-callout font-semibold text-white', tint(p.user.username))}
                >
                  {[...name][0]?.toUpperCase()}
                  <span
                    className={cn('absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-bg-grouped-secondary', idle ? 'bg-gray' : 'bg-green')}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5">
                    <span className="truncate text-body text-label">{name}</span>
                    {me ? (
                      <Badge tone="accent" size="sm">
                        本机
                      </Badge>
                    ) : null}
                    {role ? (
                      <Badge tone={role === 'admin' ? 'orange' : role === 'operator' ? 'blue' : 'gray'} size="sm">
                        {ROLE_LABEL[role]}
                      </Badge>
                    ) : null}
                  </p>
                  <p className="truncate text-footnote text-secondary-label">
                    {[clientLabel(p.client), pageLabel(p.page)].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="shrink-0 text-right text-footnote tabular-nums text-secondary-label">
                  <p>{formatRelative(p.since)}上线</p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
