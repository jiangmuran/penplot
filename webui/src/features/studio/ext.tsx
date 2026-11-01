/**
 * Optional integrations provided by other agents, picked up when they exist (build works either way):
 * - `describeError(err)` from @/lib or @/api (human-readable errors)
 * - `<HelpLink topic="…"/>` from features/help/HelpLink.tsx (terminology popovers)
 */
import type * as React from 'react'
import { errorMessage } from '@/api/client'

const libs = import.meta.glob(['/src/lib/*.ts', '/src/api/*.ts', '!/src/api/*.d.ts'], { eager: true }) as Record<string, Record<string, unknown>>
const help = import.meta.glob('/src/features/help/HelpLink.tsx', { eager: true }) as Record<string, Record<string, unknown>>

type Describe = (e: unknown) => string | { title?: string; hint?: string; message?: string; description?: string }
const mod = Object.values(libs).find((m) => typeof m.describeErrorText === 'function' || typeof m.describeError === 'function')
const describe = (mod?.describeErrorText ?? mod?.describeError) as Describe | undefined

/** Plain-language message for an error. */
export function errText(e: unknown): string {
  if (describe) {
    try {
      const d = describe(e)
      if (typeof d === 'string') return d
      if (d) return [d.title, d.hint ?? d.message ?? d.description].filter(Boolean).join('。') || errorMessage(e)
    } catch {
      /* fall through */
    }
  }
  return errorMessage(e)
}

const HelpLinkImpl = Object.values(help)[0]?.HelpLink as React.ComponentType<{ topic: string }> | undefined

export function Help({ topic }: { topic: string }) {
  return HelpLinkImpl ? <HelpLinkImpl topic={topic} /> : null
}
