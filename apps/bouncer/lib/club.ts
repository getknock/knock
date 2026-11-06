/**
 * The Human Club's records (D32): humans, petitions and signatures, fundraisers and gifts, sessions, and the act
 * each challenge was issued for. They're keyed by the human's nullifier, so one human is one signer, whichever of
 * their Wedgies knocks, and whether they knock or come in with World ID and a wallet (D35): that way proves Knock's
 * own action, so it gives the same nullifier. The club shows a human's name (their Wedgie's, or their wallet's ENS
 * name or address) where they chose to show it, and a fundraiser's always, since its gifts go to that wallet. It
 * shows nothing else about anyone: no nullifier, and no key or binding of a signer who stayed unnamed.
 */
import { createHash, randomBytes } from 'node:crypto'
import { parseEther } from 'viem'
import { type Db, type Exec, type Tx, all, inTx, one, run, unique } from './db'
import { type Intent, dayOf } from './intent'
import { type Knocked, type Memory, Refusal } from '@knock-dev/verify'
import type { Hex } from 'viem'

/** The club's no to an act, before the knock or after it passed */
export class Declined extends Error {
  constructor(
    readonly error: string,
    why: string,
  ) {
    super(why)
  }
}

/** How long a challenge's act is held: the Wedgie waits two minutes for a press, the Door as long */
export const HOLD_MS = 5 * 60_000

/** The act a challenge was issued for, until the knock that answers it comes back */
export async function hold(db: Db, challenge: string, intent: Intent, now: number) {
  await db.batch(
    [
      { sql: 'DELETE FROM pending WHERE at < ?', args: [now - HOLD_MS] },
      { sql: 'INSERT INTO pending (challenge, intent, at) VALUES (?, ?, ?)', args: [challenge.toLowerCase(), JSON.stringify(intent), now] },
    ],
    'write',
  )
}

/** V2: the act a challenge was issued for, once. A knock can't be taken for another act, or twice. */
export async function take(db: Db, challenge: string, now: number): Promise<Intent | null> {
  const row = await one<{ intent: string; at: number }>(
    db,
    'DELETE FROM pending WHERE challenge = ? RETURNING intent, at',
    challenge.toLowerCase(),
  )
  if (!row || row.at < now - HOLD_MS) return null
  return JSON.parse(row.intent) as Intent
}

/** A World ID step the club waits on (D35): a wallet's sign-in, by its nonce; the wallet once it has signed in, by its
 *  cookie, while its visitor proves they're human; then World App's proof, by its request's nonce, for the act it was
 *  asked for: a human's first proof, for the key the club made them, or a proof of their session, for the club's
 *  challenge */
export type Held =
  | { step: 'wallet'; address: Hex; message: string }
  | { step: 'signed'; wallet: Hex; name: string }
  | { step: 'enroll'; intent: Intent; wallet: Hex; name: string; action: string; node: Hex; secret: Hex; key: Hex; signal: string }
  | { step: 'prove'; intent: Intent; wallet: Hex; name: string; session: string; challenge: Hex }

/** Held under its own prefix, so a knock can never answer a World ID step, nor a proof a knock's challenge. Holding
 *  a step again holds it anew, for as long again. */
export async function holdStep(db: Db, key: string, h: Held, now: number) {
  await db.batch(
    [
      { sql: 'DELETE FROM pending WHERE at < ?', args: [now - HOLD_MS] },
      {
        sql: `INSERT INTO pending (challenge, intent, at) VALUES (?, ?, ?)
              ON CONFLICT (challenge) DO UPDATE SET intent = excluded.intent, at = excluded.at`,
        args: [`w:${key.toLowerCase()}`, JSON.stringify(h), now],
      },
    ],
    'write',
  )
}

const fresh = <S extends Held['step']>(row: { intent: string; at: number } | null, steps: readonly S[], now: number) => {
  if (!row || row.at < now - HOLD_MS) return null
  const h = JSON.parse(row.intent) as Held
  return (steps as readonly string[]).includes(h.step) ? (h as Extract<Held, { step: S }>) : null
}

