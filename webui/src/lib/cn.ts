import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'large-title', 'title1', 'title2', 'title3', 'headline', 'body',
            'callout', 'subheadline', 'footnote', 'caption',
          ],
        },
      ],
    },
  },
})

/** Merge Tailwind classes (later wins), aware of our typography tokens. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
