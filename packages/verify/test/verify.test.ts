import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { P256_N, digest, signDigest } from '@knock-dev/protocol'
import { createClient } from '@libsql/client'
import { type Hex, keccak256, pad, stringToBytes, toHex } from 'viem'
import {
  type Assertion,
  CACHE_MS,
  CHALLENGE_MS,
  type Chain,
  KNOCK_BINDING,
  type Memory,
  type Receipt,
  type Records,
  Refusal,
  type Store,
  Verifier,
  check,
  libsqlStore,
  memoryStore,
  parse,
  strictFrom,
} from '../src/index.ts'

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
/** The protocol's vectors: a published test key, never a device's */
const V = read('../../../spec/vectors/v1.json')
const PASS = V.structs.KnockPass
const ORIGIN: string = PASS.message.origin
const NAME: string = V.device.name
const KEY: Hex = V.key.compressed
const NULLIFIER: Hex = PASS.message.nullifier
const POH = `0x${'ab'.repeat(32)}` as Hex
const NOW = Date.UTC(2026, 10, 6, 12)
const PROVED = Math.floor(NOW / 1000) - 86_400

/** The vectors' knock, as the Door hands it over */
const VECTOR: Assertion = { v: 1, name: NAME, ...PASS.message, r: PASS.r, s: PASS.s }

/** A knock signed with the vectors' key, the vectors' fields but for those given */
function knock(over: Partial<Omit<Assertion, 'v' | 'name' | 'r' | 's'>> = {}): Assertion {
  const m = { ...PASS.message, ...over }
  const d = digest('KnockPass', {
    challenge: m.challenge,
    origin: m.origin,
    deviceNode: m.deviceNode,
    counter: BigInt(m.counter),
    mode: m.mode,
    nullifier: BigInt(m.nullifier),
    humanRef: m.humanRef,
  })
  return { v: 1, name: NAME, ...m, ...signDigest(d, V.key.secret) }
}

const records = (over: Partial<Records> = {}): Records => ({
  v: '1',
  key: KEY,
  status: 'active',
  nullifier: NULLIFIER,
  poh: `eip155:480:tx:${POH}`,
  ...over,
})

const bound = (over: { address?: Hex; keyHash?: Hex; provedAt?: number } = {}) => ({
  address: over.address ?? KNOCK_BINDING,
  topics: [keccak256(stringToBytes('Bound(uint256,bytes32,bytes32,uint64)')), pad(NULLIFIER), over.keyHash ?? V.key.keyHash, V.device.node] as Hex[],
  data: pad(toHex(over.provedAt ?? PROVED)),
})

/** A chain that holds the vectors' name and binding, or what a test says instead; it counts its records reads */
function chain(o: { latest?: Records; deep?: Records; receipt?: Receipt | null; final?: number; down?: boolean } = {}) {
  const c: Chain & { reads: number } = {
    reads: 0,
    head: async () => {
      if (o.down) throw new Error('fetch failed: https://rpc.example/v2/secret-key\nmore')
      return 1000n
    },
    records: async (_name, block) => {
      c.reads++
      return block === 1000n ? (o.latest ?? records()) : (o.deep ?? o.latest ?? records())
    },
    receipt: async () => (o.receipt === undefined ? { ok: true, block: 500, logs: [bound()] } : o.receipt),
    finalBlock: async () => o.final ?? 400,
  }
  return c
}

/** What a check says no with: its check and code */
async function no(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === 'function' ? p() : p)
  } catch (e) {
    if (e instanceof Refusal) return `${e.check} ${e.error}`
    throw e
  }
  throw new Error('let in')
}

const site = (over: Partial<Parameters<typeof check>[0]> = {}) => ({ origin: ORIGIN, chain: chain(), memory: memoryStore(), ...over })

