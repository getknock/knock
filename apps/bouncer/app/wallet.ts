/**
 * The giver's wallet, the browser's own (EIP-6963): a gift is a plain transfer of ETH on mainnet, from that wallet
 * straight to the fundraiser's. The club never holds a key or any ETH.
 */
import { type Address, type EIP1193Provider, type Hex, numberToHex } from 'viem'

export type Injected = { info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider }

/** Wallets as they announce themselves (EIP-6963); returns the unsubscribe */
export function discover(on: (w: Injected) => void): () => void {
  const heard = (e: Event) => on((e as CustomEvent<Injected>).detail)
  window.addEventListener('eip6963:announceProvider', heard)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  return () => window.removeEventListener('eip6963:announceProvider', heard)
}

const MAINNET = '0x1'

/** The wallet's first account, on mainnet: it's asked to switch if it's elsewhere */
export async function connect(w: Injected): Promise<Address> {
  const p = w.provider
  const [account] = (await p.request({ method: 'eth_requestAccounts' })) as Address[]
  if (!account) throw new Error(`${w.info.name} gave no account.`)
  if ((await p.request({ method: 'eth_chainId' })) !== MAINNET) {
    try {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MAINNET }] })
    } catch {
      throw new Error(`Switch ${w.info.name} to Ethereum mainnet: gifts are ETH there.`)
    }
  }
  return account
}

/** Sends the gift: exactly `value` wei to `to`, from `from`. Resolves with the transaction's hash. */
export async function give(w: Injected, from: Address, to: Address, value: bigint): Promise<Hex> {
  return (await w.provider.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, value: numberToHex(value) }],
  })) as Hex
}

/** A wallet's no, in words: the person closing it says nothing */
export function walletNo(e: unknown): string | null {
  const code = (e as { code?: number })?.code
  if (code === 4001) return null
  const m = e instanceof Error ? e.message : String(e)
  return m.split('\n')[0]
}

export const ETHERSCAN = 'https://etherscan.io'
export const WORLDSCAN = 'https://worldscan.org'
