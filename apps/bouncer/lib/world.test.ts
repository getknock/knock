import { describe, expect, test } from 'bun:test'
import { bindSignal, digest, keyHash, publicKeyOf, signalHash, uncompressKey, verifySignature } from '@knock-dev/protocol'
import { type Hex, namehash, toHex, verifyMessage } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  ACTION,
  BINDING,
  CHAIN_ID,
  WORLD_ENV,
  type WorldReads,
  checkBound,
  enrollmentKey,
  nodeOf,
  nonceOf,
  proveSession,
  readFirstProof,
  readSessionProof,
  sessionParts,
  signBinding,
  signInMessage,
  signInNonce,
  walletNode,
} from './world'

const T0 = Date.UTC(2026, 10, 7, 9, 0)
const COMMITMENT = 'ab'.repeat(32)
/** A session's oprf seed: its top byte 1, as a first binding starts it */
const SEED = `01${'cd'.repeat(31)}`
const SESSION = `session_${COMMITMENT}${SEED}` as const
const CHALLENGE = `0x${'5e'.repeat(32)}` as Hex
const NULLIFIER = `0x${'0f'.repeat(32)}` as Hex
const WALLET = '0x5A5a5A5a5A5a5A5a5A5a5A5a5A5a5A5a5A5a5A5a'
/** A session proof's action: one World App makes, its top byte 2 */
const RANDOM_ACTION = ((2n << 248n) + 77n).toString()

/** World App's answer to the club's request for a proof of a Knock session, as IDKit hands it over */
function sessionResult(over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) {
  return {
    protocol_version: '4.0',
    environment: WORLD_ENV,
    nonce: `0x${'0a'.repeat(32)}`,
    session_id: SESSION,
    responses: [
      {
        identifier: 'proof_of_human',
        issuer_schema_id: 1,
        proof: ['1', '2', '3', '4', '5'],
        session_nullifier: ['12345', RANDOM_ACTION],
        expires_at_min: 29_000_000,
        signal_hash: signalHash(CHALLENGE),
        ...item,
      },
    ],
    ...over,
  }
}

/** World App's first proof for Knock's action, for the club's key and a wallet */
function firstResult(signal: string, over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) {
  return {
    protocol_version: '4.0',
    environment: WORLD_ENV,
    nonce: '42',
    action: ACTION,
    session_id: SESSION,
    responses: [
      {
        identifier: 'proof_of_human',
        issuer_schema_id: 1,
        proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
        nullifier: NULLIFIER,
        expires_at_min: 29_000_000,
        signal_hash: signalHash(signal),
        ...item,
      },
    ],
    ...over,
  }
}

/** The check a refusal was at, and its code */
function refused(f: () => unknown): string {
  try {
    f()
  } catch (e) {
    const r = e as { check?: number; error?: string }
    if (typeof r.check === 'number') return `${r.check} ${r.error}`
    throw e
  }
  throw new Error('not refused')
}

const reads = (human: bigint, said: string | null, bound: Awaited<ReturnType<WorldReads['bound']>> = null): WorldReads => ({
  humanOf: async () => human,
  verifySession: async () => said,
  bound: async () => bound,
})

describe('who a visitor is to Knock', () => {
  test("a wallet is found by its reverse name, a Wedgie by its own, normalized; anything else isn't a name", () => {
    const reverse = namehash(`${WALLET.slice(2).toLowerCase()}.addr.reverse`)
    expect(walletNode(WALLET)).toBe(reverse)
    expect(nodeOf(WALLET.toLowerCase())).toBe(reverse)
    expect(nodeOf(' wedgie.itzraj.eth ')).toBe(namehash('wedgie.itzraj.eth'))
    expect(nodeOf('Wedgie.ItzRaj.eth')).toBe(namehash('wedgie.itzraj.eth'))
    expect(nodeOf('wedgie')).toBe(null)
    expect(nodeOf('')).toBe(null)
    expect(nodeOf('a..eth')).toBe(null)
  })

  test("a session id is its commitment, then its seed, 64 hex digits each", () => {
    expect(sessionParts(SESSION)).toEqual({ commitment: BigInt(`0x${COMMITMENT}`), seed: BigInt(`0x${SEED}`) })
    expect(sessionParts(`session_${COMMITMENT}`)).toBe(null)
    expect(sessionParts(`sess_${COMMITMENT}${SEED}`)).toBe(null)
    expect(sessionParts(42)).toBe(null)
  })

  test('a result names the request it answers by its nonce, a 32-byte word however it was written', () => {
    expect(nonceOf({ nonce: '10' })).toBe(toHex(10n, { size: 32 }))
    expect(nonceOf({ nonce: '0xA' })).toBe(toHex(10n, { size: 32 }))
    expect(nonceOf({ nonce: 'ten' })).toBe(null)
    expect(nonceOf(null)).toBe(null)
  })
})

