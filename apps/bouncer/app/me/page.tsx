import type { Metadata } from 'next'
import { mine, mineFunds } from '../../lib/club'
import { eth } from '../../lib/intent'
import { db, me } from '../../lib/server'
import { FundNotice, Notice, When } from '../parts'
import { KnockIn } from '../Session'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Yours' }

export default async function Me() {
  const who = await me()
  if (!who)
    return (
      <main className="page narrow">
        <div className="paper">
          <h1>Yours</h1>
          <p>Come in to see what you've started, signed and given here.</p>
          <KnockIn />
        </div>
      </main>
    )
  const d = await db()
  const now = Date.now()
  const [p, f] = await Promise.all([mine(d, who.nullifier, now), mineFunds(d, who.nullifier, now)])
  return (
    <main className="home">
      <section className="hero small" aria-labelledby="me">
        <h1 id="me">{who.name}</h1>
        <p className="lede">
          In the club since <When at={who.firstAt} />, through the door {who.knocks.toLocaleString('en')}{' '}
          {who.knocks === 1 ? 'time' : 'times'}. Whichever of your Wedgies knocks, or World App proves you, the club
          counts the same human.
        </p>
      </section>

      <Board title="Petitions you started" empty="None yet." href="/start" more="Start one">
        {p.started.map((x) => (
          <Notice key={x.id} p={x} />
        ))}
      </Board>
      <Board title="Petitions you signed" empty="None yet." href="/" more="See the petitions">
        {p.signed.map((x) => (
          <Notice key={x.id} p={x} />
        ))}
      </Board>
      <Board title="Fundraisers you started" empty="None yet." href="/start?kind=fundraiser" more="Start one">
        {f.started.map((x) => (
          <FundNotice key={x.id} f={x} />
        ))}
      </Board>
      {f.gave.length ? (
        <section className="sigs" aria-labelledby="gave">
          <h2 id="gave">What you gave in the club</h2>
          <ol>
            {f.gave.map((g, i) => (
              <li key={`${g.at}-${i}`}>
                <p className="who">
                  <strong>{eth(g.value)} ETH</strong> to <a href={`/f/${g.id}`}>{g.title}</a> <When at={g.at} />
                </p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </main>
  )
}

function Board({ title, empty, href, more, children }: { title: string; empty: string; href: string; more: string; children: React.ReactNode[] }) {
  return (
    <section className="board">
      <div className="board-head">
        <h2>{title}</h2>
        <nav aria-label={title}>
          <a href={href}>{more}</a>
        </nav>
      </div>
      {children.length ? <ol className="notices">{children}</ol> : <p className="board-note">{empty}</p>}
    </section>
  )
}
