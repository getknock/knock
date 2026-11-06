/**
 * The club's second way in (D35): World ID and a wallet, for a human without their Wedgie at hand, or without a
 * Wedgie at all. It counts them by Knock's own nullifier, so a human is one signer whichever way they come in.
 *
 * The club proves the human's World ID session with Knock. Knock's World ID app asks for it, with requests knockd
 * signs (/rp-context), and KnockBinding keeps each human's session on World Chain. A human new to Knock starts
 * theirs here, with a first binding like the Console's: a key the club makes for them and then forgets, bound for
 * their wallet's reverse name (<address>.addr.reverse) and sent by knockd. That's how the club finds them again by
 * their wallet, and how the Console finds them when they get a Wedgie. Every act after that is a proof of the
 * session whose signal is the club's challenge for the act, checked on World Chain by World ID's own verifier.
 *
 * Its checks, in order, numbered as the club answers them: 1 the proof is made right; 2 it answers a request the
 * club made just now; 3 its session is one KnockBinding has (or, the first time, it starts one, for Knock's
 * action); 4 World ID's verifier holds it (or, the first time, the binding is on World Chain); 5 no proof is used
 * twice; 8 the act's once per human. Server code only.
 */
import { bindSignal, digest, keyHash, publicKeyOf, signDigest, signalHash, uncompressKey } from '@knock-dev/protocol'
import { Refusal } from '@knock-dev/verify'
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  type PublicClient,
  TransactionReceiptNotFoundError,
  getAddress,
  isAddress,
  namehash,
  parseAbi,
  parseEventLogs,
  toHex,
} from 'viem'
import { normalize } from 'viem/ens'
import { createSiweMessage, parseSiweMessage } from 'viem/siwe'
import deployments from '../../../contracts/deployments/480.json'
import { HOLD_MS } from './club'

export type Environment = 'staging' | 'production'

/** Where the club proves humans: production (World App), or staging (the Simulator) */
export const WORLD_ENV: Environment = process.env.CLUB_WORLD_ENV === 'staging' ? 'staging' : 'production'

/** The KnockBinding World ID visitors are bound with: Knock's for WORLD_ENV, unless CLUB_KNOCK_BINDING names one's own */
export const BINDING = (process.env.CLUB_KNOCK_BINDING || deployments[WORLD_ENV].KnockBinding) as Address
export const CHAIN_ID = deployments.chainId

/** Knock's action for WORLD_ENV: the one a human's first proof is for, which knockd signs requests for */
export const ACTION = deployments[WORLD_ENV].action

/** knockd, Knock's server: CLUB_KNOCKD, or in development the one on this computer */
export const KNOCKD =
  process.env.CLUB_KNOCKD ?? (process.env.NODE_ENV === 'development' ? 'http://localhost:8787' : 'https://knockd.getknock.dev')

/** World ID's proof-of-human credential, issuer schema 1: the one Knock asks for. A passport or a Self Check proves
 *  less, so the club takes none of them. */
export const PROOF_OF_HUMAN = 1

export type SessionId = `session_${string}`

/** A World ID session id: session_, then its commitment and its oprf seed, 64 hex digits each */
export function sessionParts(id: unknown): { commitment: bigint; seed: bigint } | null {
  const m = typeof id === 'string' ? /^session_([0-9a-f]{64})([0-9a-f]{64})$/i.exec(id) : null
  return m ? { commitment: BigInt(`0x${m[1]}`), seed: BigInt(`0x${m[2]}`) } : null
}

/** A wallet's reverse name, <address>.addr.reverse: the name KnockBinding keeps a World ID visitor's binding for */
export const walletNode = (wallet: Address): Hex => namehash(`${wallet.slice(2).toLowerCase()}.addr.reverse`)

/** The node a visitor finds their Knock session by: a Wedgie's name, or a wallet they came in with before */
export function nodeOf(nameOrWallet: string): Hex | null {
  const s = nameOrWallet.trim()
  if (isAddress(s, { strict: false })) return walletNode(s as Address)
  try {
    const name = normalize(s)
    return name.includes('.') ? namehash(name) : null
  } catch {
    return null
  }
}

