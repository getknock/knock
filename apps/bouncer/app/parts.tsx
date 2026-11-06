import type { Fundraiser, Petition } from '../lib/club'
import { eth, goalOf } from '../lib/intent'

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

export function When({ at }: { at: number }) {
  return <time dateTime={new Date(at).toISOString()}>{DAY.format(at)}</time>
}

export const humans = (n: number) => `${n.toLocaleString('en')} ${n === 1 ? 'human' : 'humans'}`

/** How far along: a share of 100, at least a sliver so a start shows */
const share = (part: number, whole: number) => Math.max(2, Math.min(100, (part / whole) * 100))

/** Signatures against the next milestone */
export function Progress({ count }: { count: number }) {
  const goal = goalOf(count)
  return (
    <div className="progress" role="img" aria-label={`${count} of ${goal} signatures`}>
      <span style={{ width: `${share(count, goal)}%` }} />
    </div>
  )
}

/** ETH given against the goal */
export function Raised({ raised, goal }: { raised: string; goal: string }) {
  const r = Number(BigInt(raised) / 1_000_000_000n)
  const g = Number(BigInt(goal) / 1_000_000_000n)
  return (
    <div className="progress" role="img" aria-label={`${eth(raised)} of ${eth(goal)} ETH`}>
      <span style={{ width: `${share(r, g)}%` }} />
    </div>
  )
}

/** Won or closed, stamped across it */
export function Stamp({ status }: { status: Petition['status'] }) {
  if (status === 'open') return null
  return <p className={`stamp ${status}`}>{status === 'won' ? 'Won' : 'Closed'}</p>
}

/** An address, shortened, as a link to it on Etherscan */
export function Address({ a }: { a: string }) {
  return (
    <a className="hex" href={`https://etherscan.io/address/${a}`} title={a}>
      {a.slice(0, 6)}…{a.slice(-4)}
    </a>
  )
}

/** A petition on the board */
export function Notice({ p }: { p: Petition }) {
  return (
    <li className={`notice ${p.status}`}>
      <a href={`/p/${p.id}`}>
        <p className="to">To {p.target}</p>
        <h3>{p.title}</h3>
        <Progress count={p.count} />
        <p className="count">
          <strong>{humans(p.count)}</strong> signed
          {p.status === 'open' ? <span className="goal"> of {goalOf(p.count).toLocaleString('en')}</span> : null}
          {p.recent > 0 && p.status === 'open' ? <span className="recent">, {p.recent.toLocaleString('en')} this week</span> : null}
        </p>
        <p className="by">
          Started by {p.starterName ?? 'a human'}, <When at={p.at} />
        </p>
      </a>
      <Stamp status={p.status} />
    </li>
  )
}

/** A fundraiser on the board */
export function FundNotice({ f }: { f: Fundraiser }) {
  return (
    <li className={`notice fund ${f.status}`}>
      <a href={`/f/${f.id}`}>
        <p className="to">For {f.name}</p>
        <h3>{f.title}</h3>
        <Raised raised={f.raised} goal={f.goal} />
        <p className="count">
          <strong>{eth(f.raised)} ETH</strong> of {eth(f.goal)}
          {f.gifts > 0 ? <span className="recent">, {f.gifts === 1 ? '1 gift' : `${f.gifts.toLocaleString('en')} gifts`}</span> : null}
        </p>
        <p className="by">
          Started <When at={f.at} />
        </p>
      </a>
      <Stamp status={f.status} />
    </li>
  )
}
