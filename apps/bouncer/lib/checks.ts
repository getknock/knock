/**
 * The bouncer's list: the verifier's checks, V1–V8 in its order (PLAN §3), said for the people at the door. The
 * verifier answers with the first check that said no, so every check before it passed and none after it ran. Check
 * 7, a fresh World ID proof, isn't asked here; check 8, once per human, is asked of signing, and of starting a
 * petition or a fundraiser, once a day. The World ID way in (D35) has its own list, numbered as the club answers
 * it: 1 to 5, then 8.
 */
import type { Done } from './club'
import type { Intent } from './intent'

const FIRST_SEVEN = [
  'A knock, made right',
  'For this club, just now',
  'Its name is in ENS, and switched on',
  'Its Wedgie signed it, after a press',
  'Not a knock seen before',
  "One real human's, bound on World Chain",
  'A fresh World ID proof (not asked here)',
] as const

const WORLD_FIRST = [
  'A World ID proof, made right',
  'For this club, just now',
  'A human Knock knows, or one it binds now',
  'Proved on World Chain',
  'Not a proof used before',
] as const

/** The way in a list is for: a knock, or World ID and a wallet */
export type Door = 'knock' | 'world'

/** Each check's number, down the list */
export const numbers = (door: Door) => (door === 'world' ? [1, 2, 3, 4, 5, 8] : [1, 2, 3, 4, 5, 6, 7, 8])

const asksOnce = (act: Intent['act']) => act === 'sign' || act === 'start' || act === 'raise'

export function checksFor(act: Intent['act'], door: Door = 'knock'): string[] {
  const eighth =
    act === 'sign'
      ? 'Their first signature on this petition'
      : act === 'start'
        ? 'Their first new petition today'
        : act === 'raise'
          ? 'Their first new fundraiser today'
          : 'Once per human (not asked here)'
  return [...(door === 'world' ? WORLD_FIRST : FIRST_SEVEN), eighth]
}

/** What came of a knock at the club, or a World ID proof */
export type Answer =
  | { kind: 'in'; name: string; done: Done }
  /** Every check passed, and the club said no to the act: they're in, but it isn't done */
  | { kind: 'declined'; name: string; error: string; why: string }
  | { kind: 'bounced'; check: number; error: string; why: string }
  /** No knock was checked: the Door's no, or the club's before anyone pressed, or a club that couldn't be reached */
  | { kind: 'no-knock'; code: string; why: string }

export type Mark = 'pass' | 'fail' | 'skip' | 'todo'

export function marks(a: Answer | null, act: Intent['act'], door: Door = 'knock'): Mark[] {
  const at = !a ? 0 : a.kind === 'in' || a.kind === 'declined' ? 9 : a.kind === 'bounced' ? a.check : 0
  return numbers(door).map((n): Mark => {
    if (n === 7 || (n === 8 && !asksOnce(act))) return at > n ? 'skip' : 'todo'
    if (at === 0 || n > at) return 'todo'
    return n === at ? 'fail' : 'pass'
  })
}
