import type { Metadata } from 'next'
import { Console } from './console/Console'

// getknock.dev: the Console is the site
export const metadata: Metadata = {
  title: { absolute: 'Knock: set up your Wedgie' },
}

export default function Home() {
  return <Console />
}
