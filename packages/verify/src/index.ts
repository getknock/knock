/**
 * @knock-dev/verify: a site's check of a knock (PLAN §3), V1–V8 in order, failing closed. These are the knock-verify
 * crate's checks, with its codes and words, in TypeScript, for a site's own server: Node, Bun or Deno, or serverless
 * and edge functions. The protocol's test vectors keep the two in step.
 *
 * A knock is the KnockPass a Wedgie signed after a green press, for the site's challenge and origin. Nothing in it
 * is taken on trust: the name's records come from ENS on mainnet, the human from the `Bound` log that `knock.poh`
 * names on World Chain, and the press from the signature under the key ENS holds. What a knock uses up (its
 * challenge, its counter, an entry) is written once every check has passed, all of it or none, so a refused knock
 * uses up nothing.
 *
 * It runs on the site's server, never in the visitor's browser: there, the person being checked could skip it.
 */
import { P256_N, digest, keyHash, uncompressKey, verifySignature } from '@knock-dev/protocol'
import {
  type Address,
  type Hex,
  type PublicClient,
  TransactionReceiptNotFoundError,
  createPublicClient,
  http,
  isAddressEqual,
  keccak256,
  namehash,
  pad,
  stringToBytes,
  toHex,
} from 'viem'
import { mainnet, worldchain } from 'viem/chains'

/** World Chain, where bindings live */
export const WORLD_CHAIN = 480
/** How long a challenge lasts, in ms (V2) */
export const CHALLENGE_MS = 120_000
/** How many blocks deep `knock.status=active` has to be on mainnet (V3) */
export const DEPTH = 3n
/** How long a name's deep records are kept, in ms (V3). Revocation is read from the latest block every time. */
export const CACHE_MS = 60_000
/** A binding older than this, by its proof, doesn't count (D23), unless a site says less */
export const MAX_BINDING_DAYS = 365
/** The records V3 reads, in Records' order */
export const RECORDS = ['knock.v', 'knock.key', 'knock.status', 'knock.nullifier', 'knock.poh'] as const
/**
 * The KnockBinding whose `Bound` logs count: v3, production, on World Chain (D22, D24). Staging's takes World ID's
 * Simulator proofs, so none of its bindings count. A network of your own passes its own KnockBinding as `contract`.
 */
export const KNOCK_BINDING: Address = '0x7748D2787DcB6E6024968edC19fcA13ccAbA1699'
/** The public nodes the checks read when a site names none: the Rust verifier's defaults */
export const ETH_RPC = 'https://ethereum-rpc.publicnode.com'
export const WORLD_RPC = 'https://worldchain-mainnet.g.alchemy.com/public'

const HALF_N = P256_N / 2n
const BOUND = keccak256(stringToBytes('Bound(uint256,bytes32,bytes32,uint64)'))
/** At most this many unexpired challenges at once, in the stores here */
const OUTSTANDING = 10_000

/** A no, with the check that said it (1–8; 0 for the verifier's own trouble) and a code a site can act on */
export class Refusal extends Error {
  constructor(
    readonly check: number,
    readonly error: string,
    readonly why: string,
  ) {
    super(why)
    this.name = 'Refusal'
  }

  /** As the Rust verifier's HTTP API says no: `{ok: false, check, error, why}` */
  toJSON() {
    return { ok: false as const, check: this.check, error: this.error, why: this.why }
  }
}

const no = (check: number, error: string, why: string) => new Refusal(check, error, why)

/** An error's first line, with no URL in it: an RPC's URL can carry its key */
const said = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).split('\n')[0].replace(/\S+:\/\/\S+/g, '<url>')

const unavailable = (check: number, e: unknown) => no(check, 'unavailable', `couldn't read the chain, try again: ${said(e)}`)

/** The store's trouble, as the crate says it: check 0, `internal` */
async function stored<T>(p: Promise<T>): Promise<T> {
  try {
    return await p
  } catch (e) {
    throw e instanceof Refusal ? e : no(0, 'internal', `the verifier's store: ${said(e)}`)
  }
}