describe('V1: a knock, whole and well formed', () => {
  test("the vectors' knock", () => {
    expect(parse(VECTOR)).toEqual(VECTOR)
  })

  test('anything else, with what was wrong', async () => {
    const { r: _, ...noR } = VECTOR
    const cases: unknown[] = [
      null,
      [VECTOR],
      { ...VECTOR, extra: 1 },
      noR,
      { ...VECTOR, challenge: '0x1234' },
      { ...VECTOR, v: 2 },
      { ...VECTOR, name: 'Wedgie.itzraj.eth' },
      { ...VECTOR, deviceNode: POH },
      { ...VECTOR, origin: 'http://bouncer.example' },
      { ...VECTOR, origin: 'https://bouncer.example/' },
      { ...VECTOR, counter: 0 },
      { ...VECTOR, counter: 1.5 },
      { ...VECTOR, mode: 3 },
      { ...VECTOR, s: toHex(P256_N - BigInt(VECTOR.s), { size: 32 }) },
    ]
    for (const c of cases) expect(await no(() => parse(c))).toBe('1 bad_assertion')
  })
})

describe('V3–V7: check', () => {
  test("the vectors' knock, on a chain that holds its records and binding", async () => {
    expect(await check(site(), VECTOR, NOW)).toEqual({
      name: NAME,
      key: KEY,
      keyHash: V.key.keyHash,
      nullifier: NULLIFIER,
      counter: 42,
      origin: ORIGIN,
      binding: { tx: POH, block: 500, provedAt: PROVED },
    })
  })

  test('for another site: the digest is made with our own origin', async () => {
    expect(await no(check(site({ origin: 'https://other.example' }), VECTOR, NOW))).toBe('2 wrong_origin')
  })

  test('V3: the name and its records', async () => {
    const none = records({ v: null, key: null, status: null, nullifier: null, poh: null })
    expect(await no(check(site({ chain: chain({ latest: none }) }), VECTOR, NOW))).toBe('3 no_name')
    expect(await no(check(site({ chain: chain({ latest: records({ v: '2' }) }) }), VECTOR, NOW))).toBe('3 not_knock')
    expect(await no(check(site({ chain: chain({ deep: records({ status: 'off' }) }) }), VECTOR, NOW))).toBe(
      '3 records_changing',
    )
    expect(await no(check(site({ chain: chain({ latest: records({ status: 'off' }) }) }), VECTOR, NOW))).toBe('3 not_active')
    expect(await no(check(site({ chain: chain({ latest: records({ key: '0x02zz' }) }) }), VECTOR, NOW))).toBe('3 bad_records')
    expect(await no(check(site({ chain: chain({ latest: records({ poh: POH }) }) }), VECTOR, NOW))).toBe('3 bad_records')
  })

  test('V3: a key seen revoked stays revoked, though its records say active again', async () => {
    const memory = memoryStore()
    expect(await no(check(site({ memory, chain: chain({ latest: records({ status: 'revoked' }) }) }), VECTOR, NOW))).toBe(
      '3 revoked',
    )
    expect(await no(check(site({ memory }), VECTOR, NOW))).toBe('3 revoked')
  })

  test("V4: signed by the name's key, for these fields", async () => {
    expect(await no(check(site(), { ...VECTOR, counter: 43 }, NOW))).toBe('4 bad_signature')
    expect(await no(check(site(), { ...VECTOR, challenge: POH }, NOW))).toBe('4 bad_signature')
  })

  test("V5: the Wedgie's counter rises", async () => {
    const memory: Memory = { counter: async () => 42, revoke: async () => {}, isRevoked: async () => false }
    expect(await no(check(site({ memory }), VECTOR, NOW))).toBe('5 replayed')
    expect((await check(site({ memory }), knock({ counter: 43 }), NOW)).counter).toBe(43)
  })

  test("V6 and V7: Bound, this human's, on Knock's KnockBinding", async () => {
    expect(await no(check(site(), knock({ mode: 2 }), NOW))).toBe('7 mode_unsupported')
    expect(await no(check(site(), knock({ humanRef: POH }), NOW))).toBe('6 bad_assertion')
    const other = `0x${'01'.repeat(32)}` as Hex
    expect(await no(check(site({ chain: chain({ latest: records({ nullifier: other }) }) }), VECTOR, NOW))).toBe('6 wrong_human')
    expect(await no(check(site({ chain: chain({ receipt: null }) }), VECTOR, NOW))).toBe('6 no_binding')
    expect(await no(check(site({ chain: chain({ receipt: { ok: false, block: 500, logs: [bound()] } }) }), VECTOR, NOW))).toBe(
      '6 no_binding',
    )
    const elsewhere = { ok: true, block: 500, logs: [bound({ address: `0x${'11'.repeat(20)}` })] }
    expect(await no(check(site({ chain: chain({ receipt: elsewhere }) }), VECTOR, NOW))).toBe('6 no_binding')
    const otherKey = { ok: true, block: 500, logs: [bound({ keyHash: POH })] }
    expect(await no(check(site({ chain: chain({ receipt: otherKey }) }), VECTOR, NOW))).toBe('6 no_binding')
  })

  test("a network of one's own: its KnockBinding, not Knock's", async () => {
    const own = `0x${'22'.repeat(20)}` as Hex
    const receipt = { ok: true, block: 500, logs: [bound({ address: own })] }
    expect(await no(check(site({ chain: chain({ receipt }) }), VECTOR, NOW))).toBe('6 no_binding')
    expect((await check(site({ chain: chain({ receipt }), contract: own }), VECTOR, NOW)).binding.block).toBe(500)
  })

  test('V6: a binding older than a year, or than the site says, is expired', async () => {
    const old = { ok: true, block: 500, logs: [bound({ provedAt: PROVED - 365 * 86_400 })] }
    expect(await no(check(site({ chain: chain({ receipt: old }) }), VECTOR, NOW))).toBe('6 binding_expired')
    const month = { ok: true, block: 500, logs: [bound({ provedAt: Math.floor(NOW / 1000) - 31 * 86_400 })] }
    expect((await check(site({ chain: chain({ receipt: month }) }), VECTOR, NOW)).counter).toBe(42)
    expect(await no(check(site({ chain: chain({ receipt: month }), maxBindingDays: 30 }), VECTOR, NOW))).toBe('6 binding_expired')
  })

  test('a strict site waits for World Chain to post the binding to Ethereum (D26)', async () => {
    expect(await no(check(site({ strict: 'safe' }), VECTOR, NOW))).toBe('6 binding_not_final')
    expect((await check(site({ strict: 'finalized', chain: chain({ final: 600 }) }), VECTOR, NOW)).counter).toBe(42)
    expect([undefined, 'off', 'NO', 'on', 'true', 'safe', 'finalized'].map(strictFrom)).toEqual([
      'off',
      'off',
      'off',
      'safe',
      'safe',
      'safe',
      'finalized',
    ])
    expect(() => strictFrom('always')).toThrow()
  })

  test("a chain that can't be read: nothing is known, so the knock isn't taken, and its URL isn't told", async () => {
    try {
      await check(site({ chain: chain({ down: true }) }), VECTOR, NOW)
      throw new Error('let in')
    } catch (e) {
      expect(e).toBeInstanceOf(Refusal)
      expect((e as Refusal).toJSON()).toEqual({
        ok: false,
        check: 3,
        error: 'unavailable',
        why: "couldn't read the chain, try again: fetch failed: <url>",
      })
    }
  })

  test('deep records are kept a minute while the latest block shows the same', async () => {
    const c = chain()
    await check(site({ chain: c }), VECTOR, NOW)
    await check(site({ chain: c }), knock({ counter: 43 }), NOW + 1000)
    expect(c.reads).toBe(3)
    await check(site({ chain: c }), knock({ counter: 44 }), NOW + CACHE_MS + 2000)
    expect(c.reads).toBe(5)
  })
})

