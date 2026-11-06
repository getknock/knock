import type { Message } from './wedgie'

/** A refusal along the way, said for people: the Wedgie's, World ID's, knockd's, ENS's or the wallet's. */
export class Stopped extends Error {}

/** A Wedgie's no to a request, said for people. */
export function refused(m: Message, what: string): never {
  const why = typeof m.why === 'string' ? `: ${m.why}` : ''
  if (m.error === 'rejected') throw new Stopped(`Red on the Wedgie: no ${what}.`)
  if (m.error === 'timeout') throw new Stopped(`Nobody pressed on the Wedgie: no ${what}.`)
  throw new Stopped(`The Wedgie said ${String(m.error ?? m.type)}${why}`)
}
