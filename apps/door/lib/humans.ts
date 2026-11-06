/**
 * The human who bound in this browser, by environment: their nullifier and Knock session (D24). One of the ways the
 * Console finds whose session binds next, after the connected Wedgie's own last human; KnockBinding keeps that and
 * each name's, so another browser finds them too. The kill switch leaves it.
 */
import type { Hex } from 'viem'
import type { Environment } from './deployments'
import type { Human } from './knockd'

const slot = (env: Environment) => `knock.human.${env}`

export function rememberHuman(env: Environment, h: Human) {
  localStorage.setItem(slot(env), JSON.stringify(h))
}

export function recallHuman(env: Environment): Human | null {
  try {
    const h = JSON.parse(localStorage.getItem(slot(env)) ?? 'null')
    return h && /^0x[0-9a-f]{64}$/i.test(h.nullifier) && /^session_[0-9a-f]{128}$/i.test(h.session)
      ? { nullifier: h.nullifier as Hex, session: h.session }
      : null
  } catch {
    return null
  }
}

/** Not this human: the next binding here is a first one. */
export function forgetHuman(env: Environment) {
  localStorage.removeItem(slot(env))
}