const stores: [string, () => Store][] = [
  ['in memory', memoryStore],
  ['in libSQL', () => libsqlStore(createClient({ url: ':memory:' }))],
]

for (const [where, makeStore] of stores)
  describe(`Verifier, V1–V8, with what it remembers ${where}`, () => {
    const verifier = (store = makeStore(), c: Chain = chain()) => new Verifier({ origin: ORIGIN, chain: c, store })

    test('a challenge, a knock for it, and what the knock used up', async () => {
      const v = verifier()
      const c = await v.challenge(NOW)
      expect(c).toMatchObject({ origin: ORIGIN, expiresAt: NOW + CHALLENGE_MS })
      expect((await v.verify(knock({ challenge: c.challenge }), { now: NOW + 1 })).counter).toBe(42)
      expect(await no(v.verify(knock({ challenge: c.challenge, counter: 43 }), { now: NOW + 2 }))).toBe('2 bad_challenge')
      const again = await v.challenge(NOW + 3)
      expect(await no(v.verify(knock({ challenge: again.challenge }), { now: NOW + 4 }))).toBe('5 replayed')
      expect((await v.verify(knock({ challenge: again.challenge, counter: 43 }), { now: NOW + 5 })).counter).toBe(43)
    })

    test('a challenge it never gave out, one given for another origin, and one expired', async () => {
      const store = makeStore()
      const v = verifier(store)
      expect(await no(v.verify(knock({ challenge: POH }), { now: NOW }))).toBe('2 bad_challenge')
      const theirs = await new Verifier({ origin: 'http://localhost:3001', chain: chain(), store }).challenge(NOW)
      expect(await no(v.verify(knock({ challenge: theirs.challenge }), { now: NOW }))).toBe('2 wrong_origin')
      const c = await v.challenge(NOW)
      expect(await no(v.verify(knock({ challenge: c.challenge }), { now: NOW + CHALLENGE_MS + 1 }))).toBe('2 bad_challenge')
    })

    test('V8: one entry for each human, for each action', async () => {
      const v = verifier()
      const go = async (counter: number, action: string) =>
        v.verify(knock({ challenge: (await v.challenge(NOW)).challenge, counter }), { action, now: NOW })
      expect((await go(42, 'signup')).nullifier).toBe(NULLIFIER)
      expect(await no(go(43, 'signup'))).toBe('8 already_entered')
      expect((await go(44, 'vote')).counter).toBe(44)
    })

    test('a refused knock uses up nothing', async () => {
      const store = makeStore()
      const old = { ok: true, block: 500, logs: [bound({ provedAt: PROVED - 400 * 86_400 })] }
      const c = await verifier(store).challenge(NOW)
      expect(await no(verifier(store, chain({ receipt: old })).verify(knock({ challenge: c.challenge }), { action: 'signup', now: NOW }))).toBe(
        '6 binding_expired',
      )
      expect((await verifier(store).verify(knock({ challenge: c.challenge }), { action: 'signup', now: NOW })).counter).toBe(42)
    })

    test('what a commit checks again as it writes', async () => {
      const store = makeStore()
      const key = KEY
      const c = await verifier(store).challenge(NOW)
      const commit = (over: object) =>
        store.commit({ challenge: c.challenge, origin: ORIGIN, key, counter: 42, entry: null, now: NOW, ...over })
      expect(await commit({ origin: 'https://other.example' })).toBe('challenge')
      expect(await commit({ now: NOW + CHALLENGE_MS + 1 })).toBe('challenge')
      expect(await commit({ entry: { action: 'a', nullifier: NULLIFIER, name: NAME } })).toBe(null)
      expect(await commit({ counter: 43 })).toBe('challenge')
      const d = await verifier(store).challenge(NOW)
      expect(await store.commit({ challenge: d.challenge, origin: ORIGIN, key, counter: 42, entry: null, now: NOW })).toBe('counter')
      expect(
        await store.commit({ challenge: d.challenge, origin: ORIGIN, key, counter: 43, entry: { action: 'a', nullifier: NULLIFIER, name: NAME }, now: NOW }),
      ).toBe('entry')
      expect(await store.counter(key)).toBe(42)
      expect(await store.entered('a', NULLIFIER)).toBe(true)
    })
  })

test('two knocks racing for one challenge: one gets in', async () => {
  const v = new Verifier({ origin: ORIGIN, chain: chain(), store: memoryStore() })
  const c = await v.challenge(NOW)
  const results = await Promise.allSettled([
    v.verify(knock({ challenge: c.challenge, counter: 42 }), { now: NOW }),
    v.verify(knock({ challenge: c.challenge, counter: 43 }), { now: NOW }),
  ])
  expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
  const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
  expect(`${lost.reason.check} ${lost.reason.error}`).toBe('2 bad_challenge')
})

test("a site's origin is one browsers write", () => {
  expect(() => new Verifier({ origin: 'bouncer.example', store: memoryStore() })).toThrow()
  expect(() => new Verifier({ origin: 'http://localhost:3001', store: memoryStore() })).not.toThrow()
})

test("KNOCK_BINDING is the deployments' production KnockBinding v3", () => {
  const d = read('../../../contracts/deployments/480.json')
  expect(d.production.version).toBe(3)
  expect(KNOCK_BINDING.toLowerCase()).toBe(d.production.KnockBinding.toLowerCase())
})
