/**
 * The user's wallet, the browser's own (EIP-6963): it signs and pays for every ENS write, on Ethereum mainnet.
 * The Console holds no key. Each transaction is simulated first, so one ENS would refuse never reaches the wallet.
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

export type Connected = { name: string; account: Address; chain: PublicClient; wallet: WalletClient }

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
  return {
    name: w.info.name,
    account,
    chain: createPublicClient({ chain: mainnet, transport: custom(p) }),
    wallet: createWalletClient({ account, chain: mainnet, transport: custom(p) }),
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
    if ((e as { code?: number }).code === 4001 || /reject|denied/i.test(String((e as Error).message)))
      throw new Stopped(`You said no in ${c.name}: nothing was sent.`)
    throw new Stopped(`${c.name} didn't send it: ${refusal(e)}`)
  }
  const r = await c.chain.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Stopped(`The transaction failed on chain: ${hash}`)
  return { hash, gasUsed: r.gasUsed }
}

export const ETHERSCAN = 'https://etherscan.io'
