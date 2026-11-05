// The binding flow with stand-ins: IDKit answers with a made-up proof, a pretend Wedgie signs with the vectors'
// test key as the real one signs in its chip, and fetch plays knockd. What reaches each is checked.
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { bindSignal, digest, signDigest, signalHash } from '@knock-dev/protocol'
import type { Hex } from 'viem'
import vectors from '../../../spec/vectors/v1.json'
import { KNOCK_BINDING } from './deployments'
import type { Message, Wedgie } from './wedgie'

const KEY = vectors.key.compressed as Hex
const SECRET = (vectors.key as Record<string, string>).secret as Hex
const NONCE = `0x00${'ab'.repeat(31)}`
let answer: { success: boolean; result?: unknown; error?: string }
const asked: { config?: Record<string, unknown>; signal?: string } = {}

mock.module('@worldcoin/idkit-core', () => ({
  proofOfHuman: (o: { signal: string }) => ({ preset: 'proof_of_human', signal: o.signal }),
  IDKit: {
    request: (config: Record<string, unknown>) => ({
      preset: async (p: { signal: string }) => {
        asked.config = config
        asked.signal = p.signal
        return {
          connectorURI: 'https://staging.world.org/verify?t=wld&i=6c0f3a1e-9b2d-4e57-a8c4-1f2e3d4c5b6a&k=a2V5',
          pollUntilCompletion: async () => answer,
        }
      },
    }),
  },
}))

let bindWedgie: typeof import('./bind').bindWedgie
beforeAll(async () => {
  ;({ bindWedgie } = await import('./bind'))
})

function proof(over: Record<string, unknown> = {}) {
  return {
    protocol_version: '4.0',
    nonce: NONCE,
    action: 'knock-bind',
    environment: 'staging',
    responses: [
      {
        identifier: 'proof_of_human',
        signal_hash: signalHash(bindSignal(KEY)),
        proof: ['11', '22', '33', '44', '55'],
        nullifier: '123456789012345678901234567890',
        issuer_schema_id: 1,
        expires_at_min: 1762400000,
        ...over,
      },
    ],
  }
}

/** A pretend Wedgie: draws QRs, and on knock_bind signs KnockBind as the chip does, or says what `press` says. */
function wedgie(press: 'green' | 'red' | 'wrong' = 'green') {
  const seen: Message[] = []
  const w = {
    async ask(m: Message): Promise<Message> {
      seen.push(m)
      if (m.type === 'knock_qr') return { type: 'knock_qr_shown', n: m.n, scale: 3, logo: true }
      if (m.type === 'knock_cancel') return { type: 'knock_cancelled' }
      if (m.type !== 'knock_bind') return { type: 'knock_error', error: 'bad_request' }
      if (press === 'red') return { type: 'knock_error', error: 'rejected', why: 'red' }
      const d = digest('KnockBind', {
        chainId: BigInt(m.chainId as number),
        registry: m.registry as Hex,
        nullifier: BigInt(m.nullifier as string),
        expiresAtMin: BigInt(m.expiresAtMin as string),
        key: KEY,
      })
      const { r, s } = signDigest(press === 'wrong' ? (`0x${'11'.repeat(32)}` as Hex) : d, SECRET)
      return { ...m, type: 'knock_bind_sig', key: KEY, digest: d, r, s }
    },
  }
  return { w: w as unknown as Wedgie, seen }
}

let sent: { path: string; body: Record<string, unknown> }[] = []
const realFetch = globalThis.fetch
function knockd() {
  sent = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    const body = JSON.parse(String(init?.body ?? '{}'))
    sent.push({ path, body })
    const reply =
      path === '/rp-context'
        ? { app_id: 'app_test', action: 'knock-bind', rp_context: { rp_id: 'rp_00000000000000aa', nonce: NONCE, created_at: 1, expires_at: 301, signature: '0x00' } }
        : { environment: 'staging', tx: `0x${'cd'.repeat(32)}`, poh: `eip155:480:tx:0x${'cd'.repeat(32)}`, bound: {} }
    return new Response(JSON.stringify(reply), { status: 200 })
  }) as typeof fetch
}
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('bindWedgie', () => {
  test("a Simulator proof, a green press: the device and knockd get exactly what they check", async () => {
    knockd()
    answer = { success: true, result: proof() }
    const { w, seen } = wedgie('green')
    const steps: string[] = []
    const out = await bindWedgie(w, 'staging', KEY, (s) => steps.push(s.step), new AbortController().signal)
    expect(steps).toEqual(['context', 'qr', 'device', 'chain'])
    expect(out.tx).toBe(`0x${'cd'.repeat(32)}`)

    // IDKit: knockd's context, staging, no legacy proofs, the key as the signal
    expect(asked.config).toMatchObject({ app_id: 'app_test', action: 'knock-bind', environment: 'staging', allow_legacy_proofs: false })
    expect(asked.signal).toBe(KEY.toLowerCase())

    // The Wedgie: the QR, then BIND for the staging contract, numbers as 32-byte words
    expect(seen.map((m) => m.type)).toEqual(['knock_qr', 'knock_bind'])
    expect(seen[1]).toMatchObject({
      chainId: 480,
      registry: KNOCK_BINDING.staging,
      nullifier: `0x${BigInt('123456789012345678901234567890').toString(16).padStart(64, '0')}`,
      expiresAtMin: `0x${(1762400000).toString(16).padStart(64, '0')}`,
    })

    // knockd: the proof as IDKit gave it, and the device's key and signature
    expect(sent.map((x) => x.path)).toEqual(['/rp-context', '/bind'])
    expect(sent[1].body).toMatchObject({
      environment: 'staging',
      nullifier: '123456789012345678901234567890',
      nonce: NONCE,
      expiresAtMin: 1762400000,
      issuerSchemaId: 1,
      proof: ['11', '22', '33', '44', '55'],
      key: KEY,
    })
  })

  test('red on the Wedgie: no binding, and knockd is never asked to send', async () => {
    knockd()
    answer = { success: true, result: proof() }
    await expect(bindWedgie(wedgie('red').w, 'staging', KEY, () => {}, new AbortController().signal)).rejects.toThrow(
      'Red on the Wedgie',
    )
    expect(sent.map((x) => x.path)).toEqual(['/rp-context'])
  })

  test("a signature that doesn't hold for the binding stops it here", async () => {
    knockd()
    answer = { success: true, result: proof() }
    await expect(bindWedgie(wedgie('wrong').w, 'staging', KEY, () => {}, new AbortController().signal)).rejects.toThrow(
      "doesn't hold",
    )
    expect(sent.map((x) => x.path)).toEqual(['/rp-context'])
  })

  test("a proof of another signal, from another environment, or none at all: the Wedgie isn't asked", async () => {
    for (const [result, says] of [
      [proof({ signal_hash: signalHash('0x01') }), 'another signal'],
      [{ ...proof(), environment: 'production' }, 'not staging'],
      [{ ...proof(), action: 'something-else' }, '4.0 proof for knock-bind'],
    ] as const) {
      knockd()
      answer = { success: true, result }
      const { w, seen } = wedgie('green')
      await expect(bindWedgie(w, 'staging', KEY, () => {}, new AbortController().signal)).rejects.toThrow(says)
      expect(seen.map((m) => m.type)).toEqual(['knock_qr'])
    }
    knockd()
    answer = { success: false, error: 'cancelled' }
    await expect(bindWedgie(wedgie().w, 'staging', KEY, () => {}, new AbortController().signal)).rejects.toThrow('cancelled')
  })
})
