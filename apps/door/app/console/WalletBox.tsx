'use client'
import { useEffect, useState } from 'react'
import { type Connected, type Injected, connect, discover } from '../../lib/wallet'
import { short } from './Screen'

/** The browser's wallets (EIP-6963), and the one connected: it signs and pays for every ENS write. */
export function WalletBox({ connected, onConnect }: { connected: Connected | null; onConnect: (c: Connected) => void }) {
  const [wallets, setWallets] = useState<Injected[]>([])
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(
    () =>
      discover((w) => setWallets((ws) => (ws.some((x) => x.info.uuid === w.info.uuid) ? ws : [...ws, w]))),
    [],
  )

  if (connected)
    return (
      <p className="wallet">
        <span className="dot on" aria-hidden="true" />
        <span>
          {connected.name}, <code>{short(connected.account)}</code>, on Ethereum.{' '}
          <span className="muted">
            {connected.batch ? 'It sends each step as one transaction.' : 'It sends each ENS write as its own transaction.'}
          </span>
        </span>
      </p>
    )
  return (
    <div className="wallet">
      {wallets.length ? (
        <div className="actions">
          {wallets.map((w) => (
            <button
              key={w.info.uuid}
              type="button"
              className="btn"
              onClick={async () => {
                setProblem(null)
                try {
                  onConnect(await connect(w))
                } catch (e) {
                  setProblem(e instanceof Error ? e.message : String(e))
                }
              }}
            >
              <img src={w.info.icon} alt="" width={20} height={20} /> Connect {w.info.name}
            </button>
          ))}
        </div>
      ) : (
        <p className="callout">No wallet in this browser. Add one, such as MetaMask or Rabby, then reload this page.</p>
      )}
      {problem ? <p className="callout bad">{problem}</p> : null}
    </div>
  )
}
