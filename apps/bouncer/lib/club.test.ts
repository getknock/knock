import { describe, expect, test } from 'bun:test'
import { keccak256, toHex } from 'viem'
import {
  Declined,
  GIFT_HOLD_MS,
  HOLD_MS,
  type Outcome,
  type SeenTx,
  apply,
  askGift,
  before,
  endSession,
  fundraiser,
  fundraisers,
  giftsTo,
  hold,
  memory,
  mine,
  mineFunds,
  petition,
  petitions,
  sessionOf,
  signatures,
  startSession,
  take,
  takeGift,
  totals,
} from './club'
import { type Db, all, open } from './db'
import { type Intent, cleanText, eth, goalOf, readIntent } from './intent'
import { type Knocked, Refusal } from '@knock-dev/verify'

const T0 = Date.UTC(2026, 10, 6, 9, 0)
const HOUR = 3600_000
const hex = (b: string) => `0x${b.repeat(32)}` as `0x${string}`

const counters = new Map<string, number>()

/** A knock the verifier let in, for a human (by nullifier) and one of their Wedgies (by name, which picks its key),
 *  at that Wedgie's next counter */
function knocked(human: string, name: string, counter?: number): Knocked {
  const key = `0x02${keccak256(toHex(name)).slice(2)}` as `0x${string}`
  const n = counter ?? (counters.get(key) ?? 0) + 1
  counters.set(key, n)
  return {
    name,
    key,
    keyHash: keccak256(key),
    nullifier: hex(human),
    counter: n,
    origin: 'http://localhost:3001',
    binding: { tx: hex('cd'), block: 37_301_500, provedAt: 0 },
  }
}

const start: Intent = {
  act: 'start',
  title: 'Put benches back in the park',
  target: 'The parks department',
  body: 'The benches along the river path went in the spring. Put them back before the winter.',
  listed: true,
}

/** What the act came to: done, or the club's no by its code, or the verifier's by its check */
async function no(p: Promise<unknown>): Promise<string> {
  try {
    const r = (await p) as Outcome | undefined
    if (r && typeof r === 'object' && 'ok' in r && r.ok === false) return r.declined.error
  } catch (e) {
    if (e instanceof Declined) return e.error
    if (e instanceof Refusal) return `check ${e.check}`
    throw e
  }
  throw new Error('not declined')
}

async function done(p: Promise<Outcome>) {
  const r = await p
  if (!r.ok) throw new Error(`declined: ${r.declined.error}`)
  return r.done
}

const club = (): Promise<Db> => open(':memory:')

describe('acts, as the page sends them', () => {
  test('a petition, trimmed, with its title and target on one line', () => {
    const i = readIntent({ ...start, title: '  Put   benches\nback  ', target: ' The parks\tdepartment ' })
    expect(i).toMatchObject({ act: 'start', title: 'Put benches back', target: 'The parks department', listed: true })
  })

  test('too short, too long, or hiding characters: why not, in words', () => {
    expect(readIntent({ ...start, title: 'Benches' })).toEqual({ why: 'The title needs at least 8 characters.' })
    expect(readIntent({ ...start, body: 'x'.repeat(3001) })).toEqual({ why: 'What it asks can be 3000 characters at most; it has 3001.' })
    expect(readIntent({ ...start, title: 'Benches ‮back in the park' })).toEqual({
      why: "The title has a character the club doesn't take.",
    })
    expect(readIntent({ act: 'sign', petition: 1, reason: 'y'.repeat(281) })).toMatchObject({ why: expect.any(String) })
    expect(readIntent({ act: 'sign', petition: 0 })).toEqual({ why: 'No such petition.' })
    expect(readIntent({ act: 'close', petition: 3, outcome: 'deleted' })).toMatchObject({ why: expect.any(String) })
    expect(readIntent({ act: 'transfer' })).toMatchObject({ why: expect.any(String) })
  })

  test('a reason is optional, and showing your name is a yes only when it says so', () => {
    expect(readIntent({ act: 'sign', petition: 2 })).toEqual({ act: 'sign', petition: 2, listed: false, reason: '' })
    expect(readIntent({ act: 'sign', petition: 2, listed: 'yes' })).toMatchObject({ listed: false })
  })

  test('text keeps its paragraphs, but not a wall of blank lines', () => {
    expect(cleanText('one\r\n\r\n\r\n\r\ntwo  \nthree')).toBe('one\n\ntwo\nthree')
  })

  test('the goal: the next milestone up', () => {
    expect([0, 9, 10, 99, 100, 2499, 100_000].map(goalOf)).toEqual([10, 10, 25, 100, 250, 2500, 200_000])
  })
})