/** A held step, once, and only a step that was wanted: another stays held */
export async function takeStep<S extends Held['step']>(db: Db, key: string, steps: S | readonly S[], now: number) {
  const want: readonly S[] = typeof steps === 'string' ? [steps] : steps
  const row = await one<{ intent: string; at: number }>(
    db,
    `DELETE FROM pending WHERE challenge = ? AND json_extract(intent, '$.step') IN (${want.map(() => '?').join(', ')})
     RETURNING intent, at`,
    `w:${key.toLowerCase()}`,
    ...want,
  )
  return fresh(row, want, now)
}

/** A held step, left held: a wallet's sign-in lasts while its visitor tries World App again */
export async function readStep<S extends Held['step']>(db: Db, key: string, step: S, now: number) {
  const row = await one<{ intent: string; at: number }>(db, 'SELECT intent, at FROM pending WHERE challenge = ?', `w:${key.toLowerCase()}`)
  return fresh(row, [step], now)
}

/** What the verifier remembers, in the club's tables */
export const memory = (db: Db): Memory => ({
  counter: async (key) => (await one<{ counter: number }>(db, 'SELECT counter FROM counters WHERE key = ?', key))?.counter ?? null,
  revoke: async (key, now) => void (await run(db, 'INSERT OR IGNORE INTO revoked (key, seen_at) VALUES (?, ?)', key, now)),
  isRevoked: async (key) => (await one(db, 'SELECT 1 AS yes FROM revoked WHERE key = ?', key)) !== null,
})

type PetitionState = { status: string; starter: string }
const stateOf = (db: Exec, id: number) => one<PetitionState>(db, 'SELECT status, starter FROM petitions WHERE id = ?', id)

type FundState = { status: string; starter: string; payout: string }
const fundState = (db: Exec, id: number) =>
  one<FundState>(db, 'SELECT status, starter, payout FROM fundraisers WHERE id = ?', id)

export const signed = async (db: Exec, petition: number, nullifier: string) =>
  (await one(db, 'SELECT 1 AS yes FROM signatures WHERE petition = ? AND nullifier = ?', petition, nullifier)) !== null

/** What the club says no to before anyone presses: a petition or fundraiser that's gone or closed, one this human
 *  has signed or didn't start, as far as their session tells */
export async function before(db: Exec, i: Intent, me: string | null) {
  if (i.act === 'stop') {
    const f = await fundState(db, i.fundraiser)
    if (!f) throw new Declined('no_fundraiser', 'No such fundraiser.')
    if (f.status !== 'open') throw new Declined('closed', 'This fundraiser is closed.')
    if (me && me !== f.starter) throw new Declined('not_yours', 'Only the human who started this fundraiser can close it.')
    return
  }
  if (i.act !== 'sign' && i.act !== 'close') return
  const p = await stateOf(db, i.petition)
  if (!p) throw new Declined('no_petition', 'No such petition.')
  if (p.status !== 'open') throw new Declined('closed', 'This petition is closed.')
  if (i.act === 'sign' && me && (await signed(db, i.petition, me))) throw new Declined('signed', "You've signed this one already.")
  if (i.act === 'close' && me && me !== p.starter)
    throw new Declined('not_yours', 'Only the human who started this petition can close it.')
}

/** Who an act is by: a knock the verifier let in, or a World ID proof of a Knock session (D35) */
export type Actor = {
  /** The human: their nullifier for Knock's action, a 32-byte word in lowercase hex */
  nullifier: Hex
  /** Their Wedgie's name, or their wallet's ENS name or address */
  name: string
  /** What the act uses up, once: the Wedgie's counter (V5 again), or the World ID proof */
  spends: { key: string; counter: number; again: string }
  /** What a named signature shows of it: the knock and its binding. Nothing, for a proof. */
  shows: { counter: number; tx: Hex; block: number } | null
}

export const byKnock = (k: Knocked): Actor => ({
  nullifier: k.nullifier,
  name: k.name,
  spends: { key: k.key, counter: k.counter, again: "the Wedgie's counter didn't rise: a knock seen before" },
  shows: { counter: k.counter, tx: k.binding.tx, block: k.binding.block },
})

/** A World ID proof, used up by what it alone carries: a session proof's nullifier, or an enrollment's binding */
export const byProof = (nullifier: Hex, name: string, once: string): Actor => ({
  nullifier,
  name,
  spends: { key: `world:${once.toLowerCase()}`, counter: 1, again: 'this World ID proof was used before' },
  shows: null,
})

