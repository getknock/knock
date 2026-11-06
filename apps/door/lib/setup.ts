/**
 * Where a Wedgie's setup stands, for the Console's four steps (D21, D22): connected, its name chosen, bound for
 * that name, named in ENS. A binding World Chain has for the chosen name makes binding done, so the Console never
 * offers to bind a Wedgie that's bound already; one for another name is said before binding again. A Wedgie that
 * says it's set up, but whose name ENS no longer has for it (killed or revoked while it was away), is stale: the
 * last step is open again, to have it forget the name.
 */
import { deviceNode } from '@knock-dev/protocol'
import type { BindingOnChain } from './knockd'

export type StepState = 'done' | 'now' | 'later'

/** The Wedgie's latest binding in the environment, as World Chain has it: none, one (with the name it was made for,
 *  when it's known: the chain keeps only its node), or not known yet. */
export type Known =
  | { state: 'checking' }
  | { state: 'none' }
  | { state: 'bound'; on: BindingOnChain; name: string | null }
  | { state: 'unknown'; why: string }

/** A name's node, or null for what isn't a name */
export function nodeOf(name: string): string | null {
  try {
    return deviceNode(name).toLowerCase()
  } catch {
    return null
  }
}

export type Setup = {
  /** Named, bound and live: it says so itself */
  set: boolean
  /** Set, says the Wedgie, but ENS has its name revoked, or not for it at all */
  stale: 'revoked' | 'gone' | null
  /** The binding that counts: none if the kill switch took it away here (D20) */
  live: Known
  /** The name the binding is for, when it's one of the names known here */
  boundFor: string | null
  /** The kill switch took this Wedgie's latest binding away, here */
  killed: boolean
  steps: [StepState, StepState, StepState, StepState]
}

export function setup(s: {
  device: { name: string | null; status: string | null; nullifier: string | null } | null
  /** The name typed now, and whether it's one a Wedgie can have */
  name: string
  nameOk: boolean
  /** The name step's choice */
  chosen: string | null
  known: Known
  /** The name this browser bound the Wedgie for */
  remembered: string | null
  /** The binding the kill switch took away here */
  killedTx: string | null
  /** What ENS has on the name a set-up Wedgie shows, once read */
  inEns?: 'live' | 'revoked' | 'gone' | null
}): Setup {
  const d = s.device
  const set = Boolean(d?.name && d.status === 'active' && d.nullifier)
  const stale = set && (s.inEns === 'revoked' || s.inEns === 'gone') ? s.inEns : null
  const killed = s.known.state === 'bound' && s.killedTx !== null && s.killedTx.toLowerCase() === s.known.on.tx.toLowerCase()
  const live: Known = killed ? { state: 'none' } : s.known
  const boundFor =
    live.state !== 'bound'
      ? null
      : (live.name ??
        [d?.name ?? null, s.remembered, s.chosen, s.nameOk ? s.name : null].find(
          (n): n is string => typeof n === 'string' && nodeOf(n) === live.on.bound.node.toLowerCase(),
        ) ??
        null)
  const nameDone = set || (s.chosen !== null && s.chosen === s.name && s.nameOk)
  const bindDone = set || (nameDone && boundFor === s.name)
  return {
    set,
    stale,
    live,
    boundFor,
    killed,
    steps: [
      d ? 'done' : 'now',
      !d ? 'later' : nameDone ? 'done' : 'now',
      !nameDone ? 'later' : bindDone ? 'done' : 'now',
      stale ? 'now' : set ? 'done' : bindDone ? 'now' : 'later',
    ],
  }
}
