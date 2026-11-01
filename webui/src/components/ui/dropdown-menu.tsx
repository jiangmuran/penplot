import * as DM from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight } from 'lucide-react'
import * as React from 'react'
import { cn } from '@/lib/cn'
import { formatKeys } from '@/lib/shortcuts'
import { menuContent, menuIcon, menuItem, menuLabel, menuSeparator, menuShortcut, menuText } from './menu-styles'

export const DropdownMenu = DM.Root
export const DropdownMenuTrigger = DM.Trigger
export const DropdownMenuGroup = DM.Group
export const DropdownMenuSub = DM.Sub
export const DropdownMenuRadioGroup = DM.RadioGroup

export const DropdownMenuContent = React.forwardRef<
  React.ComponentRef<typeof DM.Content>,
  React.ComponentPropsWithoutRef<typeof DM.Content>
>(function DropdownMenuContent({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) {
  return (
    <DM.Portal>
      <DM.Content
        ref={ref}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(menuContent, 'origin-[var(--radix-dropdown-menu-content-transform-origin)]', className)}
        {...props}
      />
    </DM.Portal>
  )
})

export const DropdownMenuItem = React.forwardRef<
  React.ComponentRef<typeof DM.Item>,
  React.ComponentPropsWithoutRef<typeof DM.Item> & { icon?: React.ReactNode; shortcut?: string; destructive?: boolean }
>(function DropdownMenuItem({ className, icon, shortcut, destructive, children, ...props }, ref) {
  return (
    <DM.Item ref={ref} data-variant={destructive ? 'destructive' : undefined} className={cn(menuItem, className)} {...props}>
      <span data-menu-icon="" aria-hidden className={menuIcon}>{icon}</span>
      <span className={menuText}>{children}</span>
      {shortcut ? <span className={menuShortcut}>{formatKeys(shortcut).join('')}</span> : null}
    </DM.Item>
  )
})

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ComponentRef<typeof DM.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DM.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <DM.CheckboxItem ref={ref} className={cn(menuItem, 'pl-8 pointer-coarse:pl-9', className)} {...props}>
      <DM.ItemIndicator className="absolute left-2 flex w-4 items-center justify-center pointer-coarse:left-3">
        <Check className="!size-3.5" strokeWidth={2.5} />
      </DM.ItemIndicator>
      {children}
    </DM.CheckboxItem>
  )
})

export const DropdownMenuRadioItem = React.forwardRef<
  React.ComponentRef<typeof DM.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DM.RadioItem>
>(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
  return (
    <DM.RadioItem ref={ref} className={cn(menuItem, 'pl-8 pointer-coarse:pl-9', className)} {...props}>
      <DM.ItemIndicator className="absolute left-2 flex w-4 items-center justify-center pointer-coarse:left-3">
        <Check className="!size-3.5" strokeWidth={2.5} />
      </DM.ItemIndicator>
      {children}
    </DM.RadioItem>
  )
})

export const DropdownMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof DM.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DM.SubTrigger> & { icon?: React.ReactNode }
>(function DropdownMenuSubTrigger({ className, icon, children, ...props }, ref) {
  return (
    <DM.SubTrigger ref={ref} className={cn(menuItem, 'data-[state=open]:bg-quaternary-fill', className)} {...props}>
      <span data-menu-icon="" aria-hidden className={menuIcon}>{icon}</span>
      <span className={menuText}>{children}</span>
      <ChevronRight className="!size-3.5" />
    </DM.SubTrigger>
  )
})

export const DropdownMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof DM.SubContent>,
  React.ComponentPropsWithoutRef<typeof DM.SubContent>
>(function DropdownMenuSubContent({ className, ...props }, ref) {
  return (
    <DM.Portal>
      <DM.SubContent ref={ref} className={cn(menuContent, className)} {...props} />
    </DM.Portal>
  )
})

export const DropdownMenuSeparator = () => <DM.Separator className={menuSeparator} />
export const DropdownMenuLabel = ({ className, ...p }: React.ComponentPropsWithoutRef<typeof DM.Label>) => (
  <DM.Label className={cn(menuLabel, className)} {...p} />
)
