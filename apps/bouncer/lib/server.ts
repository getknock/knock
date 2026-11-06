/**
 * The club's server side (D32), in Vercel's functions: its database, the session cookie, its verifier, and the
 * chains, read over public RPCs by default: mainnet for ENS and gifts, World Chain for bindings. Server code only.
 */
import { cookies } from 'next/headers'
import type { NextRequest } from 'next/server'
import { MAX_BINDING_DAYS, type Memory, type Site, rpcChain, strictFrom } from '@knock-dev/verify'
import { type Address, type Hex, TransactionNotFoundError, TransactionReceiptNotFoundError, createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
import { type Me, type SeenTx, memory, sessionOf } from './club'
import { type Db, open } from './db'

const kept = globalThis as { humanClub?: Promise<Db> }

/** The club's database, opened once per function instance: Turso on Vercel, a file here */
export function db(): Promise<Db> {
  const url = process.env.TURSO_DATABASE_URL
  if (!url && process.env.VERCEL) throw new Error('TURSO_DATABASE_URL: the club keeps its records in Turso on Vercel')
  kept.humanClub ??= open(url ?? 'file:human-club.db', process.env.TURSO_AUTH_TOKEN)
  return kept.humanClub
}

export const COOKIE = 'club_session'

/** The human this request's session is, if any */
export async function me(): Promise<Me | null> {
  return sessionOf(await db(), (await cookies()).get(COOKIE)?.value, Date.now())
}

/** The club's origin, what Wedgies sign for: CLUB_ORIGIN, never a request's Host header outside development, since a
 *  proxy can change that */
export function originOf(req: NextRequest): string {
  const set = process.env.CLUB_ORIGIN
  if (set) return set
  if (process.env.NODE_ENV === 'production') throw new Error("CLUB_ORIGIN: the club's origin, as browsers send it")
  return req.nextUrl.origin
}

/** A POST from the club's own pages, or from no browser at all */
export function ours(req: NextRequest): boolean {
  const from = req.headers.get('origin')
  return from === null || from === originOf(req)
}

const eth = createPublicClient({
  chain: mainnet,
  transport: http(process.env.CLUB_ETH_RPC ?? 'https://ethereum-rpc.publicnode.com'),
  batch: { multicall: true },
})

/** The chains as the checks read them: mainnet for ENS, World Chain for bindings */
const chain = rpcChain({ eth, world: process.env.CLUB_WORLD_RPC })

/** The club as its verifier sees it (@knock-dev/verify): its origin, the chains, what it remembers, and the
 *  settings a site has. The KnockBinding is Knock's, unless CLUB_KNOCK_BINDING names a network of one's own. */
export const site = (origin: string, d: Db): Site & { memory: Memory } => ({
  origin,
  chain,
  memory: memory(d),
  contract: (process.env.CLUB_KNOCK_BINDING as Address | undefined) || undefined,
  maxBindingDays: Number(process.env.CLUB_MAX_BINDING_DAYS ?? MAX_BINDING_DAYS),
  strict: strictFrom(process.env.CLUB_STRICT),
})

/** The wallet a Wedgie's name resolves to in ENS (D9), where its fundraisers' gifts go */
export async function walletOf(name: string): Promise<string | null> {
  try {
    return await eth.getEnsAddress({ name })
  } catch {
    return null
  }
}

const notYet = (e: unknown) => e instanceof TransactionReceiptNotFoundError || e instanceof TransactionNotFoundError

/** A gift's transaction as mainnet has it, waiting up to half a minute for the club's node to see it */
export async function seenTx(hash: Hex): Promise<SeenTx | null> {
  for (let i = 0; i < 10; i++) {
    try {
      const [t, r] = await Promise.all([eth.getTransaction({ hash }), eth.getTransactionReceipt({ hash })])
      return { to: t.to ?? null, from: t.from, value: t.value, ok: r.status === 'success', block: Number(r.blockNumber) }
    } catch (e) {
      if (!notYet(e)) throw e
      await new Promise((ok) => setTimeout(ok, 3000))
    }
  }
  return null
}