export type Done =
  | { act: 'in' }
  | { act: 'start'; petition: number }
  | { act: 'sign'; petition: number; count: number }
  | { act: 'close'; petition: number; outcome: 'won' | 'closed' }
  | { act: 'raise'; fundraiser: number }
  | { act: 'stop'; fundraiser: number }

/** What a knock the verifier let in came to: the act done, or declined with the human let in all the same */
export type Outcome = { ok: true; done: Done } | { ok: false; declined: Declined }

/** V8, once per human, in the club's words: a second signature, or a second new petition or fundraiser in a day */
const once = {
  sign: () => new Refusal(8, 'already_entered', 'This human has signed this petition already, with a Wedgie or with World ID.'),
  start: () => new Refusal(8, 'already_entered', 'One new petition a day for each human: start this one tomorrow.'),
  raise: () => new Refusal(8, 'already_entered', 'One new fundraiser a day for each human: start this one tomorrow.'),
}

/** The act's own rules, read in its transaction: a Refusal (V8) uses up nothing, a Declined lets the human in */
async function refusal(tx: Tx, i: Intent, me: string, now: number, payout: string | null | undefined) {
  switch (i.act) {
    case 'start':
      return (await one(tx, 'SELECT 1 AS yes FROM petitions WHERE starter = ? AND day = ?', me, dayOf(now))) ? once.start() : null
    case 'sign': {
      const p = await stateOf(tx, i.petition)
      if (!p) return new Declined('no_petition', 'No such petition.')
      if (p.status !== 'open') return new Declined('closed', 'This petition closed before your knock came in.')
      return (await signed(tx, i.petition, me)) ? once.sign() : null
    }
    case 'close': {
      const p = await stateOf(tx, i.petition)
      if (!p) return new Declined('no_petition', 'No such petition.')
      if (p.starter !== me) return new Declined('not_yours', 'Only the human who started this petition can close it.')
      if (p.status !== 'open') return new Declined('closed', 'This petition is closed already.')
      return null
    }
    case 'raise':
      if (!payout || !/^0x[0-9a-fA-F]{40}$/.test(payout))
        return new Declined('no_wallet', "Your name doesn't resolve to a wallet in ENS, so gifts would have nowhere to go.")
      return (await one(tx, 'SELECT 1 AS yes FROM fundraisers WHERE starter = ? AND day = ?', me, dayOf(now))) ? once.raise() : null
    case 'stop': {
      const f = await fundState(tx, i.fundraiser)
      if (!f) return new Declined('no_fundraiser', 'No such fundraiser.')
      if (f.starter !== me) return new Declined('not_yours', 'Only the human who started this fundraiser can close it.')
      if (f.status !== 'open') return new Declined('closed', 'This fundraiser is closed already.')
      return null
    }
    default:
      return null
  }
}

