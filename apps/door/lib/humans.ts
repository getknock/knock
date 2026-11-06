/**
 * The Console's memory of the human using it, by environment: their nullifier and Knock session (D24). With it, a
 * Wedgie is bound by a session proof, the same human as before, which World App gives as often as asked. Without
 * it, the next binding is the human's first, a uniqueness proof, which World App gives once. The kill switch
 * leaves it: a human whose Wedgie's name was killed binds again as themselves.
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
