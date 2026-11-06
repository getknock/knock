/**
 * The Wedgie's side of things: meeting it (Knock runs, has its key, and signs a fresh hello with it), BECOME for a
 * name, and what it's told after: its name and binding (knock_confirm), or to forget them (the kill switch).
 */
import { deviceNode, digest, verifySignature } from '@knock-dev/protocol'
import { type Hex, toHex } from 'viem'
import { Stopped, refused } from './stopped'
import type { Wedgie } from './wedgie'

export type Device = {
  app: string
  firmware: string
  key: Hex
  name: string | null
  status: string | null
  nullifier: Hex | null
  poh: string | null
  counter: number
  /** Its security class for knock.sc (S1: any installed app can use the chip). */
  sc: string
}

const KEYLESS: Record<string, string> = {
  none: 'Knock has no key yet. Make one on the Wedgie: its home screen offers it.',
  lost: "Knock's saved key isn't in the chip any more. Look at the Wedgie's home screen.",
  nochip: "Knock can't find the Wedgie's secure chip.",
}

export const same = (x: unknown, y: string) => typeof x === 'string' && x.toLowerCase() === y.toLowerCase()

export async function meet(w: Wedgie): Promise<Device> {
  const h = await w.ask({ type: 'hello' })
  if (h.running !== 'knock')
    throw new Stopped(`This Wedgie runs ${String(h.running ?? 'another app')}, not Knock. Install Knock on it first.`)
  if (typeof h.knock_key !== 'string') throw new Stopped(KEYLESS[String(h.knock_state)] ?? 'Knock has no key.')
  const challenge = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const info = await w.ask({ type: 'knock_hello', challenge })
  const d = digest('KnockHello', { challenge })
  if (
    info.type !== 'knock_info' ||
    !same(info.key, h.knock_key) ||
    !same(info.digest, d) ||
    !verifySignature(d, info.r as Hex, info.s as Hex, h.knock_key as Hex)
  )
    throw new Stopped("The Wedgie's hello isn't signed by its key.")
  return {
    app: String(h.app),
    firmware: String(h.version ?? ''),
    key: (h.knock_key as string).toLowerCase() as Hex,
    name: (info.name as string) ?? null,
    status: (info.status as string) ?? null,
    nullifier: (info.nullifier as Hex) ?? null,
    poh: (info.poh as string) ?? null,
    counter: Number(info.counter ?? 0),
    sc: typeof info.sc === 'string' ? info.sc : 'S1',
  }
}

/** BECOME on the Wedgie's screen: a green press signs KnockEnroll(nonce, name, key), the device's yes to the name.
 *  Its chip's vouch for the key comes back with it (att). */
export async function become(w: Wedgie, name: string, key: Hex) {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)))
  const m = await w.ask({ type: 'knock_enroll', nonce, name }, 130_000)
  if (m.type !== 'knock_enrolled') {
    if (m.error === 'already_enrolled')
      throw new Stopped(`The Wedgie is bound as another name: ${String(m.why ?? '')}. Use the kill switch on it first.`)
    refused(m, 'name')
  }
  const d = digest('KnockEnroll', { nonce, name, key })
  if (
    m.name !== name ||
    !same(m.node, deviceNode(name)) ||
    !same(m.key, key) ||
    !same(m.digest, d) ||
    !verifySignature(d, m.r as Hex, m.s as Hex, key)
  )
    throw new Stopped("The Wedgie's BECOME isn't signed by its key for this name.")
  return { att: m.att }
}

/** What ENS and World Chain now say, for the Wedgie's home screen (its Human badge) and its next passes. */
export async function confirmOn(w: Wedgie, c: { name: string; nullifier: Hex; poh: string }) {
  const m = await w.ask({ type: 'knock_confirm', ...c, status: 'active' })
  if (m.type !== 'knock_confirmed' || !same(m.node, deviceNode(c.name))) refused(m, 'confirmation')
}

/** The kill switch's last step: the Wedgie forgets its name and binding ('forgot'). Knock 4 had no knock_forget,
 *  so there its name is kept, marked revoked, with no binding, and its home screen keeps showing it ('revoked'). */
export async function forgetOn(w: Wedgie, name: string | null): Promise<'forgot' | 'revoked'> {
  const m = await w.ask({ type: 'knock_forget' })
  if (m.type === 'knock_forgotten') return 'forgot'
  if (m.error === 'bad_request' && name) {
    const r = await w.ask({ type: 'knock_confirm', name, status: 'revoked' })
    if (r.type === 'knock_confirmed') return 'revoked'
  }
  refused(m, 'forgetting')
}