/** A request World App proves: an RP context knockd signed as Knock */
export type RpContext = { rp_id: string; nonce: Hex; created_at: number; expires_at: number; signature: Hex }
export type Context = { app_id: `app_${string}`; action: string | null; rp_context: RpContext }

/** knockd's no, as it said it */
export class KnockdSaid extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    why: string,
  ) {
    super(why)
    this.name = 'KnockdSaid'
  }
}

async function knockd<T>(path: string, body: unknown, ms = 30_000): Promise<T> {
  let r: Response
  try {
    r = await fetch(KNOCKD + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    })
  } catch {
    throw new Refusal(0, 'unavailable', "The club couldn't reach knockd, Knock's server. Try again.")
  }
  const j = await r.json().catch(() => null)
  if (!r.ok) throw new KnockdSaid(r.status, j?.error ?? 'knockd', j?.why ?? `knockd said ${r.status}.`)
  return j as T
}

/** A request for World App, signed by knockd: a proof of the human's session, or a first one for Knock's action */
export async function contextFor(session: boolean): Promise<Context> {
  const c = await knockd<Context>('/rp-context', { environment: WORLD_ENV, session })
  if (!session && c.action !== ACTION)
    throw new Refusal(0, 'knockd', `knockd signs first proofs for ${String(c.action)}, and Knock's action is ${ACTION}.`)
  return c
}

/** The Knock session KnockBinding has for a human: whoever was last bound for a node, or a nullifier's latest. Null
 *  when there's none. */
export async function sessionFor(by: { node: Hex } | { nullifier: Hex }): Promise<SessionId | null> {
  try {
    return (await knockd<{ session: SessionId }>('/human', { environment: WORLD_ENV, ...by })).session
  } catch (e) {
    if (e instanceof KnockdSaid && e.error === 'no_session') return null
    throw e
  }
}

/** The message a wallet signs to come in (Sign-In with Ethereum, EIP-4361): for the club's origin, on mainnet,
 *  where a contract wallet's signature is checked, and good while the club holds it */
export function signInMessage(origin: string, address: Address, nonce: string, now: number): string {
  return createSiweMessage({
    domain: new URL(origin).host,
    uri: origin,
    address: getAddress(address),
    chainId: 1,
    version: '1',
    nonce,
    statement: "Come into the Human Club with this wallet. It names you there, and takes your fundraisers' gifts.",
    issuedAt: new Date(now),
    expirationTime: new Date(now + HOLD_MS),
  })
}

/** The nonce a sign-in message carries, which the club holds its wallet under */
export function signInNonce(message: unknown): string | null {
  if (typeof message !== 'string' || message.length > 2000) return null
  try {
    return parseSiweMessage(message).nonce ?? null
  } catch {
    return null
  }
}

/** A key the club makes for a first binding, and the signal World App proves for it: the key, then the node */
export function enrollmentKey(node: Hex): { secret: Hex; key: Hex; signal: string } {
  for (;;) {
    const secret = toHex(crypto.getRandomValues(new Uint8Array(32)))
    try {
      const { key } = publicKeyOf(secret)
      return { secret, key, signal: bindSignal(key, node) }
    } catch {
      // not a P-256 scalar (about one in 2^32): another
    }
  }
}

const no = (check: number, error: string, why: string) => new Refusal(check, error, why)

/** A field element, as World ID's proofs carry them: decimal, or 0x and hex */
function field(x: unknown, what: string): bigint {
  if (typeof x !== 'string' || !/^(?:[0-9]{1,78}|0x[0-9a-fA-F]{1,64})$/.test(x)) throw no(1, 'bad_proof', `World ID's ${what} isn't a number.`)
  const n = BigInt(x)
  if (n >= 2n ** 256n) throw no(1, 'bad_proof', `World ID's ${what} is too big.`)
  return n
}

type Item = Record<string, unknown>

