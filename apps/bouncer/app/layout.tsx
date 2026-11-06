import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { sign, text } from './fonts'
import './globals.css'

export const metadata: Metadata = {
  title: 'The Human Club',
  description: 'Humans only, one entry each: knock with your Wedgie.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sign.variable} ${text.variable}`}>
      <body>{children}</body>
    </html>
  )
}
