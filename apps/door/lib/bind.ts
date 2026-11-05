/**
 * Binding a Wedgie to a human: a World ID proof for knock-bind whose signal is the device's key (its QR on the
 * Wedgie), then the device's own yes on its BIND page, then knockd's bind() on World Chain.
 */
import { IDKit, proofOfHuman } from '@worldcoin/idkit-core'
import { bindSignal, digest, signalHash, verifySignature } from '@knock-dev/protocol'
import { type Hex, toHex } from 'viem'
import { CHAIN_ID, type Environment, KNOCK_BINDING } from './deployments'
import { type Bound, bind, rpContext } from './knockd'
import { knockQr } from './qr'
import type { Message, Wedgie } from './wedgie'

export type Step =
  | { step: 'context' }
  | { step: 'qr'; link: string; qr: { n: number; bits: string }; shown: Message }
  | { step: 'device'; nullifier: Hex }
  | { step: 'chain' }

/** A refusal along the way, said for people. */
export class Stopped extends Error {}

function refused(m: Message, what: string): never {
  const why = typeof m.why === 'string' ? `: ${m.why}` : ''
  if (m.error === 'rejected') throw new Stopped(`Red on the Wedgie: no ${what}.`)
  if (m.error === 'timeout') throw new Stopped(`Nobody pressed on the Wedgie: no ${what}.`)
  throw new Stopped(`The Wedgie said ${String(m.error ?? m.type)}${why}`)
}

export async function bindWedgie(
  w: Wedgie,
  env: Environment,
  key: Hex,
  on: (s: Step) => void,
  abort: AbortSignal,
): Promise<Bound> {
  on({ step: 'context' })
  const c = await rpContext()
  const request = await IDKit.request({
    app_id: c.app_id,
    action: c.action,
    rp_context: c.rp_context,
    allow_legacy_proofs: false,
    environment: env,
  }).preset(proofOfHuman({ signal: bindSignal(key) }))
  const qr = knockQr(request.connectorURI)
  const shown = await showQr(w, qr)
  on({ step: 'qr', link: request.connectorURI, qr, shown })

  const done = await request.pollUntilCompletion({ pollInterval: 2000, timeout: 600_000, signal: abort })
  if (!done.success) throw new Stopped(`World ID: ${done.error}`)
  const result = done.result
  if (result.protocol_version !== '4.0' || !('action' in result) || result.action !== 'knock-bind')
    throw new Stopped('World ID answered with something other than a 4.0 proof for knock-bind')
  if (result.environment !== env) throw new Stopped(`World ID answered from ${result.environment}, not ${env}`)
  const proof = result.responses[0]
  if (!proof || proof.proof.length !== 5) throw new Stopped('World ID answered without a proof')
  if (proof.signal_hash && BigInt(proof.signal_hash) !== BigInt(signalHash(bindSignal(key))))
    throw new Stopped("World ID proved another signal than this Wedgie's key")

  const nullifier = toHex(BigInt(proof.nullifier), { size: 32 })
  on({ step: 'device', nullifier })
  const registry = KNOCK_BINDING[env]
  const message = {
    chainId: BigInt(CHAIN_ID),
    registry,
    nullifier: BigInt(proof.nullifier),
    expiresAtMin: BigInt(proof.expires_at_min),
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
    nullifier: proof.nullifier,
    nonce: result.nonce,
    expiresAtMin: proof.expires_at_min,
    issuerSchemaId: proof.issuer_schema_id,
    proof: proof.proof,
    signalHash: proof.signal_hash,
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
