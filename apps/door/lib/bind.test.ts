// The binding flow with stand-ins: IDKit answers with a made-up proof, a pretend Wedgie signs with the vectors'
// test key as the real one signs in its chip, and fetch plays knockd. What reaches each is checked, for a human's
// first binding (a uniqueness proof that starts a session) and for one by their session (D24).
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { bindSignal, deviceNode, digest, signDigest, signalHash } from '@knock-dev/protocol'
import type { Hex } from 'viem'
import vectors from '../../../spec/vectors/v1.json'
import { ACTION, KNOCK_BINDING } from './deployments'
import type { Human, SessionId } from './knockd'
import type { Message, Wedgie } from './wedgie'

const KEY = vectors.key.compressed as Hex
const NAME = 'wedgie.itzraj.eth'
const NODE = deviceNode(NAME)
const SECRET = (vectors.key as Record<string, string>).secret as Hex
const NONCE = `0x00${'ab'.repeat(31)}`
const SESSION = `session_${'5e'.repeat(32)}01${'ee'.repeat(31)}` as SessionId
const HUMAN: Human = { nullifier: `0x${'0a'.repeat(32)}`, session: SESSION }
let answer: { success: boolean; result?: unknown; error?: string }
let asked: { kind?: 'request' | 'session'; config?: Record<string, unknown>; signal?: string; session?: string; type?: string } = {}

const pending = () => ({
  connectorURI: 'https://staging.world.org/verify?t=wld&i=6c0f3a1e-9b2d-4e57-a8c4-1f2e3d4c5b6a&k=a2V5',
  pollUntilCompletion: async () => answer,
})

mock.module('@worldcoin/idkit-core', () => ({
  proofOfHuman: (o: { signal: string }) => ({ preset: 'proof_of_human', signal: o.signal }),
  IDKit: {
    request: (config: Record<string, unknown>) => ({
      preset: async (p: { signal: string }) => {
        asked = { kind: 'request', config, signal: p.signal }
        return pending()
      },
    }),
    proveSession: (session: string, config: Record<string, unknown>) => ({
      constraints: async (c: { type: string; signal: string }) => {
        asked = { kind: 'session', config, signal: c.signal, session, type: c.type }
        return pending()
      },
    }),
  },
}))

let bindWedgie: typeof import('./bind').bindWedgie
beforeAll(async () => {
  ;({ bindWedgie } = await import('./bind'))
})

/** A first binding's answer: a uniqueness proof for the action, with the session it started. */
function proof(over: Record<string, unknown> = {}) {
  return {
    protocol_version: '4.0',
    nonce: NONCE,
    action: ACTION.staging,
    session_id: SESSION,
    environment: 'staging',
    responses: [
      {
        identifier: 'proof_of_human',
        signal_hash: signalHash(bindSignal(KEY, NODE)),
        proof: ['11', '22', '33', '44', '55'],
        nullifier: '123456789012345678901234567890',
        issuer_schema_id: 1,
        expires_at_min: 1762400000,
        ...over,
      },
    ],
  }
}

