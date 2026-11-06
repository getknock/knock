import { EXPLORER } from '../../lib/deployments'
import { ETHERSCAN } from '../../lib/wallet'
import { short } from './Screen'

/** A transaction, on World Chain's explorer or, for ENS's, Etherscan. */
export function TxLink({ tx, on = 'world', children }: { tx: string; on?: 'world' | 'ethereum'; children?: string }) {
  return (
    <a href={`${on === 'world' ? EXPLORER : ETHERSCAN}/tx/${tx}`} target="_blank" rel="noreferrer">
      {children ?? 'transaction'} <code>{short(tx)}</code>
    </a>
  )
}
