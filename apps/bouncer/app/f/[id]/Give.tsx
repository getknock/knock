'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { type Address, type Hex, formatEther } from 'viem'
import { LIMITS } from '../../../lib/intent'
import { Act } from '../../Act'
import { ETHERSCAN, type Injected, connect, discover, give, walletNo } from '../../wallet'

type Phase =
  | { at: 'idle' }
  | { at: 'asking' }
  | { at: 'sending'; value: string; to: string }
  | { at: 'counting'; ref: string; tx: Hex; value: string }
  | { at: 'unseen'; ref: string; tx: Hex; value: string; human: boolean; why: string }
  | { at: 'given'; tx: Hex; value: string; human: boolean }

async function post(path: string, body: unknown) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => null)
  if (!j?.ok) throw Object.assign(new Error(j?.why ?? `The club said ${r.status}.`), { error: j?.error as string | undefined })
  return j
}

/** A gift: from the giver's wallet straight to the fundraiser's, which the club then finds on mainnet and counts */
export function Give({ fundraiser, name, inSession }: { fundraiser: number; name: string; inSession: boolean }) {
  const router = useRouter()
  const [wallets, setWallets] = useState<Injected[]>([])
  const [amount, setAmount] = useState('0.01')
  const [message, setMessage] = useState('')
  const [showFrom, setShowFrom] = useState(false)
  const [phase, setPhase] = useState<Phase>({ at: 'idle' })
  const [why, setWhy] = useState<string | null>(null)

  useEffect(
    () => discover((w) => setWallets((ws) => (ws.some((x) => x.info.uuid === w.info.uuid) ? ws : [...ws, w]))),
    [],
  )

  async function count(ref: string, tx: Hex, value: string, human: boolean) {
    setPhase({ at: 'counting', ref, tx, value })
    try {
      await post('/api/gifts/confirm', { ref, tx })
      setPhase({ at: 'given', tx, value, human })
      router.refresh()
    } catch (e) {
      setPhase({ at: 'unseen', ref, tx, value, human, why: (e as Error).message })
    }
  }

  async function start(w: Injected) {
    setWhy(null)
    setPhase({ at: 'asking' })
    try {
      const from = await connect(w)
      const g = await post('/api/gifts', { fundraiser, amount, message, showFrom })
      setPhase({ at: 'sending', value: g.value, to: g.to })
      const tx = await give(w, from, g.to as Address, BigInt(g.value))
      await count(g.ref, tx, g.value, g.human === true)
    } catch (e) {
      setPhase({ at: 'idle' })
      setWhy(walletNo(e))
    }
  }

  if (phase.at === 'given')
    return (
      <div className="form given" role="status">
        <p className="stamp in">Given</p>
        <p>
          {formatEther(BigInt(phase.value))} ETH went to {name}.{' '}
          <a href={`${ETHERSCAN}/tx/${phase.tx}`}>See it on Etherscan</a>.
        </p>
        {phase.human ? <p className="fine">You gave in your club session, so it counts you among the humans who gave.</p> : null}
      </div>
    )

  const busy = phase.at !== 'idle' && phase.at !== 'unseen'
  return (
    <form className="form" onSubmit={(e) => e.preventDefault()}>
      <label>
        <span>How much, in ETH</span>
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
      </label>
      <label>
        <span>A message for {name}, if you'd like</span>
        <textarea rows={2} maxLength={LIMITS.message[1]} value={message} onChange={(e) => setMessage(e.target.value)} disabled={busy} />
      </label>
      <label className="check">
        <input type="checkbox" checked={showFrom} onChange={(e) => setShowFrom(e.target.checked)} disabled={busy} />
        <span>Show my address and transaction with my gift</span>
      </label>

      {phase.at === 'idle' || phase.at === 'asking' ? (
        wallets.length ? (
          <div className="wallets">
            {wallets.map((w) => (
              <button key={w.info.uuid} type="button" className="knocker" onClick={() => start(w)} disabled={busy}>
                <img src={w.info.icon} alt="" width={22} height={22} /> Give with {w.info.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="hint">
            No wallet here. Giving needs a wallet in this browser that announces itself (EIP-6963), such as MetaMask
            or Rabby.
          </p>
        )
      ) : null}
      {phase.at === 'sending' ? (
        <p className="said" role="status">
          Your wallet asks you to send {formatEther(BigInt(phase.value))} ETH. Its last digits tell the club which gift
          is yours.
        </p>
      ) : null}
      {phase.at === 'counting' ? (
        <p className="said" role="status">
          Sent. The club is finding it on mainnet…
        </p>
      ) : null}
      {phase.at === 'unseen' ? (
        <div className="said" role="status">
          <p>{phase.why}</p>
          <button type="button" className="plain" onClick={() => count(phase.ref, phase.tx, phase.value, phase.human)}>
            Count my gift
          </button>
        </div>
      ) : null}
      {why ? (
        <p className="said out" role="alert">
          {why}
        </p>
      ) : null}
      <p className="fine">
        {inSession
          ? "It goes straight from your wallet to theirs. You're in the club, so it also counts you among the humans who gave."
          : 'It goes straight from your wallet to theirs. Knock in first, and it also counts you among the humans who gave.'}
      </p>
    </form>
  )
}

/** For its starter: close it to new gifts */
export function Stop({ fundraiser }: { fundraiser: number }) {
  return (
    <div className="form close">
      <p className="legend">You started this fundraiser. Close it to new gifts?</p>
      <Act label="Knock to close it" intent={() => ({ act: 'stop', fundraiser })} list={false} />
    </div>
  )
}