/** A knock as the Door hands it to the site (door-sdk's Assertion) */
export type Assertion = {
  v: 1
  name: string
  challenge: Hex
  origin: string
  deviceNode: Hex
  counter: number
  mode: 1 | 2
  nullifier: Hex
  humanRef: Hex
  r: Hex
  s: Hex
}

/** A name Knock takes: a-z, 0-9 and "-", with dots between (the Console's rule, which ENS leaves as it is) */
export function okName(name: string): boolean {
  const labels = name.split('.')
  return (
    name.length <= 255 &&
    labels.length >= 2 &&
    labels.every((l) => l.length > 0 && l.length <= 63 && /^[a-z0-9-]+$/.test(l) && l.slice(2, 4) !== '--')
  )
}

/** An origin as a browser writes one, and as the Wedgie takes it: https://host[:port], or http://localhost or
 *  127.0.0.1 for development */
export function okOrigin(o: string): boolean {
  const m = /^(https|http):\/\/([^:/]+)(?::(\d{1,5}))?$/.exec(o)
  if (!m) return false
  const [, scheme, host] = m
  return (scheme === 'https' || host === 'localhost' || host === '127.0.0.1') && /^[a-z0-9.-]+$/.test(host)
}

const FIELDS = ['v', 'name', 'challenge', 'origin', 'deviceNode', 'counter', 'mode', 'nullifier', 'humanRef', 'r', 's']
const word = (x: unknown): x is Hex => typeof x === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x)

/** V1: a knock, whole and well formed, its s low */
export function parse(x: unknown): Assertion {
  const bad = (why: string) => no(1, 'bad_assertion', why)
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw bad('not a knock: not an object')
  const o = x as Record<string, unknown>
  const extra = Object.keys(o).find((k) => !FIELDS.includes(k))
  if (extra) throw bad(`not a knock: unknown field \`${extra}\``)
  const missing = FIELDS.find((k) => !(k in o))
  if (missing) throw bad(`not a knock: missing field \`${missing}\``)
  for (const k of ['challenge', 'deviceNode', 'nullifier', 'humanRef', 'r', 's'])
    if (!word(o[k])) throw bad(`not a knock: ${k} isn't 32 bytes of hex`)
  if (typeof o.name !== 'string' || typeof o.origin !== 'string') throw bad('not a knock: name and origin are text')
  if (o.v !== 1) throw bad(`version ${String(o.v)}: this verifier reads 1`)
  const a = o as Assertion
  if (!okName(a.name)) throw bad('name: a-z, 0-9 and "-", with dots between')
  if (a.deviceNode.toLowerCase() !== namehash(a.name)) throw bad("deviceNode isn't the name's namehash")
  if (!okOrigin(a.origin)) throw bad('origin: https://host[:port], or http://localhost')
  if (!Number.isSafeInteger(a.counter) || a.counter < 1) throw bad('counter: from 1 up')
  if (a.mode !== 1 && a.mode !== 2) throw bad('mode: 1 (Bound) or 2 (Fresh)')
  if (BigInt(a.r) === 0n || BigInt(a.s) === 0n || BigInt(a.s) > HALF_N) throw bad('signature: r and s, s low')
  return a
}

/** A name's Knock records at one block, as ENS gives them (null: empty or missing) */
export type Records = { v: string | null; key: string | null; status: string | null; nullifier: string | null; poh: string | null }

const NONE: Records = { v: null, key: null, status: null, nullifier: null, poh: null }
const same = (a: Records, b: Records) =>
  a.v === b.v && a.key === b.key && a.status === b.status && a.nullifier === b.nullifier && a.poh === b.poh

/** Records from the RECORDS' texts, in order */
export function recordsOf(texts: (string | null | undefined)[]): Records {
  const [v, key, status, nullifier, poh] = texts.map((t) => (t ? t : null))
  return { v, key, status, nullifier, poh }
}

/** What V3 takes from the records: the Wedgie's key, the human, and the transaction of their binding */
export type Valid = { key: Hex; keyHash: Hex; nullifier: bigint; poh: Hex }

