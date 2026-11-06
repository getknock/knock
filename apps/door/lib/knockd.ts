/** knockd, Knock's signer (server/knockd): World ID request contexts, and bind() sent with its gas key. */
import type { Hex } from 'viem'
import type { Environment } from './deployments'

export const KNOCKD = process.env.NEXT_PUBLIC_KNOCKD ?? 'http://127.0.0.1:8787'

/** knockd's no, as it says it: {error, why}. */
export class Refused extends Error {
  constructor(
    readonly error: string,
    readonly why: string,
  ) {
    super(why)
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let r: Response
  try {
    r = await fetch(KNOCKD + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Refused('offline', `knockd isn't answering at ${KNOCKD}: start it with cargo run -p knockd`)
  }
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Refused(j.error ?? 'error', j.why ?? `knockd answered ${r.status}`)
  return j as T
}

export type RpContext = { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string }

/** A World ID request for knock-bind, signed by Knock's RP key, with the app it's for. */
export function rpContext() {
  return post<{ app_id: `app_${string}`; action: string; rp_context: RpContext }>('/rp-context', {
    action: 'knock-bind',
  })
}

export type BindBody = {
  environment: Environment
  nullifier: string
  nonce: string
  expiresAtMin: number
  issuerSchemaId: number
  proof: string[]
  signalHash?: string
  key: Hex
  r: Hex
  s: Hex
}

export type Bound = {
  environment: Environment
  chainId: number
  contract: Hex
  tx: Hex
  block: number
  gasUsed: number
  /** knock.poh: eip155:480:tx:<hash> */
  poh: string
  bound: { nullifier: Hex; keyHash: Hex; expiresAtMin: number }
}

/** The binding, checked by knockd (the device's signature, then World ID in a simulation) and sent. */
export function bind(body: BindBody) {
  return post<Bound>('/bind', body)
}

export type BindingOnChain = Omit<Bound, 'gasUsed'>

/** A binding read back from its transaction: the Bound log one of our KnockBindings emitted in it. */
export function boundTx(tx: Hex) {
  return post<BindingOnChain>('/bound', { tx })
}
