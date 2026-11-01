import { cn } from '@/lib/cn'

/** Shared styles for DropdownMenu & ContextMenu (macOS menu look). */
export const menuContent = cn(
  'mat-thick z-50 min-w-44 overflow-hidden rounded-lg p-1 text-body text-label shadow-md outline-none',
  // icon column: when any item of this menu has an icon, every item gets the (possibly empty) slot so labels align
  '[&:has([data-menu-icon]>*)_[data-menu-icon]]:flex [&:has([role=menuitemcheckbox],[role=menuitemradio])_[data-menu-icon]]:flex',
  'data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out',
)
export const menuItem = cn(
  'relative flex h-6 cursor-default select-none items-center gap-2 rounded-[5px] px-2 outline-none pointer-coarse:h-11 pointer-coarse:px-3',
  'data-[highlighted]:bg-accent data-[highlighted]:text-white data-[disabled]:opacity-40',
  '[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-secondary-label data-[highlighted]:[&_svg]:text-white',
  'data-[variant=destructive]:text-red data-[variant=destructive]:[&_svg]:text-red data-[variant=destructive]:data-[highlighted]:bg-red data-[variant=destructive]:data-[highlighted]:text-white',
)
export const menuSeparator = 'mx-2 my-1 h-px scale-y-50 bg-separator'
export const menuLabel = 'px-2 pb-0.5 pt-1.5 text-footnote font-semibold text-secondary-label'
export const menuShortcut = 'ml-auto pl-4 text-footnote tracking-wide text-secondary-label [[data-highlighted]_&]:text-white/80'
/** Fixed-width icon cell at the start of a menu item (hidden unless some item in the same menu has an icon). */
export const menuIcon = 'hidden size-4 shrink-0 items-center justify-center'
/** Label cell: one line, truncates; inline icons inside it stay on the same line. */
export const menuText = 'flex min-w-0 flex-1 items-center gap-2 truncate'