/** The parts of a World ID result both proofs have: v4, the club's environment, one proof-of-human response */
function common(result: unknown): { r: Record<string, unknown>; item: Item; proof: bigint[]; nonce: bigint; expiresAtMin: bigint } {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  if (r.protocol_version !== '4.0') throw no(1, 'bad_proof', 'World ID answered with something other than a 4.0 proof.')
  if (r.environment !== WORLD_ENV)
    throw no(1, 'bad_proof', `World ID answered from ${String(r.environment)}, and the club proves humans in ${WORLD_ENV}.`)
  const items = Array.isArray(r.responses) ? r.responses : []
  const item = (items.length === 1 && items[0] && typeof items[0] === 'object' ? items[0] : null) as Item | null
  if (!item) throw no(1, 'bad_proof', 'World ID answered with no proof, or more than one.')
  if (item.issuer_schema_id !== PROOF_OF_HUMAN)
    throw no(1, 'not_proof_of_human', "World ID proved another credential than proof of human, which is the one the club takes.")
  const proof = Array.isArray(item.proof) && item.proof.length === 5 ? item.proof.map((p, i) => field(p, `proof[${i}]`)) : null
  if (!proof) throw no(1, 'bad_proof', "World ID's proof isn't five numbers.")
  const expires = item.expires_at_min
  if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires < 0)
    throw no(1, 'bad_proof', "World ID's expires_at_min isn't a time.")
  return { r, item, proof, nonce: field(r.nonce, 'nonce'), expiresAtMin: BigInt(expires) }
}

/** The request a result answers, as the club held it: its nonce, a 32-byte word */
export function nonceOf(result: unknown): Hex | null {
  const n = (result as { nonce?: unknown } | null)?.nonce
  try {
    return typeof n === 'string' ? toHex(field(n, 'nonce'), { size: 32 }) : null
  } catch {
    return null
  }
}

/** A session proof, read: what World ID's verifier is asked about it */
export type SessionProof = {
  commitment: bigint
  sessionNullifier: [bigint, bigint]
  nonce: bigint
  expiresAtMin: bigint
  issuerSchemaId: bigint
  proof: bigint[]
  signalHash: bigint
}

/** World App's proof of a Knock session, for the club's challenge (checks 1–3, the parts that need no chain) */
export function readSessionProof(result: unknown, session: SessionId, challenge: Hex): SessionProof {
  const { r, item, proof, nonce, expiresAtMin } = common(result)
  if ('action' in r) throw no(1, 'bad_proof', 'World ID answered with a proof for an action, not of a session.')
  const sn = Array.isArray(item.session_nullifier) && item.session_nullifier.length === 2 ? item.session_nullifier : null
  if (!sn) throw no(1, 'bad_proof', 'World ID answered without a session nullifier.')
  const sessionNullifier: [bigint, bigint] = [field(sn[0], 'session nullifier'), field(sn[1], 'session action')]
  const hash = BigInt(signalHash(challenge))
  if (item.signal_hash !== undefined && field(item.signal_hash, 'signal hash') !== hash)
    throw no(2, 'bad_challenge', "World App proved another signal than the club's challenge.")
  if (r.session_id !== session) throw no(3, 'not_your_session', 'World App proved another session than the one the club asked for.')
  // A session proof's action is a random one World App makes, and its top byte says so
  if (sessionNullifier[1] >> 248n !== 2n) throw no(3, 'not_a_session', "World ID's proof isn't a session proof.")
  const parts = sessionParts(session)
  if (!parts) throw no(1, 'bad_proof', "World ID's session id isn't one.")
  return { commitment: parts.commitment, sessionNullifier, nonce, expiresAtMin, issuerSchemaId: BigInt(PROOF_OF_HUMAN), proof, signalHash: hash }
}

/** A first proof, read: the human's uniqueness proof for Knock's action that starts their session */
export type FirstProof = {
  nullifier: Hex
  session: SessionId
  nonce: bigint
  expiresAtMin: bigint
  proof: bigint[]
  signalHash: bigint
}

