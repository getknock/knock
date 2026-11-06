/**
 * The Console's memory of each Wedgie's latest binding, by its key and environment: its transaction and the name
 * it was made for (D22). World Chain has the binding too, and knockd finds it by the key (/binding); this is the
 * name it was for, which the chain holds only as a hash, and an answer while knockd can't be asked. knockd reads
 * the binding back from the chain before a name points at it.
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

const killedSlot = (key: Hex, env: Environment) => `knock.killed.${env}.${key.toLowerCase()}`

/** The kill switch (D20): the Console stops offering the binding the Wedgie forgot, from here or as World Chain's
 *  latest for it. Naming it again takes a new one. */
export function forget(key: Hex, env: Environment, killed: Hex | null) {
  localStorage.removeItem(slot(key, env))
  if (killed) localStorage.setItem(killedSlot(key, env), killed.toLowerCase())
}

/** The binding the kill switch took away from this Wedgie, if it did here. */
export function killedTx(key: Hex, env: Environment): Hex | null {
  try {
    const tx = localStorage.getItem(killedSlot(key, env))
    return tx && /^0x[0-9a-f]{64}$/.test(tx) ? (tx as Hex) : null
  } catch {
    return null
  }
}