/** knock.key: a 33-byte compressed P-256 key, 0x and 66 hex digits; its keyHash, as Bound names it */
export function parseKey(s: string): { key: Hex; keyHash: Hex } | null {
  if (!/^0x[0-9a-fA-F]{66}$/.test(s)) return null
  try {
    const { x, y } = uncompressKey(s.toLowerCase() as Hex)
    return { key: s.toLowerCase() as Hex, keyHash: keyHash(x, y) }
  } catch {
    return null
  }
}

/** V3: the name holds Knock's records, status=active seen at least DEPTH blocks deep, and nothing different at the
 *  latest block, where a revoke counts at once. An expired name doesn't resolve, so its records read as empty. */
export function checkRecords(name: string, deep: Records, latest: Records): Valid {
  if (same(latest, NONE)) throw no(3, 'no_name', `${name} has no Knock records in ENS: never named, or killed`)
  if (latest.status === 'revoked') throw no(3, 'revoked', `${name} is revoked: its owner turned it off`)
  if (latest.v !== '1') throw no(3, 'not_knock', `${name} isn't a Knock name (knock.v isn't 1)`)
  if (!same(deep, latest))
    throw no(3, 'records_changing', `${name}'s Knock records changed in the last few blocks: try again in a minute`)
  if (deep.status !== 'active') throw no(3, 'not_active', `${name}'s knock.status isn't active`)
  const bad = (what: string) => no(3, 'bad_records', `${name}'s ${what}`)
  const k = deep.key ? parseKey(deep.key) : null
  if (!k) throw bad("knock.key isn't a compressed P-256 key")
  if (!deep.nullifier || !word(deep.nullifier)) throw bad("knock.nullifier isn't a word")
  const poh = /^eip155:480:tx:(0x[0-9a-fA-F]{64})$/.exec(deep.poh ?? '')?.[1]
  if (!poh) throw bad("knock.poh isn't eip155:480:tx:<hash>")
  return { ...k, nullifier: BigInt(deep.nullifier), poh: poh.toLowerCase() as Hex }
}

/**
 * How final a binding has to be before V6 takes it (D26). `off` by default: a binding counts once its transaction is
 * in a World Chain block, seconds after it's sent. `safe` waits until World Chain has posted that block to Ethereum,
 * which it does every ~6 minutes; `finalized`, until that post is final there, ~20–25 minutes.
 */
export type Strict = 'off' | 'safe' | 'finalized'

/** A strict setting as people write it: off (or nothing, false, 0, no), on (true, 1, yes, safe) or finalized */
export function strictFrom(s: string | undefined): Strict {
  const x = (s ?? '').trim().toLowerCase()
  if (['', 'off', 'false', '0', 'no'].includes(x)) return 'off'
  if (['on', 'true', '1', 'yes', 'safe'].includes(x)) return 'safe'
  if (x === 'finalized') return 'finalized'
  throw new Error(`strict: off, on (safe) or finalized, not ${x}`)
}

/** What a knock whose binding isn't final enough yet is told */
const WAIT = {
  safe:
    'this site is strict: it takes a binding once World Chain has posted it to Ethereum, which it does every ~6 minutes. Try again in a few minutes',
  finalized:
    "this site is strict: it takes a binding once World Chain's post of it to Ethereum is final, ~20–25 minutes after binding. Try again later",
}

/** A World Chain receipt, as much of it as V6 reads */
export type Receipt = { ok: boolean; block: number; logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[] }

/** The binding a knock stands on. provedAt is the proof's `expiresAtMin`: about when it was made, in unix seconds. */
export type Binding = { tx: Hex; block: number; provedAt: number }

/** What V6 asks of a binding */
export type Wanted = {
  tx: Hex
  contract: Address
  nullifier: bigint
  keyHash: Hex
  node: Hex
  /** How final the binding has to be, and the highest World Chain block that is: none when not strict */
  final?: { strict: 'safe' | 'finalized'; block: number }
  /** Unix seconds */
  now: number
  /** Seconds */
  maxAge: number
}

