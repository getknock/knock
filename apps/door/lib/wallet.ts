/**
 * The user's wallet, the browser's own (EIP-6963): it signs and pays for every ENS write, on Ethereum mainnet.
 * The Console holds no key. Each transaction is simulated first, so one ENS would refuse never reaches the wallet.
 *
 * A wallet that can send several calls as one atomic transaction (EIP-5792; a smart account, or an account EIP-7702
 * lets act as one) gets each of naming's and the kill switch's calls as one batch: one confirmation, one
 * transaction, all of it or none (D25). Any other gets them one at a time.
 */
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  custom,
  decodeErrorResult,
  http,
  numberToHex,
  parseAbi,
} from 'viem'
import { mainnet } from 'viem/chains'
import { Stopped } from './stopped'
import { ENS } from './ens'

export type Injected = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider }

/** Wallets as they announce themselves (EIP-6963); returns the unsubscribe. */
export function discover(on: (w: Injected) => void): () => void {
  const heard = (e: Event) => on((e as CustomEvent<Injected>).detail)
  window.addEventListener('eip6963:announceProvider', heard)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  return () => window.removeEventListener('eip6963:announceProvider', heard)
}

export type Connected = {
  name: string
  account: Address
  chain: PublicClient
  wallet: WalletClient
  /** It says it can send a batch of calls as one atomic transaction on mainnet (EIP-5792). */
  batch: boolean
}

const MAINNET = `0x${ENS.chainId.toString(16)}`

/** The wallet's first account, on mainnet: it's asked to switch if it's elsewhere. */
export async function connect(w: Injected): Promise<Connected> {
  const p = w.provider
  const [account] = (await p.request({ method: 'eth_requestAccounts' })) as Address[]
  if (!account) throw new Stopped(`${w.info.name} gave no account.`)
  if ((await p.request({ method: 'eth_chainId' })) !== MAINNET) {
    try {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MAINNET }] })
    } catch {
      throw new Stopped(`Switch ${w.info.name} to Ethereum mainnet: names live there.`)
    }
  }
  const wallet = createWalletClient({ account, chain: mainnet, transport: custom(p) })
  return {
    name: w.info.name,
    account,
    chain: createPublicClient({ chain: mainnet, transport: custom(p) }),
    wallet,
    batch: await canBatch(wallet, account),
  }
}

/** Whether the wallet sends a batch of calls atomically on mainnet: ready now, or once the user agrees to it. */
export async function canBatch(wallet: WalletClient, account: Address): Promise<boolean> {
  try {
    const all = await wallet.request({ method: 'wallet_getCapabilities', params: [account, [numberToHex(mainnet.id)]] })
    // Mainnet's own, or 0x0: what the wallet can do on every chain
    const caps = (Object.entries(all).find(([id]) => Number(id) === mainnet.id)?.[1] ?? all['0x0']) as
      | { atomic?: { status?: string }; atomicBatch?: { supported?: boolean } }
      | undefined
    const status = caps?.atomic?.status
    return status === 'ready' || status === 'supported' || caps?.atomicBatch?.supported === true // the last: EIP-5792's first draft
  } catch {
    return false // no wallet_getCapabilities: one call a transaction
  }
}

/** ENSv2's refusals, by name (contracts-v2: EnhancedAccessControl, PermissionedRegistry, the resolver). */
const ensErrors = parseAbi([
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error LabelAlreadyRegistered(string label)',
  'error LabelAlreadyReserved(string label)',
  'error LabelExpired(uint256 tokenId)',
  'error CannotSetPastExpiry(uint64 expiry)',
  'error InvalidRecord()',
  'error InvalidEVMAddress(bytes addressBytes)',
])

const WHY: Record<string, string> = {
  EACUnauthorizedAccountRoles: "this wallet doesn't hold the role it takes",
  LabelAlreadyRegistered: 'the name was registered meanwhile',
  LabelExpired: 'the name has expired',
}

/** Revert data as ENSv2's error, by name. */
function why(data: Hex): string {
  try {
    const name = decodeErrorResult({ abi: ensErrors, data }).errorName
    return WHY[name] ? `${name}: ${WHY[name]}` : name
  } catch {
    return data.length >= 10 ? `revert ${data.slice(0, 10)}` : 'a revert'
  }
}

/** The JSON-RPC error code under viem's wrapping, if any. */
function codeOf(e: unknown): number | undefined {
  const x = e instanceof BaseError ? e.walk((y) => typeof (y as { code?: unknown }).code === 'number') : e
  const code = (x as { code?: unknown } | null)?.code
  return typeof code === 'number' ? code : undefined
}

const said = (e: unknown) => codeOf(e) === 4001 || /reject|denied/i.test(String((e as Error)?.message))