/** World App's first proof for a human new to Knock, for the club's key and their wallet (checks 1–3) */
export function readFirstProof(result: unknown, action: string, signal: string): FirstProof {
  const { r, item, proof, nonce, expiresAtMin } = common(result)
  const hash = BigInt(signalHash(signal))
  if (item.signal_hash !== undefined && field(item.signal_hash, 'signal hash') !== hash)
    throw no(2, 'bad_challenge', "World App proved another signal than the club's key and your wallet.")
  if (r.action !== action) throw no(3, 'bad_proof', `World ID answered with a proof for ${String(r.action)}, not ${action}.`)
  const parts = sessionParts(r.session_id)
  // A first binding starts a session: its oprf seed's top byte is 1, as KnockBinding wants
  if (!parts || parts.commitment === 0n || parts.seed >> 248n !== 1n)
    throw no(3, 'no_session', "World ID's proof starts no session, so you couldn't prove it was you again.")
  if (typeof item.nullifier !== 'string') throw no(1, 'bad_proof', 'World ID answered without a nullifier.')
  return { nullifier: toHex(field(item.nullifier, 'nullifier'), { size: 32 }), session: r.session_id as SessionId, nonce, expiresAtMin, proof, signalHash: hash }
}

/** The device's yes to a first binding, said by the club's key: its signature over KnockBind, s low */
export function signBinding(secret: Hex, key: Hex, nullifier: Hex, expiresAtMin: bigint): { r: Hex; s: Hex } {
  const d = digest('KnockBind', { chainId: BigInt(CHAIN_ID), registry: BINDING, nullifier: BigInt(nullifier), expiresAtMin, key })
  return signDigest(d, secret)
}

/** knockd's binding of the club's key for a human's wallet, from their first proof: a World Chain transaction */
export async function bindWallet(p: FirstProof, node: Hex, key: Hex, sig: { r: Hex; s: Hex }): Promise<Hex> {
  try {
    const sent = await knockd<{ tx: Hex }>(
      '/bind',
      {
        environment: WORLD_ENV,
        nullifier: p.nullifier,
        session: p.session,
        nonce: toHex(p.nonce),
        expiresAtMin: toHex(p.expiresAtMin),
        issuerSchemaId: toHex(PROOF_OF_HUMAN),
        proof: p.proof.map((n) => toHex(n)),
        signalHash: toHex(p.signalHash),
        node,
        key,
        r: sig.r,
        s: sig.s,
      },
      50_000,
    )
    return sent.tx
  } catch (e) {
    if (e instanceof KnockdSaid)
      throw no(e.status >= 500 ? 0 : 4, e.status >= 500 ? 'unavailable' : 'not_bound', `knockd didn't bind you: ${e.message}`)
    throw e
  }
}

const READS = parseAbi([
  'function sessions(uint256 commitment) view returns (uint256 nullifier, uint256 oprfSeed)',
  'function WORLD_ID() view returns (address)',
  'function RP_ID() view returns (uint64)',
  'event Bound(uint256 indexed nullifier, bytes32 indexed keyHash, bytes32 indexed node, uint64 expiresAtMin)',
  'function verifySession(uint64 rpId, uint256 nonce, uint256 signalHash, uint64 expiresAtMin, uint64 issuerSchemaId, uint256 credentialGenesisIssuedAtMin, uint256 sessionId, uint256[2] sessionNullifier, uint256[5] zeroKnowledgeProof) view',
  'error InvalidMerkleRoot()',
  'error UnregisteredIssuerSchemaId()',
  'error ExpirationTooOld()',
  'error ProofInvalid()',
  'error PublicInputNotInField()',
  'error InvalidAction()',
])

export type Bound = { nullifier: Hex; keyHash: Hex; node: Hex }

