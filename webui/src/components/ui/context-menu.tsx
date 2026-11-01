import * as CM from '@radix-ui/react-context-menu'
import { ChevronRight } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/cn'
import { formatKeys } from '@/lib/shortcuts'
import { menuContent, menuIcon, menuItem, menuLabel, menuSeparator, menuShortcut, menuText } from './menu-styles'

export const ContextMenu = CM.Root
export const ContextMenuTrigger = CM.Trigger
export const ContextMenuGroup = CM.Group
export const ContextMenuSub = CM.Sub

export const ContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof CM.Content>,
  React.ComponentPropsWithoutRef<typeof CM.Content>
>(function ContextMenuContent({ className, collisionPadding = 8, ...props }, ref) {
  return (
    <CM.Portal>
      <CM.Content ref={ref} collisionPadding={collisionPadding} className={cn(menuContent, className)} {...props} />
    </CM.Portal>
  )
})

export const ContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof CM.Item>,
  React.ComponentPropsWithoutRef<typeof CM.Item> & { icon?: React.ReactNode; shortcut?: string; destructive?: boolean }
>(function ContextMenuItem({ className, icon, shortcut, destructive, children, ...props }, ref) {
  return (
    <CM.Item ref={ref} data-variant={destructive ? 'destructive' : undefined} className={cn(menuItem, className)} {...props}>
      <span data-menu-icon="" aria-hidden className={menuIcon}>{icon}</span>
      <span className={menuText}>{children}</span>
      {shortcut ? <span className={menuShortcut}>{formatKeys(shortcut).join('')}</span> : null}
    </CM.Item>
  )
})

export const ContextMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof CM.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof CM.SubTrigger> & { icon?: React.ReactNode }
>(function ContextMenuSubTrigger({ className, icon, children, ...props }, ref) {
  return (
    <CM.SubTrigger ref={ref} className={cn(menuItem, className)} {...props}>
      <span data-menu-icon="" aria-hidden className={menuIcon}>{icon}</span>
      <span className={menuText}>{children}</span>
      <ChevronRight className="!size-3.5" />
    </CM.SubTrigger>
  )
})
export const ContextMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof CM.SubContent>,
  React.ComponentPropsWithoutRef<typeof CM.SubContent>
>(function ContextMenuSubContent({ className, ...props }, ref) {
  return (
    <CM.Portal>
      <CM.SubContent ref={ref} className={cn(menuContent, className)} {...props} />
    </CM.Portal>
  )
})
export const ContextMenuSeparator = () => <CM.Separator className={menuSeparator} />
export const ContextMenuLabel = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof CM.Label>) => (
  <CM.Label className={cn(menuLabel, className)} {...p} />
)
