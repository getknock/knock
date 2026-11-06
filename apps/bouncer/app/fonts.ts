import { Big_Shoulders, Instrument_Sans } from 'next/font/google'

// The club's sign is Chicago signage, tall and condensed; the list is a plain grotesk, set to be read at the door.
export const sign = Big_Shoulders({
  subsets: ['latin'],
  variable: '--sign',
  display: 'swap',
  weight: ['700', '900'],
  fallback: ['Impact', 'Arial Narrow', 'sans-serif'],
  adjustFontFallback: false,
})
export const text = Instrument_Sans({ subsets: ['latin'], variable: '--text', display: 'swap' })
