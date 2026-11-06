'use client'
import { useEffect, useState } from 'react'
import type { Hex } from 'viem'
import { forget } from '../../lib/bindings'
import { type Device, meet } from '../../lib/device'
import { type Sent, killName } from '../../lib/name'
import type { Connected } from '../../lib/wallet'
import type { Wedgie } from '../../lib/wedgie'
import { SentList } from './Naming'
import { WalletBox } from './WalletBox'

type Phase = 'idle' | 'running' | 'done' | 'stopped'
const WALLET_STEPS = ['Your wallet unregisters the name, so it stops resolving', 'Your wallet unlinks its records']
const ONE_TX = ['Your wallet unregisters the name and unlinks its records, in one transaction']
const AFTER = ['Knock reads it back through ENS', 'The Wedgie forgets its name and binding']

/** The kill switch (D20): the name and the binding it points at, gone for every site, from your wallet. It needs no
 *  Wedgie: a lost or stolen one's name is the reason it's here. getknock.dev/#kill opens it. */
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
  const [told, setTold] = useState<'forgot' | 'revoked' | 'away'>('away')
  const [oneTx, setOneTx] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (device?.name) setName(device.name)
  }, [device?.name])

  // Opened by its address, from the page's own link or the docs
  useEffect(() => {
    const here = () => location.hash === '#kill' && setOpen(true)
    here()
    window.addEventListener('hashchange', here)
    return () => window.removeEventListener('hashchange', here)
  }, [])

  // One transaction when the wallet can batch (D25); it goes back to steps if the wallet won't after all
  useEffect(() => setOneTx(Boolean(wallet?.batch)), [wallet])

  // Only the Wedgie that carries the name forgets: killing a lost one's name leaves the connected one as it is
  const own = wedgie && device?.name === name ? wedgie : null
  const rail = [...(oneTx ? ONE_TX : WALLET_STEPS), ...AFTER]

  async function kill() {
    if (!wallet) return
    // The binding the name points at, which the Console mustn't offer again once the Wedgie forgets it
    const killing = (own && device?.poh?.match(/^eip155:480:tx:(0x[0-9a-f]{64})$/i)?.[1]) || null
    setProblem(null)
    setSent([])
    setPhase('running')
    props.onBusy(true)
    let walletSteps = oneTx ? 1 : 2
    try {
      const out = await killName(own, wallet, name, (s) => {
        if (s.step === 'batch') {
          setOneTx(true)
          walletSteps = 1
          setAt(0)
        }
        if (s.step === 'tx') {
          setOneTx(false)
          walletSteps = 2
          setAt(s.tx.id === 'unregister' ? 0 : 1)
        }
        if (s.step === 'check') setAt(walletSteps)
        if (s.step === 'device') setAt(walletSteps + 1)
      })
      setSent(out.sent)
      setTold(out.wedgie)
      if (own && device && out.wedgie !== 'away') {
        forget(device.key, 'production', killing as Hex | null)
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
  const last = rail.length - 1
  const state = (i: number) =>
    phase === 'done'
      ? i === last && told !== 'forgot'
        ? ''
        : 'done'
      : i < at
        ? 'done'
        : i === at
          ? phase === 'stopped'
            ? 'failed'
            : 'now'
          : ''
  return (
    <details
      id="kill"
      className="kill"
      open={open || running || phase === 'done' || undefined}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <span className="kill-title">Kill switch</span>
        <span className="muted">For a lost or stolen Wedgie, or one you're done with. It needs only your wallet.</span>
      </summary>
      <div className="kill-body">
        <p>
          The wallet that owns the name unregisters it and unlinks its records, wherever the Wedgie is. The binding
          was made for that name only, so no site takes the Wedgie's knocks after that, under any name. If the Wedgie
          is connected here, it forgets its name and binding too.
        </p>
        <p className="muted">
          The binding stays in World Chain's history, pointed at by nothing. You stay you: bind this Wedgie again, or
          another, and World App proves your Knock session for it.
        </p>

        <WalletBox connected={wallet} onConnect={props.onWallet} />

        <label className="field">
          <span>The name to kill</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.trim().toLowerCase())}
            placeholder="wedgie.itzraj.eth"
            spellCheck={false}
            autoComplete="off"
            disabled={running}
          />
        </label>
        <label className="field">
          <span>Type it again</span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value.trim().toLowerCase())}
            spellCheck={false}
            autoComplete="off"
            disabled={running}
          />
        </label>

        <ol className="progress">
          {rail.map((what, i) => (
            <li key={what} className={state(i)}>
              {what}
              {i === last && !wedgie ? (
                <span className="sub">No Wedgie is connected, so it keeps showing the name. Connect it here later, and the Console has it forget the name.</span>
              ) : null}
              {i === last && wedgie && !own && name ? (
                <span className="sub">The connected Wedgie isn't {name}, so it stays as it is.</span>
              ) : null}
            </li>
          ))}
        </ol>
        {problem ? <p className="callout bad">{problem}</p> : null}

        <div className="actions">
          <button
            type="button"
            className="btn stop"
            onClick={kill}
            disabled={!wallet || !name || typed !== name || running || props.busy}
          >
            Kill {name || 'the name'}
          </button>
        </div>

        {phase === 'done' ? (
          <div className="callout" role="status">
            <p className="callout-title">{name} is gone</p>
            <p>
              ENS no longer resolves it, so no site takes this Wedgie's knocks.
              {told === 'forgot' ? ' The Wedgie forgot its name and binding.' : ''}
              {told === 'revoked'
                ? ' This Wedgie runs Knock 4, which can only mark its name revoked, so its home screen keeps showing it. Install Knock 5 or later on it, then kill again: it forgets.'
                : ''}
            </p>
            <SentList sent={sent} />
          </div>
        ) : null}
      </div>
    </details>
  )
}
