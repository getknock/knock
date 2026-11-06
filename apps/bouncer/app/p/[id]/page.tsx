import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { petition, signed, startedBy, voices } from '../../../lib/club'
import { goalOf } from '../../../lib/intent'
import { db, me } from '../../../lib/server'
import { Progress, Stamp, When, humans } from '../../parts'
import { preview } from '../../preview'
import { WORLDSCAN } from '../../wallet'
import { Close, Sign } from './Sign'

export const dynamic = 'force-dynamic'

const idOf = async (params: Promise<{ id: string }>) => {
  const id = Number((await params).id)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const id = await idOf(params)
  const p = id ? await petition(await db(), id, Date.now()) : null
  if (!p) return { title: 'No such petition' }
  const n = p.count === 1 ? '1 has' : `${p.count} have`
  return { title: p.title, ...preview(p.title, `To ${p.target}. A petition only humans can sign: ${n} so far.`) }
}

export default async function PetitionPage({ params }: { params: Promise<{ id: string }> }) {
  const id = await idOf(params)
  if (!id) notFound()
  const d = await db()
  const p = await petition(d, id, Date.now())
  if (!p) notFound()
  const [{ said, quiet }, who] = await Promise.all([voices(d, id), me()])
  const [theirs, hasSigned] = who ? await Promise.all([startedBy(d, id, who.nullifier), signed(d, id, who.nullifier)]) : [false, false]

  return (
    <main className="page">
      <article className={`paper petition ${p.status}`}>
        <p className="to">To {p.target}</p>
        <h1>{p.title}</h1>
        <p className="by">
          Started by {p.starterName ?? 'a human'}, <When at={p.at} />
        </p>
        <div className="body">{p.body}</div>
        <Stamp status={p.status} />
      </article>

      <aside className="panel" aria-label="Signatures">
        <Progress count={p.count} />
        <p className="count">
          <strong>{humans(p.count)}</strong> signed
          {p.status === 'open' ? <span className="goal"> of {goalOf(p.count).toLocaleString('en')}</span> : null}
        </p>
        {p.status !== 'open' && p.statusAt ? (
          <p className="closed-note">
            {p.status === 'won' ? 'Its starter marked it won' : 'Its starter closed it'} on <When at={p.statusAt} />.
          </p>
        ) : hasSigned ? (
          <p className="done-note">You've signed this petition.</p>
        ) : (
          <Sign petition={id} />
        )}
        {theirs && p.status === 'open' ? <Close petition={id} /> : null}
      </aside>

      <section className="sigs" aria-labelledby="sigs">
        <h2 id="sigs">Signatures</h2>
        <p className="board-note">Each one is a knock or a World ID proof the club checked.</p>
        <ol>
          {said.map((s, i) => (
            <li key={`${s.at}-${i}`}>
              <p className="who">
                <strong>{s.name ?? 'A human'}</strong> <When at={s.at} />
              </p>
              {s.reason ? <p className="reason">{s.reason}</p> : null}
              {s.bindingTx ? (
                <p className="proof">
                  Knock {s.counter?.toLocaleString('en')} of this Wedgie, bound to its human in{' '}
                  <a href={`${WORLDSCAN}/tx/${s.bindingTx}`}>this World Chain transaction</a>
                </p>
              ) : null}
            </li>
          ))}
          {quiet > 0 ? (
            <li className="quiet">
              {said.length ? 'And ' : ''}
              {humans(quiet)} signed without a name or a word.
            </li>
          ) : null}
        </ol>
      </section>
    </main>
  )
}
