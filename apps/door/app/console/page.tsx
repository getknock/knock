import type { Metadata } from 'next'
import { Console } from './Console'

export const metadata: Metadata = { title: 'Knock Console' }

export default function ConsolePage() {
  return <Console />
}
