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

/**
 * A World ID request signed by Knock's RP key, with the app it's for: for a human's first binding, a uniqueness
 * proof for the deployment's action (D24); for a binding by their session, a session proof, which names no action.
 */
export function rpContext(env: Environment, session: boolean) {
  return post<{ app_id: `app_${string}`; action: string | null; rp_context: RpContext }>('/rp-context', {
    environment: env,
    session,
  })
}

/** World ID's id for a session: `session_`, then its commitment and oprf seed in hex. */
export type SessionId = `session_${string}`

/** A human Knock knows: their nullifier for the first binding's action, and the session that binding started. */
export type Human = { nullifier: Hex; session: SessionId }

/** The human's session as KnockBinding has it, by their nullifier or by a session; null when it has none. */
export async function human(env: Environment, by: { nullifier: Hex } | { session: SessionId }): Promise<Human | null> {
  try {
    const h = await post<{ nullifier: Hex; session: SessionId }>('/human', { environment: env, ...by })
    return { nullifier: h.nullifier, session: h.session }
  } catch (e) {
    if (e instanceof Refused && e.error === 'no_session') return null
    throw e
  }
}

export type BindBody = {
  environment: Environment
  /** A first binding's proof's nullifier, or the session's human a session proof binds for. */
  nullifier: string
  /** The session the first binding started, or the one the session proof proved. */
  session: SessionId
  /** A session proof's session nullifier and the random action it was made for: a binding by session. */
  sessionNullifier?: [string, string]
  nonce: string
  expiresAtMin: number
  issuerSchemaId: number
  proof: string[]
  signalHash?: string
  /** The namehash of the name the Wedgie will have: the signal's end (D22). */
  node: Hex
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
  bound: { nullifier: Hex; keyHash: Hex; node: Hex; expiresAtMin: number }
}

/** A binding knockd sent: the human's first, or one by their session, and the session either way. */
export type Sent = Bound & { first: boolean; session: SessionId }

/** The binding, checked by knockd (the device's signature, then World ID in a simulation) and sent. */
export function bind(body: BindBody) {
  return post<Sent>('/bind', body)
}

export type BindingOnChain = Omit<Bound, 'gasUsed'>

/** A binding read back from its transaction: the Bound log one of our KnockBindings emitted in it. */
export function boundTx(tx: Hex) {
  return post<BindingOnChain>('/bound', { tx })
}