describe('challenges, each for one act', () => {
  test('taken once, for the act it was issued for', async () => {
    const db = await club()
    await hold(db, hex('AA'), start, T0)
    expect(await take(db, hex('aa'), T0 + 1000)).toEqual(start)
    expect(await take(db, hex('aa'), T0 + 2000)).toBe(null)
  })

  test('not after it has been held too long, nor one never issued', async () => {
    const db = await club()
    await hold(db, hex('aa'), { act: 'in' }, T0)
    expect(await take(db, hex('aa'), T0 + HOLD_MS + 1)).toBe(null)
    expect(await take(db, hex('bb'), T0)).toBe(null)
  })
})

describe('what a knock uses up', () => {
  test("the Wedgie's counter rises with each knock taken (V5), and a replay of one taken is turned down", async () => {
    const db = await club()
    const k = knocked('11', 'a.eth', 5)
    await done(apply(db, { act: 'in' }, k, T0))
    expect(await memory(db).counter(k.key)).toBe(5)
    expect(await no(apply(db, { act: 'in' }, k, T0 + 1))).toBe('check 5')
    expect(await no(apply(db, { act: 'in' }, knocked('11', 'a.eth', 4), T0 + 1))).toBe('check 5')
    await done(apply(db, { act: 'in' }, knocked('11', 'a.eth', 6), T0 + 2))
  })

  test('a V8 no uses up nothing; any other no keeps the counter, and the human is in', async () => {
    const db = await club()
    await done(apply(db, start, knocked('11', 'a.eth', 1), T0))
    expect(await no(apply(db, start, knocked('11', 'a.eth', 2), T0 + 1))).toBe('check 8')
    expect(await memory(db).counter(knocked('11', 'a.eth', 0).key)).toBe(1)
    expect(await no(apply(db, { act: 'sign', petition: 9, listed: true, reason: '' }, knocked('44', 'new.eth', 3), T0))).toBe('no_petition')
    expect(await memory(db).counter(knocked('44', 'new.eth', 0).key)).toBe(3)
    expect((await totals(db)).humans).toBe(2)
  })

  test('a key seen revoked stays revoked', async () => {
    const db = await club()
    const m = memory(db)
    expect(await m.isRevoked(hex('ab'))).toBe(false)
    await m.revoke(hex('ab'), T0)
    await m.revoke(hex('ab'), T0 + 1)
    expect(await m.isRevoked(hex('ab'))).toBe(true)
  })
})

