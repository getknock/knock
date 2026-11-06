/**
 * The Door (PLAN §3): a site opens it and sends its verifier's challenge; the Wedgie knocks for that site after a
 * green press; the knock goes back to that site only. The site's origin is the browser's word for where the request
 * came from (the message's own origin), never the site's: the Wedgie shows it, labelled unverified, and signs it.
 */
import type { Assertion } from '@knock-dev/door-sdk'
import { NO_HUMAN_REF, deviceNode, digest, verifySignature } from '@knock-dev/protocol'
import type { Hex } from 'viem'
import type { Device } from './device'
import type { Message, Wedgie } from './wedgie'

export type Request = { challenge: Hex; mode: 1; origin: string }

/** A no for the site: a code it can act on (the SDK's KnockError has it), and words for people. */
export class Refusal extends Error {
  constructor(
    readonly code: string,
    why: string,
  ) {
    super(why)
  }
}

/** An origin the Wedgie takes, as it checks them: https://host[:port], or http://localhost or 127.0.0.1 with a port,
 *  for development. Lowercase host, no path, no user@. */
export function okOrigin(o: string): boolean {
  return /^(https:\/\/[a-z0-9.-]+|http:\/\/(localhost|127\.0\.0\.1))(:\d{1,5})?$/.test(o)
}

type Incoming = { source: unknown; origin: string; data: unknown }

/** What a message to the Door is: nothing (not from the window that opened the Door, or no request), a request, or
 *  a request the Door can only say no to. */
export function readRequest(
  e: Incoming,
  opener: unknown,
): null | { ok: true; request: Request } | { ok: false; refusal: Refusal } {
  if (!opener || e.source !== opener) return null
  const m = e.data as { type?: unknown; challenge?: unknown; mode?: unknown } | null
  if (m?.type !== 'knock/request') return null
  if (!okOrigin(e.origin))
    return { ok: false, refusal: new Refusal('bad_origin', `A Wedgie knocks for https sites only (or localhost), not ${e.origin}.`) }
  if (typeof m.challenge !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(m.challenge))
    return { ok: false, refusal: new Refusal('bad_request', 'The challenge must be 0x and 64 hex digits.') }
  if ((m.mode ?? 1) !== 1) return { ok: false, refusal: new Refusal('bad_request', 'Only mode 1 (Bound) is offered.') }
  return { ok: true, request: { challenge: m.challenge.toLowerCase() as Hex, mode: 1, origin: e.origin } }
}

const same = (x: unknown, y: string) => typeof x === 'string' && x.toLowerCase() === y.toLowerCase()

function refusalOf(m: Message): Refusal {
  if (m.error === 'rejected') return new Refusal('rejected', 'Red on the Wedgie: no knock.')
  if (m.error === 'timeout') return new Refusal('timeout', 'Nobody pressed on the Wedgie: no knock.')
  const why = typeof m.why === 'string' ? `: ${m.why}` : ''
  return new Refusal(String(m.error ?? 'refused'), `The Wedgie said ${String(m.error ?? m.type)}${why}`)
}

/** KNOCK on the Wedgie, for the site: a green press signs KnockPass, and the Door checks that it holds, for this
 *  challenge, origin and name, before anything goes to the site. */
export async function knockOn(w: Wedgie, device: Device, req: Request): Promise<Assertion> {
  if (!device.name) throw new Refusal('not_enrolled', 'This Wedgie has no name yet: set it up in the Knock Console.')
  if (device.status !== 'active' || !device.nullifier)
    throw new Refusal('not_enrolled', `${device.name} isn't bound to a human: set it up in the Knock Console.`)
  const m = await w.ask({ type: 'knock_pass', challenge: req.challenge, origin: req.origin, mode: 1 }, 130_000)
  if (m.type !== 'knock_pass_sig') throw refusalOf(m)
  const node = deviceNode(device.name)
  const counter = Number(m.counter)
  const nullifier = device.nullifier.toLowerCase() as Hex
  const d = digest('KnockPass', {
    challenge: req.challenge,
    origin: req.origin,
    deviceNode: node,
    counter: BigInt(Number.isSafeInteger(counter) ? counter : 0),
    mode: 1,
    nullifier: BigInt(nullifier),
    humanRef: NO_HUMAN_REF,
  })
  if (
    !Number.isSafeInteger(counter) ||
    counter < 1 ||
    !same(m.challenge, req.challenge) ||
    m.origin !== req.origin ||
    !same(m.deviceNode, node) ||
    !same(m.nullifier, nullifier) ||
    !same(m.humanRef, NO_HUMAN_REF) ||
    !same(m.key, device.key) ||
    !same(m.digest, d) ||
    !verifySignature(d, m.r as Hex, m.s as Hex, device.key)
  )
    throw new Refusal('bad_signature', "The Wedgie's knock doesn't hold for this site: nothing went to it.")
  return {
    v: 1,
    name: device.name,
    challenge: req.challenge,
    origin: req.origin,
    deviceNode: node,
    counter,
    mode: 1,
    nullifier,
    humanRef: NO_HUMAN_REF,
    r: (m.r as string).toLowerCase() as Hex,
    s: (m.s as string).toLowerCase() as Hex,
  }
}