/** A session proof's answer: the session, and a nullifier made for a random action. */
function sessionProof(over: Record<string, unknown> = {}) {
  return {
    protocol_version: '4.0',
    nonce: NONCE,
    session_id: SESSION,
    environment: 'staging',
    responses: [
      {
        identifier: 'proof_of_human',
        signal_hash: signalHash(bindSignal(KEY, NODE)),
        proof: ['11', '22', '33', '44', '55'],
        session_nullifier: ['987654321', `${2n << 248n}`],
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
/** knockd, signing first bindings for `signs`: the deployments' action, unless a test says otherwise. */
function knockd(signs: string = ACTION.staging) {
  sent = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname
    const body = JSON.parse(String(init?.body ?? '{}'))
    sent.push({ path, body })
    const reply =
      path === '/rp-context'
        ? {
            app_id: 'app_test',
            action: body.session ? null : signs,
            rp_context: { rp_id: 'rp_00000000000000aa', nonce: NONCE, created_at: 1, expires_at: 301, signature: '0x00' },
          }
        : {
            environment: 'staging',
            tx: `0x${'cd'.repeat(32)}`,
            poh: `eip155:480:tx:0x${'cd'.repeat(32)}`,
            first: !body.sessionNullifier,
            session: body.session,
            bound: {},
          }
    return new Response(JSON.stringify(reply), { status: 200 })
  }) as typeof fetch
}
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('bindWedgie', () => {
  test("a human's first binding, a green press: the device and knockd get exactly what they check", async () => {
    knockd()
    answer = { success: true, result: proof() }
    const { w, seen } = wedgie('green')
    const steps: string[] = []
    const out = await bindWedgie(w, 'staging', KEY, NAME, null, (s) => steps.push(s.step), new AbortController().signal)
    expect(steps).toEqual(['context', 'qr', 'device', 'chain'])
    expect(out.tx).toBe(`0x${'cd'.repeat(32)}`)
    expect(out).toMatchObject({ first: true, session: SESSION })

    // IDKit: knockd's context, staging, the deployment's action, a session started, no legacy proofs, the key and
    // then the name's node as the signal
    expect(asked).toMatchObject({ kind: 'request', signal: vectors.bind.signal })
    expect(asked.config).toMatchObject({
      app_id: 'app_test',
      action: ACTION.staging,
      session_id: 'create',
      environment: 'staging',
      allow_legacy_proofs: false,
    })

    // The Wedgie: the QR, then BIND for the staging contract, numbers as 32-byte words
    expect(seen.map((m) => m.type)).toEqual(['knock_qr', 'knock_bind'])
    expect(seen[1]).toMatchObject({
      chainId: 480,
      registry: KNOCK_BINDING.staging,
      nullifier: `0x${BigInt('123456789012345678901234567890').toString(16).padStart(64, '0')}`,
      expiresAtMin: `0x${(1762400000).toString(16).padStart(64, '0')}`,
    })

    // knockd: a first binding's request, then the proof as IDKit gave it, the session, the device's key and signature
    expect(sent.map((x) => x.path)).toEqual(['/rp-context', '/bind'])
    expect(sent[0].body).toEqual({ environment: 'staging', session: false })
    expect(sent[1].body).not.toHaveProperty('sessionNullifier')
    expect(sent[1].body).toMatchObject({
      environment: 'staging',
      nullifier: `0x${BigInt('123456789012345678901234567890').toString(16).padStart(64, '0')}`,
      session: SESSION,
      nonce: NONCE,
      expiresAtMin: 1762400000,
      issuerSchemaId: 1,
      proof: ['11', '22', '33', '44', '55'],
      node: NODE,
      key: KEY,
    })
  })

  test("a returning human's binding, by their session: no action, and the session's human throughout", async () => {
    knockd()
    answer = { success: true, result: sessionProof() }
    const { w, seen } = wedgie('green')
    const out = await bindWedgie(w, 'staging', KEY, NAME, HUMAN, () => {}, new AbortController().signal)
    expect(out).toMatchObject({ first: false, session: SESSION })

    // IDKit: a proof of the session, for proof of human, with the same signal
    expect(asked).toMatchObject({ kind: 'session', session: SESSION, type: 'proof_of_human', signal: vectors.bind.signal })
    expect(asked.config).toMatchObject({ app_id: 'app_test', environment: 'staging' })
    expect(asked.config).not.toHaveProperty('action')

    // The Wedgie says yes for the session's human
    expect(seen[1]).toMatchObject({ type: 'knock_bind', registry: KNOCK_BINDING.staging, nullifier: HUMAN.nullifier })

    // knockd: a session request, then the session proof with its session nullifier, for the session's human
    expect(sent[0].body).toEqual({ environment: 'staging', session: true })
    expect(sent[1].body).toMatchObject({
      nullifier: HUMAN.nullifier,
      session: SESSION,
      sessionNullifier: ['987654321', `${2n << 248n}`],
      proof: ['11', '22', '33', '44', '55'],
      node: NODE,
      key: KEY,
    })
  })

  test("World App's no to a second uniqueness proof says what to do instead", async () => {
    knockd()
    answer = { success: false, error: 'nullifier_replayed' }
    await expect(bindWedgie(wedgie().w, 'staging', KEY, NAME, null, () => {}, new AbortController().signal)).rejects.toThrow(
      'proves a human for it once',
    )
    expect(sent.map((x) => x.path)).toEqual(['/rp-context'])
  })

  test("a knockd that signs for another action than these deployments' is caught before World App", async () => {
    knockd('knock-bind')
    await expect(bindWedgie(wedgie().w, 'staging', KEY, NAME, null, () => {}, new AbortController().signal)).rejects.toThrow(
      'restart it',
    )
  })

  test('red on the Wedgie: no binding, and knockd is never asked to send', async () => {
    knockd()
    answer = { success: true, result: proof() }
    await expect(bindWedgie(wedgie('red').w, 'staging', KEY, NAME, null, () => {}, new AbortController().signal)).rejects.toThrow(
      'Red on the Wedgie',
    )
    expect(sent.map((x) => x.path)).toEqual(['/rp-context'])
  })

  test("a signature that doesn't hold for the binding stops it here", async () => {
    knockd()
    answer = { success: true, result: proof() }
    await expect(bindWedgie(wedgie('wrong').w, 'staging', KEY, NAME, null, () => {}, new AbortController().signal)).rejects.toThrow(
      "doesn't hold",
    )
    expect(sent.map((x) => x.path)).toEqual(['/rp-context'])
  })

  test("an answer other than the one asked for: the Wedgie isn't asked", async () => {
    const { session_id: _, ...noSession } = proof()
    for (const [human, result, says] of [
      [null, proof({ signal_hash: signalHash('0x01') }), 'another signal'],
      [null, proof({ signal_hash: signalHash(bindSignal(KEY, deviceNode('spare.itzraj.eth'))) }), 'another signal'],
      [null, { ...proof(), environment: 'production' }, 'not staging'],
      [null, { ...proof(), action: 'knock-bind' }, `a proof for ${ACTION.staging} that starts a session`],
      [null, noSession, 'that starts a session'],
      [null, sessionProof(), 'that starts a session'],
      [HUMAN, proof(), 'a proof of your Knock session'],
      [HUMAN, { ...sessionProof(), session_id: `session_${'00'.repeat(64)}` }, 'a proof of your Knock session'],
      [HUMAN, sessionProof({ signal_hash: signalHash('0x01') }), 'another signal'],
    ] as const) {
      knockd()
      answer = { success: true, result }
      const { w, seen } = wedgie('green')
      await expect(bindWedgie(w, 'staging', KEY, NAME, human, () => {}, new AbortController().signal)).rejects.toThrow(says)
      expect(seen.map((m) => m.type)).toEqual(['knock_qr'])
    }
    knockd()
    answer = { success: false, error: 'cancelled' }
    await expect(bindWedgie(wedgie().w, 'staging', KEY, NAME, null, () => {}, new AbortController().signal)).rejects.toThrow(
      'cancelled',
    )
  })
})