/** V6, the binding: the transaction knock.poh names succeeded on the accepted KnockBinding, with a `Bound` for this
 *  key, this human and this name, final enough for a strict site (D26), its proof no older than maxAge (D23). */
export function checkBinding(r: Receipt | null, w: Wanted): Binding {
  if (!r) throw no(6, 'no_binding', `World Chain has no transaction ${w.tx}`)
  if (!r.ok) throw no(6, 'no_binding', `the binding's transaction ${w.tx} failed`)
  const topics = [BOUND, pad(`0x${w.nullifier.toString(16)}`), w.keyHash, w.node].map((t) => t.toLowerCase())
  const log = r.logs.find(
    (l) =>
      isAddressEqual(l.address, w.contract) &&
      l.topics.length === 4 &&
      l.topics.every((t, i) => t.toLowerCase() === topics[i]) &&
      /^0x0{48}[0-9a-fA-F]{16}$/.test(l.data),
  )
  if (!log)
    throw no(6, 'no_binding', `transaction ${w.tx} holds no Bound from Knock's KnockBinding for this key, human and name`)
  if (w.final && r.block > w.final.block) throw no(6, 'binding_not_final', WAIT[w.final.strict])
  const provedAt = Number(BigInt(log.data))
  if (w.now - provedAt > w.maxAge)
    throw no(6, 'binding_expired', `the binding is more than ${Math.floor(w.maxAge / 86_400)} days old: bind the Wedgie again`)
  return { tx: w.tx, block: r.block, provedAt }
}

/** Where the checks read the chains: mainnet for ENS, World Chain for bindings */
export interface Chain {
  /** Mainnet's latest block */
  head(): Promise<bigint>
  /** A name's RECORDS at a mainnet block, through the Universal Resolver */
  records(name: string, block: bigint): Promise<Records>
  /** A World Chain transaction's receipt, if there is one */
  receipt(tx: Hex): Promise<Receipt | null>
  /** World Chain's safe or finalized head, for a strict site. Never asked when a site isn't strict. */
  finalBlock(strict: 'safe' | 'finalized'): Promise<number>
}

/**
 * The chains over JSON-RPC, through viem: mainnet's ENS records through the Universal Resolver, World Chain's
 * receipts. Give each an RPC URL or a viem client (for mainnet, one made with `chain: mainnet`); public nodes
 * otherwise, which are fine to start with and rate-limited.
 */
export function rpcChain(o: { eth?: string | PublicClient; world?: string | PublicClient } = {}): Chain {
  const eth =
    typeof o.eth === 'object'
      ? o.eth
      : createPublicClient({ chain: mainnet, transport: http(o.eth ?? ETH_RPC), batch: { multicall: true } })
  const world =
    typeof o.world === 'object' ? o.world : createPublicClient({ chain: worldchain, transport: http(o.world ?? WORLD_RPC) })
  return {
    head: () => eth.getBlockNumber({ cacheTime: 0 }),
    records: async (name, block) =>
      recordsOf(await Promise.all(RECORDS.map((key) => eth.getEnsText({ name, key, blockNumber: block })))),
    receipt: async (hash) => {
      try {
        const r = await world.getTransactionReceipt({ hash })
        return { ok: r.status === 'success', block: Number(r.blockNumber), logs: r.logs }
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null
        throw e
      }
    },
    finalBlock: async (strict) => Number((await world.getBlock({ blockTag: strict })).number),
  }
}

/** What the checks remember between knocks: each Wedgie key's highest counter taken, and the keys seen revoked */
export interface Memory {
  /** A key's highest counter taken, if any */
  counter(key: Hex): Promise<number | null>
  /** A key seen revoked is invalid forever */
  revoke(key: Hex, now: number): Promise<void>
  isRevoked(key: Hex): Promise<boolean>
}

/** A knock that passed: the name, the Wedgie's key, the human (their nullifier for Knock's action) and the binding */
export type Knocked = {
  name: string
  /** The Wedgie's compressed key, as ENS holds it, in lowercase */
  key: Hex
  keyHash: Hex
  /** The human: a 32-byte word, in lowercase hex. The same for one human on every site that takes Knock. */
  nullifier: Hex
  counter: number
  origin: string
  binding: Binding
}