describe('petitions and signatures', () => {
  test('starting one: its starter signs it, shown as they chose', async () => {
    const db = await club()
    expect(await done(apply(db, start, knocked('11', 'wedgie.itzraj.eth'), T0))).toEqual({ act: 'start', petition: 1 })
    expect(await petition(db, 1, T0)).toMatchObject({ title: start.title, starterName: 'wedgie.itzraj.eth', count: 1, status: 'open' })

    expect(await done(apply(db, { ...start, listed: false }, knocked('22', 'rpi.itzraj.eth'), T0))).toEqual({ act: 'start', petition: 2 })
    expect((await petition(db, 2, T0))?.starterName).toBe(null)
    expect(await signatures(db, 2)).toEqual([{ name: null, reason: null, at: T0, counter: null, bindingTx: null, bindingBlock: null }])
  })

  test('one new petition a day for each human, whichever Wedgie knocks', async () => {
    const db = await club()
    await done(apply(db, start, knocked('11', 'a.itzraj.eth'), T0))
    expect(await no(apply(db, start, knocked('11', 'b.itzraj.eth'), T0 + HOUR))).toBe('check 8')
    expect(await done(apply(db, start, knocked('11', 'b.itzraj.eth'), T0 + 24 * HOUR))).toEqual({ act: 'start', petition: 2 })
  })

  test('one signature for each human: their other Wedgie is the same human', async () => {
    const db = await club()
    await done(apply(db, start, knocked('11', 'starter.eth'), T0))
    const sign = { act: 'sign', petition: 1, listed: true, reason: 'I walk there' } as const
    expect(await done(apply(db, sign, knocked('22', 'a.itzraj.eth', 7), T0 + 1))).toEqual({ act: 'sign', petition: 1, count: 2 })
    expect(await no(apply(db, { ...sign, listed: false, reason: '' }, knocked('22', 'b.itzraj.eth'), T0 + 2))).toBe('check 8')
    expect((await petition(db, 1, T0 + 3))?.count).toBe(2)
    expect((await signatures(db, 1))[0]).toEqual({
      name: 'a.itzraj.eth',
      reason: 'I walk there',
      at: T0 + 1,
      counter: 7,
      bindingTx: hex('cd'),
      bindingBlock: 37_301_500,
    })
  })

  test("nothing the club shows names a human's nullifier", async () => {
    const db = await club()
    await done(apply(db, start, knocked('11', 'starter.eth'), T0))
    await done(apply(db, { act: 'sign', petition: 1, listed: false, reason: '' }, knocked('22', 'quiet.eth'), T0 + 1))
    const shown = JSON.stringify([await petitions(db, T0), await petition(db, 1, T0), await signatures(db, 1), await totals(db)])
    expect(shown).not.toContain(hex('11'))
    expect(shown).not.toContain(hex('22'))
    expect(shown).not.toContain('quiet.eth')
    expect(shown).not.toContain('nullifier')
  })

  test('only its starter closes it, with any of their Wedgies, and once', async () => {
    const db = await club()
    await done(apply(db, start, knocked('11', 'a.itzraj.eth'), T0))
    expect(await no(apply(db, { act: 'close', petition: 1, outcome: 'won' }, knocked('22', 'x.eth'), T0 + 1))).toBe('not_yours')
    expect(await done(apply(db, { act: 'close', petition: 1, outcome: 'won' }, knocked('11', 'b.itzraj.eth'), T0 + 2))).toEqual({
      act: 'close',
      petition: 1,
      outcome: 'won',
    })
    expect(await petition(db, 1, T0 + 3)).toMatchObject({ status: 'won', statusAt: T0 + 2 })
    expect(await no(apply(db, { act: 'close', petition: 1, outcome: 'closed' }, knocked('11', 'a.itzraj.eth'), T0 + 4))).toBe('closed')
    expect(await no(apply(db, { act: 'sign', petition: 1, listed: true, reason: '' }, knocked('33', 'late.eth'), T0 + 5))).toBe('closed')
  })

  test('before the knock: what the club can say no to without one', async () => {
    const db = await club()
    await done(apply(db, start, knocked('11', 'a.eth'), T0))
    const me = hex('11')
    expect(await no(before(db, { act: 'sign', petition: 1, listed: true, reason: '' }, me))).toBe('signed')
    expect(await no(before(db, { act: 'close', petition: 1, outcome: 'won' }, hex('22')))).toBe('not_yours')
    expect(await no(before(db, { act: 'sign', petition: 5, listed: true, reason: '' }, null))).toBe('no_petition')
    expect(await before(db, { act: 'sign', petition: 1, listed: true, reason: '' }, null)).toBeUndefined()
    expect(await before(db, { act: 'close', petition: 1, outcome: 'won' }, me)).toBeUndefined()
  })

  test('the list: open ones signed most this week first, closed ones after', async () => {
    const db = await club()
    await done(apply(db, start, knocked('11', 'a.eth'), T0))
    await done(apply(db, { ...start, title: 'Light the underpass at night' }, knocked('22', 'b.eth'), T0))
    await done(apply(db, { ...start, title: 'Keep the library open on Sundays' }, knocked('33', 'c.eth'), T0))
    for (const h of ['44', '55'])
      await done(apply(db, { act: 'sign', petition: 2, listed: false, reason: '' }, knocked(h, `${h}.eth`), T0 + 1))
    await done(apply(db, { act: 'close', petition: 3, outcome: 'won' }, knocked('33', 'c.eth'), T0 + 2))
    expect((await petitions(db, T0 + 3)).map((p) => p.id)).toEqual([2, 1, 3])
    expect((await petitions(db, T0 + 3, 'new')).map((p) => p.id)).toEqual([3, 2, 1])
    expect(await totals(db)).toEqual({ petitions: 3, signatures: 5, humans: 5, won: 1, fundraisers: 0, raised: '0' })
  })

  test('your page: what you started, named or not, and what you signed', async () => {
    const db = await club()
    await done(apply(db, { ...start, listed: false }, knocked('11', 'a.eth'), T0))
    await done(apply(db, { ...start, title: 'Light the underpass at night' }, knocked('22', 'b.eth'), T0))
    await done(apply(db, { act: 'sign', petition: 2, listed: false, reason: '' }, knocked('11', 'other.eth'), T0 + 1))
    const m = await mine(db, hex('11'), T0 + 2)
    expect(m.started.map((p) => p.id)).toEqual([1])
    expect(m.signed.map((p) => [p.id, p.signedAs, p.signedAt])).toEqual([[2, null, T0 + 1]])
  })
})

