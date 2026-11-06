'use client'
import { KnockError, knock } from '@knock-dev/door-sdk'
import { useState } from 'react'
import { CHECKS, type Mark, type Outcome, challenge, marks, outcome, verify } from '../lib/checks'

type Phase = 'idle' | 'knocking' | 'checking' | 'done'

const SAID: Record<Mark, string> = { pass: 'passed', fail: 'failed', skip: 'not asked', todo: 'not checked' }
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`

/** The Human Club's door: one knock, then the bouncer's list, ticked as the verifier answered. */
export function Club() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<Outcome | null>(null)
  const [round, setRound] = useState(0)

  function enter() {
    setResult(null)
    setPhase('knocking')
    setRound((r) => r + 1)
    // From the click itself: the Door is a popup, and the challenge is fetched while it opens
    knock({ challenge: challenge() })
      .then((a) => {
        setPhase('checking')
        return verify(a)
      })
      .then((v) => setResult(outcome(v)))
      .catch((e) =>
        setResult({
          kind: 'no-knock',
          code: e instanceof KnockError ? e.code : 'verifier',
          why: e instanceof Error ? e.message : String(e),
        }),
      )
      .finally(() => setPhase('done'))
  }

  const list = result ? marks(result) : CHECKS.map((): Mark => 'todo')
  const busy = phase === 'knocking' || phase === 'checking'
  return (
    <main className="club">
      <header className="sign">
        <h1>The Human Club</h1>
        <p>Humans only, one entry each.</p>
      </header>

      <section className="list" aria-labelledby="list-title">
        <p className="how">
          Knock with your Wedgie: the Knock Door opens, you press green, and the bouncer checks the knock against ENS
          and World Chain. No account, no form, nothing to type.
        </p>

        <button type="button" className="knock" onClick={enter} disabled={busy}>
          {phase === 'knocking' ? 'Waiting for your Wedgie…' : phase === 'checking' ? 'The bouncer is checking…' : 'Knock'}
        </button>

        <h2 id="list-title">The bouncer checks</h2>
        <ol className="checks" key={round}>
          {CHECKS.map((what, i) => (
            <li key={what} className={list[i]} style={{ '--i': i } as React.CSSProperties}>
              <span className="mark" aria-hidden="true" />
              <span>{what}</span>
              <span className="sr">, {SAID[list[i]]}</span>
            </li>
          ))}
        </ol>

        {result?.kind === 'in' ? (
          <div className="verdict" role="status" key={`in-${round}`}>
            <p className="stamp in">In</p>
            <p>
              <strong>{result.knock.name}</strong> is in: one human, bound on World Chain in block{' '}
              <a href={`https://worldscan.org/tx/${result.knock.binding.tx}`} target="_blank" rel="noreferrer">
                {result.knock.binding.block.toLocaleString()}
              </a>
              , knock {result.knock.counter} of its Wedgie. Human <span className="hex">{short(result.knock.nullifier)}</span>{' '}
              can't come in again.
            </p>
          </div>
        ) : null}
        {result?.kind === 'bounced' ? (
          <div className="verdict" role="status" key={`out-${round}`}>
            <p className="stamp out">Bounced</p>
            <p>
              Check {result.check} said no: {result.why}.
            </p>
          </div>
        ) : null}
        {result?.kind === 'no-knock' ? (
          <p className="nothing" role="status">
            No knock: {result.why}
          </p>
        ) : null}
      </section>

      <footer className="small">
        A demo site for Knock. Its verifier is its own: it reads ENS on Ethereum and bindings on World Chain, and keeps
        no accounts.
      </footer>
    </main>
  )
}