describe("a wallet's sign-in", () => {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`)

  test("the club's message: its origin, the wallet, mainnet, and a nonce the club finds it by", async () => {
    const m = signInMessage('https://club.getknock.dev', account.address, 'abcdefgh12345678', T0)
    expect(m.startsWith('club.getknock.dev wants you to sign in with your Ethereum account:\n')).toBe(true)
    expect(m).toContain(`\n${account.address}\n`)
    expect(m).toContain('\nURI: https://club.getknock.dev\n')
    expect(m).toContain('\nChain ID: 1\n')
    expect(m).toContain(`\nExpiration Time: ${new Date(T0 + 5 * 60_000).toISOString()}`)
    expect(signInNonce(m)).toBe('abcdefgh12345678')
    const signature = await account.signMessage({ message: m })
    expect(await verifyMessage({ address: account.address, message: m, signature })).toBe(true)
  })

  test("anything else has no nonce to find", () => {
    expect(signInNonce('Sign in, please')).toBe(null)
    expect(signInNonce(42)).toBe(null)
    expect(signInNonce('x'.repeat(3000))).toBe(null)
  })
})

describe('a proof of a Knock session, for an act', () => {
  test("read: the session's commitment, World App's session nullifier, and the club's challenge as its signal", () => {
    const p = readSessionProof(sessionResult(), SESSION, CHALLENGE)
    expect(p).toEqual({
      commitment: BigInt(`0x${COMMITMENT}`),
      sessionNullifier: [12345n, BigInt(RANDOM_ACTION)],
      nonce: BigInt(`0x${'0a'.repeat(32)}`),
      expiresAtMin: 29_000_000n,
      issuerSchemaId: 1n,
      proof: [1n, 2n, 3n, 4n, 5n],
      signalHash: BigInt(signalHash(CHALLENGE)),
    })
  })

  test("refused at the check it fails: made wrong (1), for another challenge (2), of another session (3)", () => {
    const read = (over?: Record<string, unknown>, item?: Record<string, unknown>) => () =>
      readSessionProof(sessionResult(over, item), SESSION, CHALLENGE)
    expect(refused(read({ protocol_version: '3.0' }))).toBe('1 bad_proof')
    expect(refused(read({ environment: WORLD_ENV === 'production' ? 'staging' : 'production' }))).toBe('1 bad_proof')
    expect(refused(read({ action: ACTION }))).toBe('1 bad_proof')
    expect(refused(read({}, { issuer_schema_id: 9303 }))).toBe('1 not_proof_of_human')
    expect(refused(read({}, { proof: ['1', '2', '3', '4'] }))).toBe('1 bad_proof')
    expect(refused(read({}, { proof: ['1', '2', '3', '4', 'five'] }))).toBe('1 bad_proof')
    expect(refused(read({}, { session_nullifier: undefined }))).toBe('1 bad_proof')
    expect(refused(read({ responses: [] }))).toBe('1 bad_proof')
    expect(refused(read({}, { signal_hash: signalHash(`0x${'00'.repeat(32)}`) }))).toBe('2 bad_challenge')
    expect(refused(read({ session_id: `session_${'ee'.repeat(32)}${SEED}` }))).toBe('3 not_your_session')
    expect(refused(read({}, { session_nullifier: ['12345', ((1n << 248n) + 77n).toString()] }))).toBe('3 not_a_session')
  })

  test("taken: KnockBinding's human for the session (3), once World ID's verifier holds the proof (4)", async () => {
    const p = readSessionProof(sessionResult(), SESSION, CHALLENGE)
    expect(await proveSession(reads(0xabn, null), p)).toBe(toHex(0xabn, { size: 32 }))
    await expect(proveSession(reads(0n, null), p)).rejects.toMatchObject({ check: 3, error: 'no_session' })
    await expect(proveSession(reads(0xabn, 'ProofInvalid'), p)).rejects.toMatchObject({ check: 4, error: 'not_proved' })
  })
})

describe("a human's first proof, for Knock's action", () => {
  const node = walletNode(WALLET)

  test("the club's key for a wallet: a P-256 key, and the signal World App proves is it, then the wallet's node", () => {
    const k = enrollmentKey(node)
    expect(publicKeyOf(k.secret).key).toBe(k.key)
    expect(k.signal).toBe(bindSignal(k.key, node))
    expect(enrollmentKey(node).key).not.toBe(k.key)
  })

  test("read: the human's nullifier, and the session it starts", () => {
    const { signal } = enrollmentKey(node)
    const p = readFirstProof(firstResult(signal), ACTION, signal)
    expect(p.nullifier).toBe(NULLIFIER)
    expect(p.session).toBe(SESSION)
    expect(p.nonce).toBe(42n)
    expect(p.proof).toEqual([1n, 2n, 3n, 4n, 5n])
  })

  test('refused when it starts no session, is for another action or signal, or has no nullifier', () => {
    const { signal } = enrollmentKey(node)
    const read = (over?: Record<string, unknown>, item?: Record<string, unknown>) => () =>
      readFirstProof(firstResult(signal, over, item), ACTION, signal)
    expect(refused(read({ action: 'knock-bind' }))).toBe('3 bad_proof')
    expect(refused(read({ session_id: undefined }))).toBe('3 no_session')
    expect(refused(read({ session_id: `session_${COMMITMENT}02${'cd'.repeat(31)}` }))).toBe('3 no_session')
    expect(refused(read({ session_id: `session_${'00'.repeat(32)}${SEED}` }))).toBe('3 no_session')
    expect(refused(read({}, { signal_hash: signalHash(CHALLENGE) }))).toBe('2 bad_challenge')
    expect(refused(read({}, { nullifier: undefined }))).toBe('1 bad_proof')
  })

  test("the club's key says yes to the binding, as a Wedgie would: KnockBind, low s", () => {
    const { secret, key } = enrollmentKey(node)
    const sig = signBinding(secret, key, NULLIFIER, 29_000_000n)
    const d = digest('KnockBind', { chainId: BigInt(CHAIN_ID), registry: BINDING, nullifier: BigInt(NULLIFIER), expiresAtMin: 29_000_000n, key })
    expect(verifySignature(d, sig.r, sig.s, key)).toBe(true)
    const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
    expect(BigInt(sig.s) <= n / 2n).toBe(true)
  })

  test("taken once World Chain shows the binding of the club's key, for this wallet and this human (4)", async () => {
    const { key } = enrollmentKey(node)
    const { x, y } = uncompressKey(key)
    const kh = keyHash(x, y)
    const tx = `0x${'7c'.repeat(32)}` as Hex
    const want = { nullifier: NULLIFIER, key, node }
    expect(await checkBound(reads(0n, null, [{ nullifier: NULLIFIER, keyHash: kh, node }]), tx, want)).toBe(kh)
    for (const bound of [null, [], [{ nullifier: NULLIFIER, keyHash: kh, node: namehash('other.eth') }], [{ nullifier: CHALLENGE, keyHash: kh, node }]])
      await expect(checkBound(reads(0n, null, bound), tx, want)).rejects.toMatchObject({ check: 4, error: 'not_bound' })
  })
})