describe('sessions', () => {
  test('a knock that got in keeps you in; the club keeps only a hash of the token', async () => {
    const db = await club()
    await done(apply(db, { act: 'in' }, knocked('11', 'a.eth'), T0))
    const token = await startSession(db, hex('11'), T0)
    expect(await sessionOf(db, token, T0 + HOUR)).toMatchObject({ nullifier: hex('11'), name: 'a.eth', knocks: 1 })
    expect(JSON.stringify(await all(db, 'SELECT * FROM sessions'))).not.toContain(token)
    expect(await sessionOf(db, `${token}x`, T0)).toBe(null)
    expect(await sessionOf(db, token, T0 + 15 * 24 * HOUR)).toBe(null)
    await endSession(db, token)
    expect(await sessionOf(db, token, T0 + HOUR)).toBe(null)
  })
})

const WALLET = `0x${'5a'.repeat(20)}`
const raise: Intent = {
  act: 'raise',
  title: 'A new roof for the community hall',
  story: 'The hall on Mill Street leaks every time it rains. The roofer quoted 2 ETH for the whole job, materials included.',
  goal: '2',
}
const ETH = 10n ** 18n

describe('fundraisers, as the page sends them', () => {
  test('a goal in ETH as people type it, kept in ETH', () => {
    expect(readIntent({ ...raise, goal: ' 2.50 ' })).toMatchObject({ act: 'raise', goal: '2.5' })
    expect(readIntent({ ...raise, goal: '0.0001' })).toEqual({ why: 'The goal is at least 0.001 ETH.' })
    expect(readIntent({ ...raise, goal: '1e3' })).toEqual({ why: 'The goal is an amount of ETH, such as 0.5.' })
    expect(readIntent({ ...raise, goal: '5000' })).toEqual({ why: 'The goal is at most 1000 ETH.' })
  })

  test('ETH for people', () => {
    expect([0n, 1n, ETH / 2n, 2n * ETH + 123_456_789n, 1234n * 10n ** 14n].map(eth)).toEqual(['0', '<0.0001', '0.5', '2', '0.1234'])
  })
})

