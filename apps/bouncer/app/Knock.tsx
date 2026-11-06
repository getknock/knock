'use client'
import { type Assertion, KnockError, knock } from '@knock-dev/door-sdk'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { type Answer, type Mark, checksFor, marks } from '../lib/checks'
import type { Intent } from '../lib/intent'

type Phase = 'idle' | 'knocking' | 'checking' | 'done'

/** NEXT_PUBLIC_DOOR, or in development the Console's dev server; otherwise Knock's, door-sdk's own default */
const DOOR = process.env.NEXT_PUBLIC_DOOR ?? (process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : undefined)

/** A challenge for the act, from the club's server, which holds the act for the knock that answers it */
async function challengeFor(intent: Intent): Promise<`0x${string}`> {
  const r = await fetch('/api/knock/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent }),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok || !j?.ok) throw new Error(j?.why ?? `The club said ${r.status}.`)
  return j.challenge
}

async function submit(assertion: Assertion): Promise<Answer> {
  const r = await fetch('/api/knock', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion }),
  })
  const j = await r.json().catch(() => null)
  if (typeof j?.ok !== 'boolean') return { kind: 'no-knock', code: 'club', why: `The club said ${r.status}.` }
  if (j.ok) return { kind: 'in', name: j.name, done: j.done }
  if (j.passed) return { kind: 'declined', name: j.name, error: j.error, why: j.why }
  if (j.check >= 1) return { kind: 'bounced', check: j.check, error: j.error, why: j.why }
  return { kind: 'no-knock', code: j.error, why: j.why }
}

/** A knock for one act: the Door opens from the click, the club's server checks it, and the page reloads its data */
export function useKnock() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [act, setAct] = useState<Intent['act']>('in')
  const router = useRouter()

  function run(intent: Intent, then?: (a: Answer) => void) {
    setAnswer(null)
    setAct(intent.act)
    setPhase('knocking')
    // The club's own no, before anyone presses, in its words rather than door-sdk's
    let refused: string | null = null
    const challenge = challengeFor(intent).catch((e: Error) => {
      refused = e.message
      throw e
    })
    knock({ challenge, door: DOOR })
      .then((a) => {
        setPhase('checking')
        return submit(a)
      })
      .then((a) => {
        setAnswer(a)
        then?.(a)
        router.refresh()
      })
      .catch((e) => {
        const code = e instanceof KnockError ? e.code : 'club'
        setAnswer({ kind: 'no-knock', code, why: code === 'challenge' && refused ? refused : e instanceof Error ? e.message : String(e) })
      })
      .finally(() => setPhase('done'))
  }

  return { phase, answer, act, run, busy: phase === 'knocking' || phase === 'checking' }
}

const SAID: Record<Mark, string> = { pass: 'passed', fail: 'failed', skip: 'not asked', todo: 'not checked' }

/** The bouncer's list for the last knock, ticked as the verifier answered */
export function Bouncer({ answer, act, round }: { answer: Answer | null; act: Intent['act']; round?: number }) {
  const list = marks(answer, act)
  return (
    <ol className="checks" key={round}>
      {checksFor(act).map((what, i) => (
        <li key={what} className={list[i]} style={{ '--i': i } as React.CSSProperties}>
          <span className="mark" aria-hidden="true" />
          <span>{what}</span>
          <span className="sr">, {SAID[list[i]]}</span>
        </li>
      ))}
    </ol>
  )
}

/** What a knock came to, in a line: quiet for the Door's own closes and noes */
export function Said({ answer }: { answer: Answer | null }) {
  if (!answer || answer.kind === 'in') return null
  if (answer.kind === 'no-knock' && (answer.code === 'closed' || answer.code === 'rejected')) return null
  return (
    <p className={answer.kind === 'bounced' ? 'said out' : 'said'} role="status">
      {answer.kind === 'bounced' ? <strong>Bounced at check {answer.check}: </strong> : null}
      {answer.why}
    </p>
  )
}

/** Status words for the button while it knocks */
export const waiting = (phase: Phase) =>
  phase === 'knocking' ? 'Waiting for your Wedgie…' : phase === 'checking' ? 'The bouncer is checking…' : null

/** Knocking needs Web Serial: desktop Chrome, Edge or another Chromium */
export const canKnock = () => typeof navigator !== 'undefined' && 'serial' in navigator
