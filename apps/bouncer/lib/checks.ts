/**
 * The bouncer's list: the verifier's checks, V1–V8 in its order (PLAN §3), said for the people at the door. The
 * verifier answers with the first check that said no, so every check before it passed and none after it ran.
 */
import type { Assertion } from '@knock-dev/door-sdk'

export const CHECKS = [
  'A knock, made right',
  'For this door, just now',
  'Its name is in ENS, and switched on',
  'Its Wedgie signed it, after a press',
  'Not a knock seen before',
  "One real human's, bound on World Chain",
  'A fresh World ID proof (not asked here)',
  'Their first time in',
] as const

/** Fresh mode: this door doesn't ask for it, so it's never checked. */
const NOT_ASKED = 7

export type Knocked = {
  name: string
  key: string
  nullifier: string
  counter: number
  origin: string
  binding: { tx: string; block: number; provedAt: number }
}

/** The verifier's answer. */
export type Verdict = { ok: true; knock: Knocked } | { ok: false; check: number; error: string; why: string }

export type Outcome =
  | { kind: 'in'; knock: Knocked }
  | { kind: 'bounced'; check: number; error: string; why: string }
  /** No knock reached the verifier: the Door's no, or a verifier that couldn't be reached. */
  | { kind: 'no-knock'; code: string; why: string }

export type Mark = 'pass' | 'fail' | 'skip' | 'todo'

export function marks(o: Outcome): Mark[] {
  const at = o.kind === 'in' ? CHECKS.length + 1 : o.kind === 'bounced' ? o.check : 0
  return CHECKS.map((_, i) => {
    const n = i + 1
    if (n === NOT_ASKED && at !== NOT_ASKED) return at > n ? 'skip' : 'todo'
    if (at === 0 || n > at) return 'todo'
    return n === at ? 'fail' : 'pass'
  })
}

export function outcome(v: Verdict): Outcome {
  return v.ok ? { kind: 'in', knock: v.knock } : { kind: 'bounced', check: v.check, error: v.error, why: v.why }
}

/** The site's verifier (server/verifier): a challenge, and a knock checked. */
export const VERIFIER = process.env.NEXT_PUBLIC_VERIFIER ?? 'http://localhost:8788'

/** The site's action for V8: one entry per human. */
export const ACTION = 'enter'

export async function challenge(at = VERIFIER): Promise<`0x${string}`> {
  const r = await fetch(`${at}/challenge`, { method: 'POST' })
  const j = await r.json()
  if (!r.ok) throw new Error(j.why ?? `the verifier said ${r.status}`)
  return j.challenge
}

export async function verify(a: Assertion, at = VERIFIER): Promise<Verdict> {
  const r = await fetch(`${at}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ assertion: a, action: ACTION }),
  })
  const j = (await r.json()) as Verdict
  if (typeof j?.ok !== 'boolean') throw new Error(`the verifier said ${r.status}`)
  return j
}