function refusal(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError || (x as { data?: unknown }).data !== undefined)
    const data = (r as { data?: unknown } | null)?.data
    if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10)
      try {
        const name = decodeErrorResult({ abi: ensErrors, data: data as Hex }).errorName
        return WHY[name] ? `${name}: ${WHY[name]}` : name
      } catch {
        return `revert ${data.slice(0, 10)}`
      }
    return e.shortMessage
  }
  return String(e)
}

/** One transaction: simulated, then the wallet's, then its receipt. */
export async function send(c: Connected, tx: { to: Address; data: Hex; what: string }) {
  try {
    await c.chain.call({ account: c.account, to: tx.to, data: tx.data })
  } catch (e) {
    throw new Stopped(`ENS would refuse "${tx.what}" (${refusal(e)}). Nothing was sent.`)
  }
  let hash: Hex
  try {
    hash = await c.wallet.sendTransaction({ account: c.account, chain: mainnet, to: tx.to, data: tx.data })
  } catch (e) {
    if (said(e)) throw new Stopped(`You said no in ${c.name}: nothing was sent.`)
    throw new Stopped(`${c.name} didn't send it: ${refusal(e)}`)
  }
  const r = await c.chain.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Stopped(`The transaction failed on chain: ${hash}`)
  return { hash, gasUsed: r.gasUsed }
}

// eth_simulateV1, where the wallet's own RPC doesn't answer it: the public node the verifier reads mainnet from
const PUBLIC = createPublicClient({ chain: mainnet, transport: http('https://ethereum-rpc.publicnode.com') })

/** The calls in order, from the wallet, in one block (eth_simulateV1): each sees what the ones before it did. */
async function simulateTogether(c: Connected, txs: { to: Address; data: Hex; what: string }[]) {
  const calls = txs.map(({ to, data }) => ({ to, data }))
  let results: readonly { status: string; data: Hex }[]
  try {
    results = (await c.chain.simulateCalls({ account: c.account, calls })).results
  } catch {
    try {
      results = (await PUBLIC.simulateCalls({ account: c.account, calls })).results
    } catch (e) {
      throw new Stopped(`Couldn't simulate them together (${refusal(e)}). Nothing was sent.`)
    }
  }
  const i = results.findIndex((r) => r.status !== 'success')
  if (i >= 0) throw new Stopped(`ENS would refuse "${txs[i].what}" (${why(results[i].data)}). Nothing was sent.`)
}

/** Atomic batches a wallet can't do after all: unsupported (5700, 5760), not on mainnet (5710), too many calls
 *  (5740), the user kept their plain account (5750), no wallet_sendCalls (4200, -32601), or a request it doesn't
 *  read (-32602: an older draft). Nothing was sent: the calls then go one at a time. */
const NO_BATCH = new Set([5700, 5710, 5740, 5750, 5760, 4200, -32601, -32602])

/**
 * Every call, in order, as one atomic transaction: simulated together, then the wallet's, then its receipt. Null
 * when the wallet won't batch them after all, before anything was sent: the caller sends them one at a time.
 */
export async function sendBatch(c: Connected, txs: { to: Address; data: Hex; what: string }[]) {
  await simulateTogether(c, txs)
  let id: string
  try {
    ;({ id } = await c.wallet.sendCalls({
      account: c.account,
      chain: mainnet,
      calls: txs.map(({ to, data }) => ({ to, data })),
      forceAtomic: true,
    }))
  } catch (e) {
    const code = codeOf(e)
    if (code !== undefined && NO_BATCH.has(code)) return null
    if (said(e)) throw new Stopped(`You said no in ${c.name}: nothing was sent.`)
    throw new Stopped(`${c.name} didn't send them: ${refusal(e)}`)
  }
  let s: Awaited<ReturnType<typeof c.wallet.waitForCallsStatus>>
  try {
    s = await c.wallet.waitForCallsStatus({ id, timeout: 300_000 })
  } catch {
    throw new Stopped(`${c.name} hasn't said whether it went through. Look in ${c.name}, then run this again: done steps are skipped.`)
  }
  const receipts = s.receipts ?? []
  if (s.status !== 'success' || !receipts.length || receipts.some((r) => r.status !== 'success'))
    throw new Stopped(
      `The transaction didn't go through${receipts[0] ? ` (${receipts[0].transactionHash})` : ''}: being one, none of it took effect.`,
    )
  return {
    hash: receipts[receipts.length - 1].transactionHash,
    gasUsed: receipts.reduce((g, r) => g + BigInt(r.gasUsed), 0n),
    atomic: s.atomic,
  }
}

export const ETHERSCAN = 'https://etherscan.io'