/** A site, as the checks see it */
export type Site = {
  /** The site's origin, as browsers write it: https://host[:port], or http://localhost[:port] while developing */
  origin: string
  /** Where the checks read mainnet and World Chain: public nodes, unless you pass your own (rpcChain) */
  chain?: Chain
  /** The KnockBinding whose Bound logs count: Knock's, unless you run a network of your own */
  contract?: Address
  /** A binding older than this many days, by its proof, doesn't count: 365 unless you say less */
  maxBindingDays?: number
  /** How final a binding has to be (D26): off unless you say so */
  strict?: Strict
}

let publicChain: Chain | undefined
const chainOf = (site: Site) => site.chain ?? (publicChain ??= rpcChain())

/** Each chain's deep records, by name */
const caches = new WeakMap<Chain, Map<string, { at: number; records: Records }>>()

/** The name's records DEPTH blocks deep. A deep read that was active and the same as the latest block's is kept up
 *  to CACHE_MS, and used while the latest block still shows the same: any change reads it again. */
async function deepRecords(chain: Chain, name: string, head: bigint, latest: Records, now: number): Promise<Records> {
  let cache = caches.get(chain)
  if (!cache) caches.set(chain, (cache = new Map()))
  const hit = cache.get(name)
  if (hit && now - hit.at <= CACHE_MS && same(hit.records, latest)) return hit.records
  const deep = await chain.records(name, head > DEPTH ? head - DEPTH : 0n)
  if (cache.size > 1024) cache.clear()
  if (deep.status === 'active' && same(deep, latest)) cache.set(name, { at: now, records: deep })
  else cache.delete(name)
  return deep
}

/**
 * V3 to V7, for a knock whose V1 passed (parse) and whose challenge the caller checks (V2). It's for a site that
 * keeps its own challenges and writes what a knock uses up in its own transaction, with its own records: the
 * counter (V5 again there, for two knocks racing) and anything V8 asks. It writes nothing but a key seen revoked.
 * Verifier.verify is all of V1–V8, with a Store.
 */
export async function check(site: Site & { memory: Memory }, a: Assertion, now = Date.now()): Promise<Knocked> {
  if (a.origin !== site.origin) throw no(2, 'wrong_origin', `the knock is for ${a.origin}, not ${site.origin}`)
  const chain = chainOf(site)
  // V3
  let latest: Records
  let deep: Records
  try {
    const head = await chain.head()
    latest = await chain.records(a.name, head)
    deep = await deepRecords(chain, a.name, head, latest, now)
  } catch (e) {
    throw unavailable(3, e)
  }
  for (const r of [latest, deep]) {
    const k = r.status === 'revoked' && r.key ? parseKey(r.key) : null
    if (k) await stored(site.memory.revoke(k.key, now)) // a key seen revoked is invalid forever
  }
  const valid = checkRecords(a.name, deep, latest)
  if (await stored(site.memory.isRevoked(valid.key)))
    throw no(3, 'revoked', "this Wedgie's key was seen revoked, and stays revoked")
  // V4: the digest from our own origin, the name's node and the knock's fields
  const node = namehash(a.name)
  const d = digest('KnockPass', {
    challenge: a.challenge,
    origin: site.origin,
    deviceNode: node,
    counter: BigInt(a.counter),
    mode: a.mode,
    nullifier: BigInt(a.nullifier),
    humanRef: a.humanRef,
  })
  if (!verifySignature(d, a.r, a.s, valid.key))
    throw no(4, 'bad_signature', `not signed by ${a.name}'s key, for this site and challenge`)
  // V5
  const seen = await stored(site.memory.counter(valid.key))
  if (seen !== null && a.counter <= seen) throw no(5, 'replayed', "the Wedgie's counter didn't rise: a knock seen before")
  // V6, Bound
  if (a.mode === 2) throw no(7, 'mode_unsupported', "Fresh (mode 2) isn't offered yet") // V7
  if (BigInt(a.humanRef) !== 0n) throw no(6, 'bad_assertion', 'humanRef: zero in mode 1')
  const nullifier = BigInt(a.nullifier)
  if (nullifier !== valid.nullifier) throw no(6, 'wrong_human', `the knock's human isn't ${a.name}'s`)
  const strict = site.strict ?? 'off'
  let receipt: Receipt | null
  let final: Wanted['final']
  try {
    receipt = await chain.receipt(valid.poh)
    if (strict !== 'off') final = { strict, block: await chain.finalBlock(strict) }
  } catch (e) {
    throw unavailable(6, e)
  }
  const binding = checkBinding(receipt, {
    tx: valid.poh,
    contract: site.contract ?? KNOCK_BINDING,
    nullifier,
    keyHash: valid.keyHash,
    node,
    final,
    now: Math.floor(now / 1000),
    maxAge: (site.maxBindingDays ?? MAX_BINDING_DAYS) * 86_400,
  })
  return {
    name: a.name,
    key: valid.key,
    keyHash: valid.keyHash,
    nullifier: a.nullifier.toLowerCase() as Hex,
    counter: a.counter,
    origin: a.origin,
    binding,
  }
}

