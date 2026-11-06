import type { Metadata } from 'next'
import { StartFundraiser, StartPetition } from './Start'

export const metadata: Metadata = { title: 'Start' }

export default async function Start({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const fund = (await searchParams).kind === 'fundraiser'
  return (
    <main className="page narrow">
      <div className="paper">
        <h1>{fund ? 'Start a fundraiser' : 'Start a petition'}</h1>
        <nav className="kinds" aria-label="What to start">
          <a href="/start" aria-current={fund ? undefined : 'page'}>
            A petition
          </a>
          <a href="/start?kind=fundraiser" aria-current={fund ? 'page' : undefined}>
            A fundraiser
          </a>
        </nav>
        {fund ? <StartFundraiser /> : <StartPetition />}
      </div>
    </main>
  )
}
