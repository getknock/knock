/**
 * The Console's memory of each Wedgie's latest binding, by its key and environment: its transaction and the name
 * it was made for (D22). knockd can't search World Chain's logs for one (its RPC answers eth_getLogs 100 blocks at a
 * time), so the transaction is kept here, and knockd reads it back from the chain before a name points at it.
 */
import type { Hex } from 'viem'
import type { Environment } from './deployments'

export type Remembered = { tx: Hex; name: string }

const slot = (key: Hex, env: Environment) => `knock.binding.${env}.${key.toLowerCase()}`

export function remember(key: Hex, env: Environment, b: Remembered) {
  localStorage.setItem(slot(key, env), JSON.stringify(b))
}

/** The binding, or nothing: a v1 one (a bare transaction, made for no name) counts as nothing. */
export function recall(key: Hex, env: Environment): Remembered | null {
  try {
    const b = JSON.parse(localStorage.getItem(slot(key, env)) ?? 'null')
    return b && /^0x[0-9a-f]{64}$/i.test(b.tx) && typeof b.name === 'string' ? { tx: b.tx, name: b.name } : null
  } catch {
    return null
  }
}

/** The kill switch: the Console stops offering a binding the Wedgie forgot. Naming it again takes a new one. */
export function forget(key: Hex, env: Environment) {
  localStorage.removeItem(slot(key, env))
}
