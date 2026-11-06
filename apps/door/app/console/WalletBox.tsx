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
        <span className="dot ready" /> {connected.name}, <span className="hex">{short(connected.account)}</span>, on
        Ethereum.
        {connected.batch
          ? ' It batches calls: each step is one transaction, all of it or none.'
          : " It doesn't batch calls, so each ENS write is its own transaction."}
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
              className="quiet"
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
        <p>No wallet in this browser. Add one, like MetaMask or Rabby, then reload the page.</p>
      )}
      {problem ? <p className="problem">{problem}</p> : null}
    </div>
  )
}
