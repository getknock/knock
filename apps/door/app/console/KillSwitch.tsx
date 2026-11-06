'use client'
import { useEffect, useState } from 'react'
import { forget } from '../../lib/bindings'
import { type Device, meet } from '../../lib/device'
import { type Sent, killName } from '../../lib/name'
import { type Connected, ETHERSCAN } from '../../lib/wallet'
import type { Wedgie } from '../../lib/wedgie'
import { WalletBox } from './WalletBox'

type Phase = 'idle' | 'running' | 'done' | 'stopped'
const RAIL = ['Unregister the name: it stops resolving', 'Unlink its records', 'Read it back through ENS', 'The Wedgie forgets its name and binding']

/** The kill switch (D20): the name and the binding it points at, gone for every site, from your wallet. */
export function KillSwitch(props: {
  wedgie: Wedgie | null
  device: Device | null
  wallet: Connected | null
  onWallet: (c: Connected) => void
  onDevice: (d: Device) => void
  onBusy: (busy: boolean) => void
  busy: boolean
}) {
  const { wedgie, device, wallet } = props
  const [name, setName] = useState('')
  const [typed, setTyped] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [at, setAt] = useState(-1)
  const [sent, setSent] = useState<Sent[]>([])
  const [forgotten, setForgotten] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (device?.name) setName(device.name)
  }, [device?.name])

  // Only the Wedgie that carries the name forgets: killing a lost one's name leaves the connected one as it is
  const own = wedgie && device?.name === name ? wedgie : null

  async function kill() {
    if (!wallet) return
    setProblem(null)
    setSent([])
    setPhase('running')
    props.onBusy(true)
    try {
      const out = await killName(own, wallet, name, (s) => {
        if (s.step === 'tx') setAt(s.tx.id === 'unregister' ? 0 : 1)
        if (s.step === 'check') setAt(2)
        if (s.step === 'device') setAt(3)
      })
      setSent(out.sent)
      setForgotten(out.forgotten)
      if (own && device && out.forgotten) {
        forget(device.key, 'production')
        props.onDevice(await meet(own))
      }
      setPhase('done')
    } catch (e) {
      setPhase('stopped')
      setProblem(e instanceof Error ? e.message : String(e))
    } finally {
      props.onBusy(false)
    }
  }

  const running = phase === 'running'
  const stepClass = (i: number) =>
    phase === 'done' ? (i === 3 && !forgotten ? '' : 'done') : i < at ? 'done' : i === at ? (phase === 'stopped' ? 'failed' : 'now') : ''
  return (
    <section aria-labelledby="kill-title" className="part danger">
      <h2 id="kill-title">Kill switch</h2>
      <p className="lede">
        For a lost Wedgie, or one you're done with. Your wallet unregisters its name and unlinks the records. Its
        binding was made for that name only, so from then on no site takes its knocks, under any name. If the Wedgie is
        here, it forgets its name and binding too. The binding stays in World Chain's history, but counts for nothing.
        You stay you: bind this Wedgie again, or another, and World App proves your Knock session for it.
      </p>

      <h3>Your wallet</h3>
      <WalletBox connected={wallet} onConnect={props.onWallet} />

      <label className="field">
        <span>The name to kill</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value.trim().toLowerCase())}
          placeholder="wedgie.itzraj.eth"
          spellCheck={false}
          disabled={running}
        />
      </label>
      <label className="field">
        <span>Type the name again to kill it</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value.trim().toLowerCase())} spellCheck={false} disabled={running} />
      </label>

      <ol className="steps">
        {RAIL.map((what, i) => (
          <li key={what} className={stepClass(i)}>
            <div>
              <strong>{what}</strong>
              {i === 3 && !wedgie ? <p>No Wedgie connected: it keeps showing the name until you connect it and kill again.</p> : null}
              {i === 3 && wedgie && !own && name ? (
                <p>The connected Wedgie isn't {name}, so it stays as it is.</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {problem ? <p className="problem">{problem}</p> : null}

      <div className="actions">
        <button
          type="button"
          className="kill"
          onClick={kill}
          disabled={!wallet || !name || typed !== name || running || props.busy}
        >
          Kill {name || 'the name'}
        </button>
      </div>

      {phase === 'done' ? (
        <div className="bound" role="status">
          <h3>{name} is gone</h3>
          <p>
            ENS no longer resolves it, so no site takes this Wedgie's knocks.
            {forgotten ? ' The Wedgie forgot its name and binding.' : ''}
          </p>
          <ul className="sent">
            {sent.map((s) => (
              <li key={s.hash}>
                <a href={`${ETHERSCAN}/tx/${s.hash}`} target="_blank" rel="noreferrer">
                  {s.tx.what}
                </a>
                , {s.gasUsed.toLocaleString()} gas
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
