import { ChevronRight, type LucideIcon } from 'lucide-react'
import * as React from 'react'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/cn'

/** Elevated content card (radius 10, on grouped background). */
export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg bg-bg-grouped-secondary shadow-sm', className)} {...p} />
}
export function CardHeader({ className, title, subtitle, actions, ...p }: Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> & { title?: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className={cn('flex items-start gap-3 px-4 pb-2 pt-3.5', className)} {...p}>
      <div className="min-w-0 flex-1">
        {title ? <h3 className="text-headline text-label">{title}</h3> : null}
        {subtitle ? <p className="text-footnote text-secondary-label">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  )
}
export function CardBody({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 pb-4', className)} {...p} />
}

/**
 * Inset grouped list (iOS Settings / macOS System Settings):
 *
 *   <GroupedList header="连接" footer="修改后需重新连接">
 *     <ListRow label="端口" value="/dev/ttyUSB0" onClick={…} />
 *     <ListRow icon={Wifi} iconColor="bg-blue" label="网络" to="/system" />
 *     <FormRow label="波特率"><Select …/></FormRow>
 *   </GroupedList>
 */
export function GroupedList({
  header, footer, children, className, inset = true,
}: { header?: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode; className?: string; inset?: boolean }) {
  return (
    <section className={cn('flex flex-col', className)}>
      {header ? <h3 className="mb-1.5 px-4 text-footnote font-medium uppercase tracking-wide text-secondary-label">{header}</h3> : null}
      <div
        className={cn(
          'overflow-hidden bg-bg-grouped-secondary',
          inset ? 'rounded-lg shadow-sm' : '',
          // inset hairline between rows (starts at the 16px content inset, like iOS)
          '[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:left-4 [&>*+*]:before:right-0 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:origin-top [&>*+*]:before:scale-y-50 [&>*+*]:before:bg-separator [&>*+*]:before:content-[""]',
        )}
      >
        {children}
      </div>
      {footer ? <p className="mt-1.5 px-4 text-footnote text-secondary-label">{footer}</p> : null}
    </section>
  )
}

export interface ListRowProps {
  label: React.ReactNode
  /** Secondary text under the label */
  subtitle?: React.ReactNode
  /** Right-aligned value */
  value?: React.ReactNode
  /** Leading 28px rounded colour tile icon (设置 style) */
  icon?: LucideIcon
  /** Tailwind bg class for the icon tile, e.g. "bg-blue" */
  iconColor?: string
  /** Trailing accessory (switch, badge…) */
  accessory?: React.ReactNode
  onClick?: () => void
  to?: string
  /** Show disclosure chevron (default: when clickable) */
  chevron?: boolean
  destructive?: boolean
  disabled?: boolean
  selected?: boolean
  className?: string
}

export function ListRow({
  label, subtitle, value, icon: Icon, iconColor = 'bg-gray', accessory, onClick, to, chevron, destructive, disabled, selected, className,
}: ListRowProps) {
  const clickable = !!onClick || !!to
  const content = (
    <>
      {Icon ? (
        <span className={cn('flex size-[22px] shrink-0 items-center justify-center rounded-[6px] text-white pointer-coarse:size-[29px] pointer-coarse:rounded-[7px]', iconColor)}>
          <Icon className="size-3.5 pointer-coarse:size-[18px]" strokeWidth={2.25} />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 text-left">
        <span className={cn('block truncate text-body', destructive ? 'text-red' : 'text-label')}>{label}</span>
        {subtitle ? <span className="block truncate text-footnote text-secondary-label">{subtitle}</span> : null}
      </span>
      {value != null ? <span className="min-w-0 shrink truncate text-body text-secondary-label tabular-nums">{value}</span> : null}
      {accessory}
      {(chevron ?? clickable) && !destructive ? <ChevronRight className="size-4 shrink-0 text-tertiary-label" strokeWidth={2.25} /> : null}
    </>
  )
  const cls = cn(
    'flex min-h-[var(--row-h)] w-full items-center gap-3 px-4 py-1.5',
    clickable && 'focus-ring -outline-offset-2 transition-colors hover:bg-quaternary-fill active:bg-tertiary-fill',
    selected && 'bg-accent/10',
    disabled && 'pointer-events-none opacity-40',
    className,
  )
  if (to) return <Link to={to} className={cn(cls, 'text-label')}>{content}</Link>
  if (onClick) return <button type="button" onClick={onClick} disabled={disabled} className={cls}>{content}</button>
  return <div className={cls}>{content}</div>
}
