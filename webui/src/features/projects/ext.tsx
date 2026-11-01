/**
 * Optional integrations from other agents (build works either way):
 * - `describeError(err)` from @/lib or @/api → what happened / why / what to do
 * - `<HelpLink topic="…"/>` from features/help/HelpLink.tsx → glossary popover
 * Shared by the projects and system pages.
 */
import type * as React from 'react'
import { errorMessage } from '@/api/client'

const libs = import.meta.glob(['/src/lib/*.ts', '/src/api/*.ts', '!/src/api/*.d.ts'], { eager: true }) as Record<string, Record<string, unknown>>
const help = import.meta.glob('/src/features/help/HelpLink.tsx', { eager: true }) as Record<string, Record<string, unknown>>

type Described = string | { title?: string; message?: string; description?: string; hint?: string; action?: string } | null | undefined
const describe = Object.values(libs).find((m) => typeof m.describeError === 'function')?.describeError as ((e: unknown) => Described) | undefined

/** `{ title, description }` for a toast: plain-language when the shell provides describeError. */
export function errParts(e: unknown, fallbackTitle: string): { title: string; description?: string } {
  if (describe) {
    try {
      const d = describe(e)
      if (typeof d === 'string') return { title: fallbackTitle, description: d }
      if (d) {
        const desc = [d.message ?? d.description, d.hint ?? d.action].filter(Boolean).join('')
        return { title: d.title || fallbackTitle, description: desc || errorMessage(e) }
      }
    } catch {
      /* fall through */
    }
  }
  return { title: fallbackTitle, description: errorMessage(e) }
}

/** Single-line message (inline field errors). */
export function errText(e: unknown): string {
  const p = errParts(e, '')
  return [p.title, p.description].filter(Boolean).join('：')
}

const HelpLinkImpl = Object.values(help)[0]?.HelpLink as React.ComponentType<{ topic: string; className?: string }> | undefined

/** Glossary ⓘ next to a term; renders nothing until the help feature exists. */
export function Help({ topic, className }: { topic: string; className?: string }) {
  return HelpLinkImpl ? <HelpLinkImpl topic={topic} className={className} /> : null
}
