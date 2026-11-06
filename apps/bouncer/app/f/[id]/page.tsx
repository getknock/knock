import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fundraiser, giftsTo, raisedBy } from '../../../lib/club'
import { eth } from '../../../lib/intent'
import { db, me } from '../../../lib/server'
import { Address, Raised, Stamp, When, humans } from '../../parts'
import { ETHERSCAN } from '../../wallet'
import { Give, Stop } from './Give'

export const dynamic = 'force-dynamic'

const idOf = async (params: Promise<{ id: string }>) => {
  const id = Number((await params).id)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const id = await idOf(params)
  const f = id ? await fundraiser(await db(), id, Date.now()) : null
  return { title: f ? f.title : 'No such fundraiser' }
}

export default async function FundraiserPage({ params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params)
  if (!id) notFound()
  const d = await db()
  const f = await fundraiser(d, id, Date.now())
  if (!f) notFound()
  const [gifts, who] = await Promise.all([giftsTo(d, id), me()])
  const theirs = who ? await raisedBy(d, id, who.nullifier) : false

  return (
    <main className="page">
      <article className={`paper fund ${f.status}`}>
        <p className="to">
          For {f.name}, at <Address a={f.payout} />
        </p>
        <h1>{f.title}</h1>
        <p className="by">
          Started <When at={f.at} />
        </p>
        <div className="body">{f.story}</div>
        <Stamp status={f.status} />
      </article>

      <aside className="panel" aria-label="Gifts">
        <Raised raised={f.raised} goal={f.goal} />
        <p className="count">
          <strong>{eth(f.raised)} ETH</strong> of {eth(f.goal)}
          {f.humans > 0 ? <span className="recent">, from {humans(f.humans)} and their wallets</span> : null}
        </p>
        {f.status === 'open' ? (
          <Give fundraiser={id} name={f.name} inSession={who !== null} />
        ) : (
          <p className="closed-note">
            Its starter closed it to new gifts{f.statusAt ? ' on ' : ''}
            {f.statusAt ? <When at={f.statusAt} /> : null}.
          </p>
        )}
        {theirs && f.status === 'open' ? <Stop fundraiser={id} /> : null}
      </aside>

      <section className="sigs" aria-labelledby="gifts">
        <h2 id="gifts">Gifts</h2>
        {gifts.length ? (
          <ol>
            {gifts.map((g, i) => (
              <li key={`${g.at}-${i}`}>
                <p className="who">
                  <strong>{eth(g.value)} ETH</strong>
                  {g.from ? (
                    <>
                      {' '}
                      from <Address a={g.from} />
                    </>
                  ) : null}{' '}
                  <When at={g.at} />
                </p>
                {g.message ? <p className="reason">{g.message}</p> : null}
                <p className="proof">
                  {g.human ? 'Given by a human in the club. ' : ''}
                  {g.tx ? <a href={`${ETHERSCAN}/tx/${g.tx}`}>Its transaction</a> : null}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="board-note">No gifts yet.</p>
        )}
      </section>
    </main>
  )
}