/** A challenge as a store keeps it */
export type Issued = { origin: string; issuedAt: number; used: boolean }

/** What a knock that passed uses up */
export type Commit = {
  challenge: Hex
  origin: string
  key: Hex
  counter: number
  /** V8's entry: this human did this action, under this name */
  entry: { action: string; nullifier: Hex; name: string } | null
  now: number
}

/**
 * What a verifier remembers between knocks: the challenges it gave out, each Wedgie key's highest counter, the keys
 * it has seen revoked, and the entries for V8. Keep it where every instance of your server reaches it: one
 * process's memory (memoryStore) is enough for one process only. libsqlStore keeps it in SQLite or Turso.
 */
export interface Store extends Memory {
  /** Keeps a new challenge for origin, letting expired ones go: false when too many are out */
  issue(challenge: Hex, origin: string, now: number): Promise<boolean>
  challenge(challenge: Hex): Promise<Issued | null>
  /** V8: this human has done this action here */
  entered(action: string, nullifier: Hex): Promise<boolean>
  /** The challenge used, the counter stored and the entry made, all of it or none, each checked again as it's
   *  written: of two knocks racing for one challenge, counter or entry, one gets it. What the other lost, else null. */
  commit(c: Commit): Promise<'challenge' | 'counter' | 'entry' | null>
}

/** A challenge for the site's page, to hand to the Door with door-sdk's knock(). expiresAt is in ms. */
export type Challenge = { challenge: Hex; origin: string; expiresAt: number }

/** A site's verifier, for one origin: V1–V8, with what it remembers in a Store */
export class Verifier {
  readonly site: Site & { store: Store }

  constructor(site: Site & { store: Store }) {
    if (!okOrigin(site.origin)) throw new Error('origin: https://host[:port], or http://localhost[:port]')
    this.site = site
  }

  async challenge(now = Date.now()): Promise<Challenge> {
    const challenge = toHex(crypto.getRandomValues(new Uint8Array(32)))
    if (!(await stored(this.site.store.issue(challenge, this.site.origin, now))))
      throw no(2, 'busy', 'too many challenges out at once: try again in a minute')
    return { challenge, origin: this.site.origin, expiresAt: now + CHALLENGE_MS }
  }

