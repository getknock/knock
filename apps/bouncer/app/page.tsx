import { fundraisers, petitions, totals } from '../lib/club'
import { eth } from '../lib/intent'
import { db } from '../lib/server'
import { FundNotice, Notice, humans } from './parts'

export const dynamic = 'force-dynamic'

export default async function Home({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  const order = (await searchParams).sort === 'new' ? 'new' : 'trending'
  const d = await db()
  const now = Date.now()
  const [list, funds, t] = await Promise.all([petitions(d, now, order), fundraisers(d, now, 'trending', 3), totals(d)])
  return (
    <main className="home">
      <section className="hero" aria-labelledby="club">
        <h1 id="club">The Human Club</h1>
        <p className="lede">
          Petitions only humans can sign, and fundraisers only humans can start. Each human signs once, with one press
          on their Wedgie, and the club learns nothing about them but its name.
        </p>
        {t.signatures > 0 ? (
          <p className="tally">
            {t.signatures.toLocaleString('en')} {t.signatures === 1 ? 'signature' : 'signatures'} from {humans(t.humans)}
            {t.won > 0 ? `, ${t.won.toLocaleString('en')} ${t.won === 1 ? 'petition' : 'petitions'} won` : ''}
            {BigInt(t.raised) > 0n ? `, and ${eth(t.raised)} ETH given` : ''}.
          </p>
        ) : null}
        <p className="ctas">
          <a className="knocker" href="/start">
            Start a petition
          </a>
          <a className="plain" href="/start?kind=fundraiser">
            Start a fundraiser
          </a>
        </p>
      </section>

      <section className="board" aria-labelledby="board">
        <div className="board-head">
          <h2 id="board">Petitions</h2>
          <nav aria-label="Order">
            <a href="/" aria-current={order === 'trending' ? 'page' : undefined}>
              Signed most this week
            </a>
            <a href="/?sort=new" aria-current={order === 'new' ? 'page' : undefined}>
              Newest
            </a>
          </nav>
        </div>
        {list.length ? (
          <ol className="notices">
            {list.map((p) => (
              <Notice key={p.id} p={p} />
            ))}
          </ol>
        ) : (
          <div className="empty">
            <p>No petitions yet.</p>
            <p>
              Start the first: a title, who it's to, what it asks, and one press on your Wedgie. It goes up with your
              signature on it.
            </p>
          </div>
        )}
      </section>

      {funds.length ? (
        <section className="board" aria-labelledby="funds">
          <div className="board-head">
            <h2 id="funds">Fundraisers</h2>
            <nav aria-label="More">
              <a href="/fundraisers">All fundraisers</a>
            </nav>
          </div>
          <ol className="notices">
            {funds.map((f) => (
              <FundNotice key={f.id} f={f} />
            ))}
          </ol>
        </section>
      ) : null}

      <section className="how" aria-labelledby="how">
        <h2 id="how">Why a signature here counts</h2>
        <div className="points">
          <div>
            <h3>Only humans sign</h3>
            <p>
              A signature is a press on a Wedgie that one human bound to themselves with World ID. A bot has no
              Wedgie, and a human with three Wedgies still signs once.
            </p>
          </div>
          <div>
            <h3>Nobody's real name</h3>
            <p>
              The club asks for no email, name or password. It sees your Wedgie's ENS name, and shows it on a
              signature only if you say so.
            </p>
          </div>
          <div>
            <h3>Gifts go straight to them</h3>
            <p>
              A fundraiser's gifts go from your wallet to the wallet its starter's ENS name resolves to. The club
              never holds any ETH.
            </p>
          </div>
        </div>
      </section>
    </main>
  )
}
