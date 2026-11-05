import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next } from 'next/font/google'

// Made for legibility (the Braille Institute's): keys and hashes have to be read and compared by eye.
export const sans = Atkinson_Hyperlegible_Next({
  subsets: ['latin'],
  variable: '--sans',
  display: 'swap',
  fallback: ['system-ui', 'sans-serif'],
  adjustFontFallback: false,
})
export const mono = Atkinson_Hyperlegible_Mono({
  subsets: ['latin'],
  variable: '--mono',
  display: 'swap',
  fallback: ['ui-monospace', 'monospace'],
  adjustFontFallback: false,
})