  /** V1–V8 in order, then what the knock uses up. `action` is the site's action for V8 (one entry per human), if it
   *  has one. A no is a Refusal. */
  async verify(assertion: unknown, o: { action?: string; now?: number } = {}): Promise<Knocked> {
    const now = o.now ?? Date.now()
    const { origin, store } = this.site
    // V1
    const a = parse(assertion)
    // V2: a challenge we gave out for our origin, unexpired and unused, and a knock for our origin
    if (a.origin !== origin) throw no(2, 'wrong_origin', `the knock is for ${a.origin}, not ${origin}`)
    const issued = await stored(store.challenge(a.challenge))
    if (!issued) throw no(2, 'bad_challenge', 'not a challenge this verifier gave out')
    if (issued.origin !== origin) throw no(2, 'wrong_origin', 'a challenge for another origin')
    if (issued.used) throw no(2, 'bad_challenge', 'that challenge was used already')
    if (now - issued.issuedAt > CHALLENGE_MS) throw no(2, 'bad_challenge', 'that challenge expired: knock again')
    // V3–V7
    const k = await check({ ...this.site, memory: store }, a, now)
    // V8
    const entered = () => no(8, 'already_entered', `this human has done ${o.action} here already`)
    if (o.action !== undefined && (await stored(store.entered(o.action, k.nullifier)))) throw entered()
    // All of it, or none
    const lost = await stored(
      store.commit({
        challenge: a.challenge,
        origin,
        key: k.key,
        counter: k.counter,
        entry: o.action === undefined ? null : { action: o.action, nullifier: k.nullifier, name: k.name },
        now,
      }),
    )
    if (lost === 'challenge') throw no(2, 'bad_challenge', 'that challenge was used or expired meanwhile')
    if (lost === 'counter') throw no(5, 'replayed', "the Wedgie's counter didn't rise: a knock seen before")
    if (lost === 'entry') throw entered()
    return k
  }
}

/** A Store in this process's memory: for development, tests, and a site that runs as one long-lived process */
export function memoryStore(): Store {
  const challenges = new Map<string, Issued>()
  const counters = new Map<string, number>()
  const revoked = new Map<string, number>()
  const entries = new Set<string>()
  const entryOf = (action: string, nullifier: Hex) => `${action}\n${nullifier.toLowerCase()}`
  return {
    async issue(challenge, origin, now) {
      for (const [c, i] of challenges) if (i.issuedAt < now - CHALLENGE_MS) challenges.delete(c)
      if (challenges.size >= OUTSTANDING) return false
      challenges.set(challenge.toLowerCase(), { origin, issuedAt: now, used: false })
      return true
    },
    async challenge(challenge) {
      const i = challenges.get(challenge.toLowerCase())
      return i ? { ...i } : null
    },
    async counter(key) {
      return counters.get(key.toLowerCase()) ?? null
    },
    async revoke(key, now) {
      if (!revoked.has(key.toLowerCase())) revoked.set(key.toLowerCase(), now)
    },
    async isRevoked(key) {
      return revoked.has(key.toLowerCase())
    },
    async entered(action, nullifier) {
      return entries.has(entryOf(action, nullifier))
    },
    // No await in here: one knock's commit runs whole before another's starts
    async commit(c) {
      const i = challenges.get(c.challenge.toLowerCase())
      if (!i || i.used || i.origin !== c.origin || i.issuedAt < c.now - CHALLENGE_MS) return 'challenge'
      const seen = counters.get(c.key.toLowerCase())
      if (seen !== undefined && c.counter <= seen) return 'counter'
      if (c.entry && entries.has(entryOf(c.entry.action, c.entry.nullifier))) return 'entry'
      i.used = true
      counters.set(c.key.toLowerCase(), c.counter)
      if (c.entry) entries.add(entryOf(c.entry.action, c.entry.nullifier))
      return null
    },
  }
}

type SqlArg = string | number | bigint | null
type SqlResult = { rows: ArrayLike<unknown>[]; rowsAffected: number }
type SqlStatement = { sql: string; args: SqlArg[] }

/** The part of a libSQL client (@libsql/client: SQLite files, Turso, or memory) that libsqlStore uses */
export type SqlClient = {
  execute(stmt: SqlStatement): Promise<SqlResult>
  executeMultiple(sql: string): Promise<unknown>
  transaction(mode: 'write'): Promise<{
    execute(stmt: SqlStatement): Promise<SqlResult>
    commit(): Promise<unknown>
    rollback(): Promise<unknown>
    close(): void
  }>
}

