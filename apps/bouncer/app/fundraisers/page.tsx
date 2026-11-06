import type { Metadata } from 'next'
import { fundraisers } from '../../lib/club'
import { db } from '../../lib/server'
import { FundNotice } from '../parts'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Fundraisers' }

export default async function Fundraisers({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  const order = (await searchParams).sort === 'new' ? 'new' : 'trending'
  const list = await fundraisers(await db(), Date.now(), order)
  return (
    <main className="home">
      <section className="board" aria-labelledby="funds">
        <div className="board-head">
          <h1 id="funds">Fundraisers</h1>
          <nav aria-label="Order">
            <a href="/fundraisers" aria-current={order === 'trending' ? 'page' : undefined}>
              Given most this week
            </a>
            <a href="/fundraisers?sort=new" aria-current={order === 'new' ? 'page' : undefined}>
              Newest
            </a>
          </nav>
        </div>
        <p className="board-note">
          Each is started by one human, and named for their Wedgie: its gifts go to the wallet that name resolves to.
        </p>
        {list.length ? (
          <ol className="notices">
            {list.map((f) => (
              <FundNotice key={f.id} f={f} />
            ))}
          </ol>
        ) : (
          <div className="empty">
            <p>No fundraisers yet.</p>
            <p>
              <a href="/start?kind=fundraiser">Start the first</a>: what it's for, a goal in ETH, and one press on your
              Wedgie.
            </p>
          </div>
        )}
      </section>
    </main>
  )
}