/** What the club reads on World Chain for World ID visitors */
export interface WorldReads {
  /** The human a Knock session is, their nullifier: 0 when KnockBinding has no such session */
  humanOf(commitment: bigint): Promise<bigint>
  /** World ID's verifier on a session proof: null when it holds, else what it said */
  verifySession(p: SessionProof): Promise<string | null>
  /** The Bound logs KnockBinding made in a transaction: null when World Chain doesn't have it, or it failed */
  bound(tx: Hex): Promise<Bound[] | null>
}

const unavailable = (check: number, e: unknown) =>
  no(check, 'unavailable', `The club couldn't read World Chain, try again: ${(e instanceof Error ? e.message : String(e)).split('\n')[0].replace(/\S+:\/\/\S+/g, '<url>')}`)

/** The reads over World Chain's RPC, through viem. World ID's verifier and Knock's RP come from KnockBinding. */
export function worldReads(world: PublicClient): WorldReads {
  let fixed: Promise<{ verifier: Address; rp: bigint }> | null = null
  const kb = { address: BINDING, abi: READS } as const
  const read = () =>
    (fixed ??= Promise.all([
      world.readContract({ ...kb, functionName: 'WORLD_ID' }),
      world.readContract({ ...kb, functionName: 'RP_ID' }),
    ]).then(([verifier, rp]) => ({ verifier, rp }))).catch((e) => {
      fixed = null
      throw e
    })
  return {
    async humanOf(commitment) {
      try {
        const [nullifier] = await world.readContract({ ...kb, functionName: 'sessions', args: [commitment] })
        return nullifier
      } catch (e) {
        throw unavailable(3, e)
      }
    },
    async verifySession(p) {
      let at: { verifier: Address; rp: bigint }
      try {
        at = await read()
      } catch (e) {
        throw unavailable(4, e)
      }
      try {
        await world.readContract({
          address: at.verifier,
          abi: READS,
          functionName: 'verifySession',
          args: [
            at.rp,
            p.nonce,
            p.signalHash,
            p.expiresAtMin,
            p.issuerSchemaId,
            0n,
            p.commitment,
            p.sessionNullifier,
            p.proof as [bigint, bigint, bigint, bigint, bigint],
          ],
        })
        return null
      } catch (e) {
        const reverted = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null
        if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.reason ?? 'it reverted'
        throw unavailable(4, e)
      }
    },
    async bound(tx) {
      try {
        const r = await world.getTransactionReceipt({ hash: tx })
        if (r.status !== 'success') return null
        return parseEventLogs({ abi: READS, eventName: 'Bound', logs: r.logs })
          .filter((l) => l.address.toLowerCase() === BINDING.toLowerCase())
          .map((l) => ({ nullifier: toHex(l.args.nullifier, { size: 32 }), keyHash: l.args.keyHash, node: l.args.node }))
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null
        throw unavailable(4, e)
      }
    },
  }
}

/** A session proof the club takes: KnockBinding has its session (3), and World ID's verifier holds it (4). It
 *  answers with the human it proves, their nullifier as KnockBinding keeps it. */
export async function proveSession(reads: WorldReads, p: SessionProof): Promise<Hex> {
  const human = await reads.humanOf(p.commitment)
  if (human === 0n) throw no(3, 'no_session', "KnockBinding has no such session, so the club can't say whose it is.")
  const said = await reads.verifySession(p)
  if (said) throw no(4, 'not_proved', `World ID's verifier turned the proof down (${said}). Try again for a new one.`)
  return toHex(human, { size: 32 })
}

/** A first binding the club takes: the Bound log for its key, the visitor's wallet and the proof's human (4) */
export async function checkBound(reads: WorldReads, tx: Hex, want: { nullifier: Hex; key: Hex; node: Hex }) {
  const logs = await reads.bound(tx)
  const { x, y } = uncompressKey(want.key)
  const kh = keyHash(x, y)
  const ok = logs?.some((b) => b.nullifier === want.nullifier.toLowerCase() && b.keyHash === kh && b.node === want.node.toLowerCase())
  if (!ok) throw no(4, 'not_bound', "World Chain has no binding of the club's key for your wallet in knockd's transaction.")
  return kh
}