/** The tables libsqlStore keeps, beside your own: each name starts with knock_ */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS knock_challenges (challenge TEXT PRIMARY KEY, origin TEXT NOT NULL, issued_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS knock_counters (key TEXT PRIMARY KEY, counter INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS knock_revoked (key TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS knock_entries (action TEXT NOT NULL, nullifier TEXT NOT NULL, name TEXT NOT NULL,
  at INTEGER NOT NULL, PRIMARY KEY (action, nullifier));
`

/**
 * A Store in a libSQL database: a SQLite file (`file:knock.db`), Turso (`libsql://…` with its token), or memory.
 * Its tables are made on first use. Pass a client from @libsql/client, or @libsql/client/web on edge runtimes.
 */
export function libsqlStore(db: SqlClient): Store {
  let ready: Promise<unknown> | undefined
  const tables = () =>
    (ready ??= db.executeMultiple(SCHEMA).catch((e) => {
      ready = undefined
      throw e
    }))
  const exec = async (sql: string, ...args: SqlArg[]) => {
    await tables()
    return db.execute({ sql, args })
  }
  const first = (r: SqlResult) => r.rows[0] as ArrayLike<unknown> | undefined
  return {
    async issue(challenge, origin, now) {
      await exec('DELETE FROM knock_challenges WHERE issued_at < ?', now - CHALLENGE_MS)
      const n = Number(first(await exec('SELECT count(*) FROM knock_challenges'))?.[0] ?? 0)
      if (n >= OUTSTANDING) return false
      await exec('INSERT INTO knock_challenges (challenge, origin, issued_at) VALUES (?, ?, ?)', challenge.toLowerCase(), origin, now)
      return true
    },
    async challenge(challenge) {
      const row = first(
        await exec('SELECT origin, issued_at, used FROM knock_challenges WHERE challenge = ?', challenge.toLowerCase()),
      )
      return row ? { origin: String(row[0]), issuedAt: Number(row[1]), used: Number(row[2]) === 1 } : null
    },
    async counter(key) {
      const row = first(await exec('SELECT counter FROM knock_counters WHERE key = ?', key.toLowerCase()))
      return row ? Number(row[0]) : null
    },
    async revoke(key, now) {
      await exec('INSERT OR IGNORE INTO knock_revoked (key, seen_at) VALUES (?, ?)', key.toLowerCase(), now)
    },
    async isRevoked(key) {
      return first(await exec('SELECT 1 FROM knock_revoked WHERE key = ?', key.toLowerCase())) !== undefined
    },
    async entered(action, nullifier) {
      return (
        first(await exec('SELECT 1 FROM knock_entries WHERE action = ? AND nullifier = ?', action, nullifier.toLowerCase())) !==
        undefined
      )
    },
    async commit(c) {
      await tables()
      const tx = await db.transaction('write')
      try {
        const run = (sql: string, ...args: SqlArg[]) => tx.execute({ sql, args })
        const lost = async (what: 'challenge' | 'counter' | 'entry') => {
          await tx.rollback()
          return what
        }
        const used = await run(
          'UPDATE knock_challenges SET used = 1 WHERE challenge = ? AND origin = ? AND used = 0 AND issued_at >= ?',
          c.challenge.toLowerCase(),
          c.origin,
          c.now - CHALLENGE_MS,
        )
        if (used.rowsAffected !== 1) return await lost('challenge')
        const rose = await run(
          `INSERT INTO knock_counters (key, counter) VALUES (?, ?) ON CONFLICT (key) DO UPDATE
             SET counter = excluded.counter WHERE excluded.counter > knock_counters.counter`,
          c.key.toLowerCase(),
          c.counter,
        )
        if (rose.rowsAffected !== 1) return await lost('counter')
        if (c.entry) {
          const made = await run(
            'INSERT OR IGNORE INTO knock_entries (action, nullifier, name, at) VALUES (?, ?, ?, ?)',
            c.entry.action,
            c.entry.nullifier.toLowerCase(),
            c.entry.name,
            c.now,
          )
          if (made.rowsAffected !== 1) return await lost('entry')
        }
        await tx.commit()
        return null
      } catch (e) {
        await tx.rollback().catch(() => {})
        throw e
      } finally {
        tx.close()
      }
    },
  }
}
