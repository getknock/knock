import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { mono, pixel, sans } from './fonts'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'Knock', template: '%s | Knock' },
  description: "Prove you're a human with one press of a button on a device you own.",
  icons: { icon: '/favicon.png' },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${pixel.variable}`}>
      <body>{children}</body>
    </html>
  )
}