describe('fundraisers and gifts', () => {
  const started = (db: Db) => done(apply(db, raise, knocked('11', 'wedgie.itzraj.eth'), T0, WALLET))
  const seen = (value: string, over: Partial<SeenTx> = {}): SeenTx => ({
    to: WALLET,
    from: `0x${'77'.repeat(20)}`,
    value: BigInt(value),
    ok: true,
    block: 24_000_000,
    ...over,
  })

  test("a fundraiser goes to its starter's Wedgie name, and the wallet it resolves to", async () => {
    const db = await club()
    expect(await started(db)).toEqual({ act: 'raise', fundraiser: 1 })
    expect(await fundraiser(db, 1, T0)).toMatchObject({
      name: 'wedgie.itzraj.eth',
      payout: WALLET,
      goal: (2n * ETH).toString(),
      raised: '0',
      status: 'open',
    })
    expect(await no(apply(db, raise, knocked('22', 'nowhere.eth'), T0, null))).toBe('no_wallet')
    expect(await no(apply(db, raise, knocked('11', 'other.itzraj.eth'), T0 + HOUR, WALLET))).toBe('check 8')
  })

  test('a gift: its reference rides in the last wei, and it counts once mainnet shows exactly it', async () => {
    const db = await club()
    await started(db)
    const a = await askGift(db, 1, ETH / 10n, { human: null, message: 'Good luck', showFrom: true }, T0)
    expect(a.to).toBe(WALLET)
    const extra = BigInt(a.value) - ETH / 10n
    expect(extra > 0n && extra < 1_000_000n).toBe(true)

    expect(await no(takeGift(db, a.ref, hex('e1'), null, T0))).toBe('not_seen')
    expect(await no(takeGift(db, a.ref, hex('e1'), seen(a.value, { ok: false }), T0))).toBe('failed')
    expect(await no(takeGift(db, a.ref, hex('e1'), seen(a.value, { to: `0x${'66'.repeat(20)}` }), T0))).toBe('elsewhere')
    expect(await no(takeGift(db, a.ref, hex('e1'), seen((ETH / 10n).toString()), T0))).toBe('amount')
    expect(await takeGift(db, a.ref, hex('e1'), seen(a.value), T0 + 1)).toEqual({ fundraiser: 1, value: a.value })
    expect(await no(takeGift(db, a.ref, hex('e1'), seen(a.value), T0 + 2))).toBe('taken')
    expect(await fundraiser(db, 1, T0 + 2)).toMatchObject({ gifts: 1, humans: 0 })
  })

  test("someone else's transaction can't be claimed as your gift", async () => {
    const db = await club()
    await started(db)
    await done(apply(db, { act: 'in' }, knocked('99', 'mallory.eth'), T0))
    const alice = await askGift(db, 1, ETH, { human: null, message: '', showFrom: false }, T0)
    const mallory = await askGift(db, 1, ETH, { human: hex('99'), message: '', showFrom: false }, T0)
    expect(mallory.value).not.toBe(alice.value)
    // Alice's transaction, claimed by Mallory's gift: the amount gives it away
    expect(await no(takeGift(db, mallory.ref, hex('a1'), seen(alice.value), T0))).toBe('amount')
    await takeGift(db, alice.ref, hex('a1'), seen(alice.value), T0)
    // And a transaction is one gift only
    const again = await askGift(db, 1, ETH, { human: null, message: '', showFrom: false }, T0)
    expect(await no(takeGift(db, again.ref, hex('a1'), seen(again.value), T0))).toBe('taken')
  })

  test('given in a human session, each human counts once; a hidden giver shows no address or transaction', async () => {
    const db = await club()
    await started(db)
    const human = hex('33')
    await done(apply(db, { act: 'in' }, knocked('33', 'giver.eth'), T0))
    for (const [i, h] of [
      [1, human],
      [2, human],
      [3, null],
    ] as const) {
      const g = await askGift(db, 1, ETH / 4n, { human: h, message: i === 1 ? 'For the roof' : '', showFrom: i !== 2 }, T0)
      await takeGift(db, g.ref, hex(`b${i}`), seen(g.value, { from: `0x${String(i).repeat(40)}` }), T0 + i)
    }
    const f = await fundraiser(db, 1, T0 + 5)
    expect(f).toMatchObject({ gifts: 3, humans: 1 })
    expect(BigInt(f?.raised ?? 0) / 10n ** 9n).toBe((3n * ETH) / 4n / 10n ** 9n)
    const list = await giftsTo(db, 1)
    expect(list.map((g) => [g.from !== null, g.tx !== null, g.human])).toEqual([
      [true, true, false],
      [false, false, true],
      [true, true, true],
    ])
    expect(list[2].message).toBe('For the roof')
    expect(JSON.stringify([list, f, await fundraisers(db, T0)])).not.toContain(human)
    expect((await mineFunds(db, human, T0 + 5)).gave.length).toBe(2)
    expect((await mineFunds(db, hex('11'), T0 + 5)).started.map((x) => x.id)).toEqual([1])
  })

  test('closed: only by its starter, with any of their Wedgies, and no gifts asked after', async () => {
    const db = await club()
    await started(db)
    const sent = await askGift(db, 1, ETH, { human: null, message: '', showFrom: true }, T0)
    expect(await no(apply(db, { act: 'stop', fundraiser: 1 }, knocked('22', 'x.eth'), T0))).toBe('not_yours')
    expect(await no(before(db, { act: 'stop', fundraiser: 1 }, hex('22')))).toBe('not_yours')
    expect(await done(apply(db, { act: 'stop', fundraiser: 1 }, knocked('11', 'rpi.itzraj.eth'), T0 + 1))).toEqual({
      act: 'stop',
      fundraiser: 1,
    })
    expect(await no(askGift(db, 1, ETH, { human: null, message: '', showFrom: true }, T0 + 2))).toBe('closed')
    // A gift already on its way when it closed still comes in
    expect(await takeGift(db, sent.ref, hex('c1'), seen(sent.value), T0 + 3)).toMatchObject({ fundraiser: 1 })
  })

  test('a gift that never came is let go after an hour', async () => {
    const db = await club()
    await started(db)
    const g = await askGift(db, 1, ETH, { human: null, message: '', showFrom: true }, T0)
    await askGift(db, 1, ETH, { human: null, message: '', showFrom: true }, T0 + GIFT_HOLD_MS + 1)
    expect(await no(takeGift(db, g.ref, hex('d1'), seen(g.value), T0 + GIFT_HOLD_MS + 2))).toBe('no_gift')
  })

  test('the totals count ETH raised', async () => {
    const db = await club()
    await started(db)
    const g = await askGift(db, 1, ETH, { human: null, message: '', showFrom: true }, T0)
    await takeGift(db, g.ref, hex('f1'), seen(g.value), T0)
    expect(await totals(db)).toMatchObject({ fundraisers: 1 })
    expect(BigInt((await totals(db)).raised) / 10n ** 9n).toBe(BigInt(g.value) / 10n ** 9n)
  })
})