async function addSignature(tx: Tx, petition: number, k: Actor, listed: boolean, reason: string, now: number) {
  await run(
    tx,
    `INSERT INTO signatures (petition, nullifier, name, reason, at, counter, binding_tx, binding_block)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    petition,
    k.nullifier,
    listed ? k.name : null,
    reason || null,
    now,
    // A named signature shows the knock behind it; an unnamed one keeps nothing that leads to its Wedgie
    listed ? (k.shows?.counter ?? null) : null,
    listed ? (k.shows?.tx ?? null) : null,
    listed ? (k.shows?.block ?? null) : null,
  )
}

async function act(tx: Tx, i: Intent, k: Actor, now: number, payout: string | null | undefined): Promise<Done> {
  const me = k.nullifier
  switch (i.act) {
    case 'in':
      return { act: 'in' }
    case 'start': {
      const r = await one<{ id: number }>(
        tx,
        'INSERT INTO petitions (title, target, body, starter, starter_name, day, at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
        i.title,
        i.target,
        i.body,
        me,
        i.listed ? k.name : null,
        dayOf(now),
        now,
      )
      const id = Number(r?.id)
      // Its starter signs it, as on any petition site, shown as they chose
      await addSignature(tx, id, k, i.listed, '', now)
      return { act: 'start', petition: id }
    }
    case 'sign': {
      await addSignature(tx, i.petition, k, i.listed, i.reason, now)
      const n = await one<{ n: number }>(tx, 'SELECT count(*) AS n FROM signatures WHERE petition = ?', i.petition)
      return { act: 'sign', petition: i.petition, count: Number(n?.n) }
    }
    case 'close':
      await run(tx, 'UPDATE petitions SET status = ?, status_at = ? WHERE id = ?', i.outcome, now, i.petition)
      return { act: 'close', petition: i.petition, outcome: i.outcome }
    case 'raise': {
      const r = await one<{ id: number }>(
        tx,
        'INSERT INTO fundraisers (title, story, goal, starter, name, payout, day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
        i.title,
        i.story,
        parseEther(i.goal).toString(),
        me,
        k.name,
        (payout as string).toLowerCase(),
        dayOf(now),
        now,
      )
      return { act: 'raise', fundraiser: Number(r?.id) }
    }
    case 'stop':
      await run(tx, "UPDATE fundraisers SET status = 'closed', status_at = ? WHERE id = ?", now, i.fundraiser)
      return { act: 'stop', fundraiser: i.fundraiser }
  }
}

/**
 * The act, for a knock the verifier let in or a World ID proof the club checked, in one transaction with what it
 * uses up: the Wedgie's counter (V5 again, for two knocks racing) or the proof, and the human, met under the name
 * they came with. A V8 no rolls all of it back; any other no keeps what was used up and the human, so they're in
 * though the act isn't done. A fundraiser takes the wallet its starter's name resolves to, or the wallet they came
 * in with, from the caller (payout).
 */
export async function apply(db: Db, i: Intent, who: Knocked | Actor, now: number, payout?: string | null): Promise<Outcome> {
  const k = 'spends' in who ? who : byKnock(who)
  return inTx(db, async (tx) => {
    const kept = await run(
      tx,
      `INSERT INTO counters (key, counter) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET counter = excluded.counter WHERE counters.counter < excluded.counter`,
      k.spends.key,
      k.spends.counter,
    )
    if (kept.rowsAffected !== 1) throw new Refusal(5, 'replayed', k.spends.again)
    await run(
      tx,
      `INSERT INTO humans (nullifier, name, first_at, seen_at, knocks) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (nullifier) DO UPDATE SET name = excluded.name, seen_at = excluded.seen_at, knocks = knocks + 1`,
      k.nullifier,
      k.name,
      now,
      now,
    )
    const no = await refusal(tx, i, k.nullifier, now, payout)
    if (no instanceof Refusal) throw no
    if (no) return { ok: false, declined: no }
    try {
      return { ok: true, done: await act(tx, i, k, now, payout) }
    } catch (e) {
      // Read in this same transaction, so only a race lands here
      if (unique(e) && (i.act === 'sign' || i.act === 'start' || i.act === 'raise')) throw once[i.act]()
      throw e
    }
  })
}

/**
 * Gifts. A giver's wallet sends ETH straight to the fundraiser's wallet: the club never holds any. To know which
 * transaction is which gift, the club gives each gift a reference, carried in the amount's last wei (up to 999,999
 * wei, a millionth of a cent), and takes a gift once mainnet shows a transaction of exactly that amount, to that
 * wallet, that went through. A gift asked for in a human's session counts that human among those who gave.
 */
export const GIFT_HOLD_MS = 60 * 60_000
const REF_SPAN = 999_999n

/** A transaction as mainnet has it */
export type SeenTx = { to: string | null; from: string; value: bigint; ok: boolean; block: number }

export async function askGift(
  db: Db,
  fundraiser: number,
  amount: bigint,
  ask: { human: string | null; message: string; showFrom: boolean },
  now: number,
): Promise<{ ref: string; to: string; value: string }> {
  return inTx(db, async (tx) => {
    await run(tx, 'DELETE FROM gifts WHERE tx IS NULL AND asked_at < ?', now - GIFT_HOLD_MS)
    const f = await fundState(tx, fundraiser)
    if (!f) throw new Declined('no_fundraiser', 'No such fundraiser.')
    if (f.status !== 'open') throw new Declined('closed', 'This fundraiser is closed: it takes no more gifts here.')
    for (let tries = 0; tries < 8; tries++) {
      const ref = 1n + (BigInt(`0x${randomBytes(4).toString('hex')}`) % REF_SPAN)
      const value = amount - (amount % 1_000_000n) + ref
      if (await one(tx, 'SELECT 1 AS yes FROM gifts WHERE fundraiser = ? AND value = ?', fundraiser, value.toString())) continue
      const key = randomBytes(16).toString('hex')
      await run(
        tx,
        'INSERT INTO gifts (ref, fundraiser, value, gwei, human, message, show_from, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        key,
        fundraiser,
        value.toString(),
        Number(value / 1_000_000_000n),
        ask.human,
        ask.message || null,
        ask.showFrom ? 1 : 0,
        now,
      )
      return { ref: key, to: f.payout, value: value.toString() }
    }
    throw new Declined('busy', 'Too many gifts are on their way to this fundraiser: try again in a minute.')
  })
}

/** A gift, once mainnet shows its transaction: exactly its amount, to the fundraiser's wallet, gone through */
export async function takeGift(db: Db, ref: string, tx: string, seen: SeenTx | null, now: number) {
  const g = await one<{ fundraiser: number; value: string; tx: string | null; payout: string }>(
    db,
    'SELECT g.fundraiser, g.value, g.tx, f.payout FROM gifts g JOIN fundraisers f ON f.id = g.fundraiser WHERE g.ref = ?',
    ref,
  )
  if (!g) throw new Declined('no_gift', 'The club has no gift by that reference, or it waited too long for it.')
  if (g.tx) throw new Declined('taken', 'That gift is in already.')
  if (!seen) throw new Declined('not_seen', 'Mainnet has no such transaction yet. Wait for it to be mined, then try again.')
  if (!seen.ok) throw new Declined('failed', 'That transaction failed on chain, so no ETH moved.')
  if (seen.to?.toLowerCase() !== g.payout) throw new Declined('elsewhere', "That transaction went to another address than this fundraiser's.")
  if (seen.value !== BigInt(g.value)) throw new Declined('amount', "That transaction's amount isn't this gift's.")
  try {
    await run(
      db,
      'UPDATE gifts SET tx = ?, from_address = ?, block = ?, given_at = ? WHERE ref = ? AND tx IS NULL',
      tx.toLowerCase(),
      seen.from.toLowerCase(),
      seen.block,
      now,
      ref,
    )
  } catch (e) {
    if (unique(e)) throw new Declined('taken', 'That transaction is another gift already.')
    throw e
  }
  return { fundraiser: Number(g.fundraiser), value: g.value }
}

/** Sessions: a knock that got in keeps you in for two weeks. The cookie holds the token; the club, its hash only. A
 *  session that came in with World ID also keeps its wallet and its World ID session, which each act proves (D35). */
export const SESSION_MS = 14 * 24 * 3600_000
export const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')

/** How a session came in with World ID: the wallet that signed in, and the World ID session its acts prove */
export type WorldIn = { wallet: string; session: string }

export async function startSession(db: Db, nullifier: string, now: number, world?: WorldIn): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.batch(
    [
      { sql: 'DELETE FROM world_sessions WHERE token IN (SELECT token FROM sessions WHERE expires_at < ?)', args: [now] },
      { sql: 'DELETE FROM sessions WHERE expires_at < ?', args: [now] },
      {
        sql: 'INSERT INTO sessions (token, nullifier, at, expires_at) VALUES (?, ?, ?, ?)',
        args: [hashOf(token), nullifier.toLowerCase(), now, now + SESSION_MS],
      },
      ...(world
        ? [{ sql: 'INSERT INTO world_sessions (token, wallet, session) VALUES (?, ?, ?)', args: [hashOf(token), world.wallet.toLowerCase(), world.session] }]
        : []),
    ],
    'write',
  )
  return token
}

export type Me = { nullifier: string; name: string; firstAt: number; knocks: number; wallet: string | null; world: string | null }

export async function sessionOf(db: Db, token: string | undefined, now: number): Promise<Me | null> {
  if (!token) return null
  return one<Me>(
    db,
    `SELECT h.nullifier, h.name, h.first_at AS firstAt, h.knocks, w.wallet, w.session AS world
     FROM sessions s JOIN humans h ON h.nullifier = s.nullifier LEFT JOIN world_sessions w ON w.token = s.token
     WHERE s.token = ? AND s.expires_at > ?`,
    hashOf(token),
    now,
  )
}

export async function endSession(db: Db, token: string | undefined) {
  if (!token) return
  await db.batch(
    [
      { sql: 'DELETE FROM world_sessions WHERE token = ?', args: [hashOf(token)] },
      { sql: 'DELETE FROM sessions WHERE token = ?', args: [hashOf(token)] },
    ],
    'write',
  )
}

/** A petition as the club shows it: no nullifiers, its starter's name only if they chose to show it */
export type Petition = {
  id: number
  title: string
  target: string
  body: string
  starterName: string | null
  at: number
  status: 'open' | 'won' | 'closed'
  statusAt: number | null
  count: number
  /** Signatures in the last 7 days */
  recent: number
}

const PETITION = `SELECT p.id, p.title, p.target, p.body, p.starter_name AS starterName, p.at, p.status, p.status_at AS statusAt,
  (SELECT count(*) FROM signatures s WHERE s.petition = p.id) AS count,
  (SELECT count(*) FROM signatures s WHERE s.petition = p.id AND s.at >= ?) AS recent
  FROM petitions p`
const WEEK = 7 * 24 * 3600_000

/** Open petitions first, those signed most this week first among them; or the newest first */
export function petitions(db: Db, now: number, order: 'trending' | 'new' = 'trending', limit = 60): Promise<Petition[]> {
  const by = order === 'new' ? 'p.at DESC, p.id DESC' : "(p.status = 'open') DESC, recent DESC, count DESC, p.at DESC, p.id DESC"
  return all<Petition>(db, `${PETITION} ORDER BY ${by} LIMIT ?`, now - WEEK, limit)
}

export function petition(db: Db, id: number, now: number): Promise<Petition | null> {
  return one<Petition>(db, `${PETITION} WHERE p.id = ?`, now - WEEK, id)
}

/** Whether this human started it: the page offers its starter the close */
export const startedBy = async (db: Db, id: number, nullifier: string) => (await stateOf(db, id))?.starter === nullifier

export type Signature = {
  /** Null for a human who signed without their name */
  name: string | null
  reason: string | null
  at: number
  /** The knock behind a named signature: its Wedgie's count of knocks, and the binding it was made under */
  counter: number | null
  bindingTx: string | null
  bindingBlock: number | null
}

export function signatures(db: Db, petition: number, limit = 200): Promise<Signature[]> {
  return all<Signature>(
    db,
    `SELECT name, reason, at, counter, binding_tx AS bindingTx, binding_block AS bindingBlock FROM signatures
     WHERE petition = ? ORDER BY at DESC LIMIT ?`,
    petition,
    limit,
  )
}

/** What signers said or showed, newest first: the signatures with a name or a reason; and how many had neither */
export async function voices(db: Db, petition: number, limit = 200): Promise<{ said: Signature[]; quiet: number }> {
  const said = await all<Signature>(
    db,
    `SELECT name, reason, at, counter, binding_tx AS bindingTx, binding_block AS bindingBlock FROM signatures
     WHERE petition = ? AND (name IS NOT NULL OR reason IS NOT NULL) ORDER BY at DESC LIMIT ?`,
    petition,
    limit,
  )
  const n = await one<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM signatures WHERE petition = ? AND name IS NULL AND reason IS NULL',
    petition,
  )
  return { said, quiet: Number(n?.n ?? 0) }
}

/** Yours, for your page: what you started, named or not, and what you signed */
export async function mine(db: Db, nullifier: string, now: number) {
  const started = await all<Petition>(db, `${PETITION} WHERE p.starter = ? ORDER BY p.at DESC`, now - WEEK, nullifier)
  const signedRows = await all<Petition & { signedAt: number; signedAs: string | null }>(
    db,
    `${PETITION.replace('FROM petitions p', ', s.at AS signedAt, s.name AS signedAs FROM petitions p JOIN signatures s ON s.petition = p.id')}
     WHERE s.nullifier = ? AND p.starter <> ? ORDER BY s.at DESC`,
    now - WEEK,
    nullifier,
    nullifier,
  )
  return { started, signed: signedRows }
}

export async function totals(db: Db) {
  const t = await one<{ petitions: number; signatures: number; humans: number; won: number; fundraisers: number; raisedGwei: number }>(
    db,
    `SELECT (SELECT count(*) FROM petitions) AS petitions, (SELECT count(*) FROM signatures) AS signatures,
     (SELECT count(*) FROM humans) AS humans, (SELECT count(*) FROM petitions WHERE status = 'won') AS won,
     (SELECT count(*) FROM fundraisers) AS fundraisers,
     (SELECT coalesce(sum(gwei), 0) FROM gifts WHERE tx IS NOT NULL) AS raisedGwei`,
  )
  const { raisedGwei, ...rest } = t as NonNullable<typeof t>
  return { ...rest, raised: (BigInt(raisedGwei) * 1_000_000_000n).toString() }
}

/** A fundraiser as the club shows it: its starter by the Wedgie name its gifts go to */
export type Fundraiser = {
  id: number
  title: string
  story: string
  /** In wei, as decimal strings */
  goal: string
  raised: string
  name: string
  payout: string
  at: number
  status: 'open' | 'closed'
  statusAt: number | null
  gifts: number
  /** Gifts given in a human's session, each human once */
  humans: number
  recent: number
}

const FUNDRAISER = `SELECT f.id, f.title, f.story, f.goal, f.name, f.payout, f.at, f.status, f.status_at AS statusAt,
  (SELECT coalesce(sum(g.gwei), 0) FROM gifts g WHERE g.fundraiser = f.id AND g.tx IS NOT NULL) AS raisedGwei,
  (SELECT count(*) FROM gifts g WHERE g.fundraiser = f.id AND g.tx IS NOT NULL) AS gifts,
  (SELECT count(DISTINCT g.human) FROM gifts g WHERE g.fundraiser = f.id AND g.tx IS NOT NULL) AS humans,
  (SELECT count(*) FROM gifts g WHERE g.fundraiser = f.id AND g.tx IS NOT NULL AND g.given_at >= ?) AS recent
  FROM fundraisers f`

const asFundraiser = (r: Omit<Fundraiser, 'raised'> & { raisedGwei: number }): Fundraiser => {
  const { raisedGwei, ...rest } = r
  return { ...rest, raised: (BigInt(raisedGwei) * 1_000_000_000n).toString() }
}

type FundRow = Omit<Fundraiser, 'raised'> & { raisedGwei: number }

export async function fundraisers(db: Db, now: number, order: 'trending' | 'new' = 'trending', limit = 60): Promise<Fundraiser[]> {
  const by = order === 'new' ? 'f.at DESC, f.id DESC' : "(f.status = 'open') DESC, recent DESC, raisedGwei DESC, f.at DESC, f.id DESC"
  return (await all<FundRow>(db, `${FUNDRAISER} ORDER BY ${by} LIMIT ?`, now - WEEK, limit)).map(asFundraiser)
}

export async function fundraiser(db: Db, id: number, now: number): Promise<Fundraiser | null> {
  const row = await one<FundRow>(db, `${FUNDRAISER} WHERE f.id = ?`, now - WEEK, id)
  return row ? asFundraiser(row) : null
}

export const raisedBy = async (db: Db, id: number, nullifier: string) => (await fundState(db, id))?.starter === nullifier

export type Gift = {
  value: string
  /** The giving address and its transaction, if the giver chose to show them */
  from: string | null
  tx: string | null
  message: string | null
  /** Given in a human's session */
  human: boolean
  at: number
}

export async function giftsTo(db: Db, fundraiser: number, limit = 200): Promise<Gift[]> {
  const rows = await all<Omit<Gift, 'human'> & { human: number }>(
    db,
    `SELECT value, CASE WHEN show_from = 1 THEN from_address END AS "from", CASE WHEN show_from = 1 THEN tx END AS tx,
     message, human IS NOT NULL AS human, given_at AS at FROM gifts WHERE fundraiser = ? AND tx IS NOT NULL
     ORDER BY given_at DESC LIMIT ?`,
    fundraiser,
    limit,
  )
  return rows.map((g) => ({ ...g, human: g.human === 1 }))
}

/** Yours: the fundraisers you started, and what you gave in your sessions */
export async function mineFunds(db: Db, nullifier: string, now: number) {
  const started = (await all<FundRow>(db, `${FUNDRAISER} WHERE f.starter = ? ORDER BY f.at DESC`, now - WEEK, nullifier)).map(
    asFundraiser,
  )
  const gave = await all<{ value: string; at: number; shown: number; id: number; title: string; name: string }>(
    db,
    `SELECT g.value, g.given_at AS at, g.show_from AS shown, f.id, f.title, f.name FROM gifts g JOIN fundraisers f ON f.id = g.fundraiser
     WHERE g.human = ? AND g.tx IS NOT NULL ORDER BY g.given_at DESC`,
    nullifier,
  )
  return { started, gave }
}
