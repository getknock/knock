/**
 * Binding a Wedgie to a human, for the ENS name it will have (D22, D24): a World ID proof whose signal is the
 * device's key and then the name's node (its QR on the Wedgie), then the device's own yes on its BIND page, then
 * knockd's binding on World Chain. The binding counts for that name only.
 *
 * World App proves a human for an action once (its replay guard), so a human's first binding is a uniqueness proof
 * for the deployment's action that also starts a World ID session. Every binding after it, another Wedgie or this
 * one again after its name was killed, is a proof of that session: the same human, as often as asked.
 */
import { IDKit, proofOfHuman } from '@worldcoin/idkit-core'
import { bindSignal, deviceNode, digest, signalHash, verifySignature } from '@knock-dev/protocol'
import { type Hex, toHex } from 'viem'
import { ACTION, CHAIN_ID, type Environment, KNOCK_BINDING } from './deployments'
import { type Human, type SessionId, type Sent, bind, rpContext } from './knockd'
import { knockQr } from './qr'
import { Stopped, refused } from './stopped'
import type { Message, Wedgie } from './wedgie'

export type Step =
  | { step: 'context' }
  | { step: 'qr'; link: string; qr: { n: number; bits: string }; shown: Message }
  | { step: 'device'; nullifier: Hex }
  | { step: 'chain' }

export { Stopped }

const RP_TROUBLE = new Set([
  'invalid_rp_signature',
  'unknown_rp',
  'inactive_rp',
  'duplicate_nonce',
  'timestamp_too_old',
  'timestamp_too_far_in_future',
  'invalid_timestamp',
  'rp_signature_expired',
])

/** What World App's no means for a binding, in words a person can act on. */
export function worldIdSays(error: string, bySession: boolean): string {
  if ((error === 'nullifier_replayed' || error === 'max_verifications_reached') && !bySession)
    return "World App has proved you for Knock already, and proves each human once. Bind as yourself instead: connect a Wedgie you've bound before, or find yourself by a name you've bound, killed ones too."
  if (error === 'user_rejected' || error === 'verification_rejected') return 'You said no in World App, so nothing was bound.'
  if (error === 'credential_unavailable' || error === 'world_id_4_not_available')
    return "World App has no proof-of-human credential for you, which a binding asks for."
  if (error === 'invalid_network') return 'World App answers the other environment: the Simulator proves staging, World App production.'
  if (RP_TROUBLE.has(error))
    return `World App turned down Knock's request (${error}). Try again; if it repeats, look at knockd's RP key and clock.`
  if (error === 'timeout') return 'Nobody answered in World App in time. Bind again for a new QR.'
  return bySession
    ? `World ID: ${error}. If World App can't prove this Knock session, it may be someone else's: bind as a new human.`
    : `World ID: ${error}`
}

export async function bindWedgie(
  w: Wedgie,
  env: Environment,
  key: Hex,
  /** The ENS name the Wedgie will have: its records point at this binding, and only it can use it. */
  name: string,
  /** The human, when Knock knows them: their session binds it. Null for a human's first binding. */
  human: Human | null,
  on: (s: Step) => void,
  abort: AbortSignal,
): Promise<Sent> {
  const node = deviceNode(name)
  const signal = bindSignal(key, node)
  on({ step: 'context' })
  const c = await rpContext(env, Boolean(human))
  if (!human && c.action !== ACTION[env])
    throw new Stopped(`knockd signs for ${c.action}, not ${ACTION[env]}: restart it from this repo`)
  const request = human
    ? await IDKit.proveSession(human.session, { app_id: c.app_id, rp_context: c.rp_context, environment: env }).constraints(
        { type: 'proof_of_human', signal },
      )
    : await IDKit.request({
        app_id: c.app_id,
        action: ACTION[env],
        session_id: 'create',
        rp_context: c.rp_context,
        allow_legacy_proofs: false,
        environment: env,
      }).preset(proofOfHuman({ signal }))
  const qr = knockQr(request.connectorURI)
  const shown = await showQr(w, qr)
  on({ step: 'qr', link: request.connectorURI, qr, shown })

  const done = await request.pollUntilCompletion({ pollInterval: 2000, timeout: 600_000, signal: abort })
  if (!done.success) throw new Stopped(worldIdSays(done.error, Boolean(human)))
  const result = done.result
  if (result.protocol_version !== '4.0') throw new Stopped('World ID answered with a 3.0 proof, not a 4.0 one')
  if (result.environment !== env) throw new Stopped(`World ID answered from ${result.environment}, not ${env}`)
  // Each answer as it was asked for: the session's proof, or a proof for the action with the session it started
  const item = result.responses[0]
  let nullifier: Hex
  let session: SessionId
  let sessionNullifier: [string, string] | undefined
  if (human) {
    if ('action' in result || result.session_id !== human.session || !item || !('session_nullifier' in item))
      throw new Stopped('World ID answered with something other than a proof of your Knock session')
    const [n, a] = item.session_nullifier
    if (!n || !a) throw new Stopped('World ID answered without a session nullifier')
    nullifier = human.nullifier
    session = human.session
    sessionNullifier = [n, a]
  } else {
    if (!('action' in result) || result.action !== ACTION[env] || !result.session_id || !item || !('nullifier' in item))
      throw new Stopped(`World ID answered with something other than a proof for ${ACTION[env]} that starts a session`)
    nullifier = toHex(BigInt(item.nullifier), { size: 32 })
    session = result.session_id
  }
  if (item.proof.length !== 5) throw new Stopped('World ID answered without a proof')
  if (item.signal_hash && BigInt(item.signal_hash) !== BigInt(signalHash(signal)))
    throw new Stopped(`World ID proved another signal than this Wedgie's key for ${name}`)

  on({ step: 'device', nullifier })
  const registry = KNOCK_BINDING[env]
  const message = {
    chainId: BigInt(CHAIN_ID),
    registry,
    nullifier: BigInt(nullifier),
    expiresAtMin: BigInt(item.expires_at_min),
    key,
  }
  const sig = await w.ask(
    {
      type: 'knock_bind',
      chainId: CHAIN_ID,
      registry,
      nullifier,
      expiresAtMin: toHex(message.expiresAtMin, { size: 32 }),
    },
    130_000,
  )
  if (sig.type !== 'knock_bind_sig') refused(sig, 'binding')
  const d = digest('KnockBind', message)
  const same = (x: unknown, y: string) => typeof x === 'string' && x.toLowerCase() === y.toLowerCase()
  if (!same(sig.key, key) || !same(sig.digest, d) || !verifySignature(d, sig.r as Hex, sig.s as Hex, key))
    throw new Stopped("The Wedgie's signature doesn't hold for this binding")

  on({ step: 'chain' })
  return bind({
    environment: env,
    nullifier,
    session,
    sessionNullifier,
    nonce: result.nonce,
    expiresAtMin: item.expires_at_min,
    issuerSchemaId: item.issuer_schema_id,
    proof: item.proof,
    signalHash: item.signal_hash,
    node,
    key,
    r: sig.r as Hex,
    s: sig.s as Hex,
  })
}

/** A QR on the Wedgie's screen, Knock's logo in the middle (D13). */
export async function showQr(w: Wedgie, qr: { n: number; bits: string }): Promise<Message> {
  const shown = await w.ask({ type: 'knock_qr', ...qr }, 15_000)
  if (shown.type !== 'knock_qr_shown') refused(shown, 'QR')
  return shown
}
