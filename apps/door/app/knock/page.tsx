import type { Metadata } from 'next'
import { Door } from './Door'

export const metadata: Metadata = { title: 'Knock' }

export default function DoorPage() {
  return <Door />
}
