/** Meeting the Wedgie: Knock runs on it, has its key, and signs a fresh hello with it. */
import { digest, verifySignature } from '@knock-dev/protocol'
import { type Hex, toHex } from 'viem'
import { Stopped } from './bind'
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
  }
}
