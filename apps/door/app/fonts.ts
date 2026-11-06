import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next, Pixelify_Sans } from 'next/font/google'

// Made for legibility (the Braille Institute's): keys and hashes have to be read and compared by eye. Titles are set
// in a pixel face, after the Wedgie's screen and Knock's icon, as in the docs.
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
export const pixel = Pixelify_Sans({
  subsets: ['latin'],
  variable: '--pixel',
  display: 'swap',
  fallback: ['ui-monospace', 'monospace'],
  adjustFontFallback: false,
})
