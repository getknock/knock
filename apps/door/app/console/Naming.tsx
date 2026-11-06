'use client'
import { useEffect, useState } from 'react'
import type { Hex } from 'viem'
import { recall, remember } from '../../lib/bindings'
import { EXPLORER } from '../../lib/deployments'
import { type Device, meet } from '../../lib/device'
import { type Tx, described, nameProblem, namingTxs, readName } from '../../lib/ens'
import { type Sent, nameWedgie } from '../../lib/name'
import { type Connected, ETHERSCAN } from '../../lib/wallet'
import type { Wedgie } from '../../lib/wedgie'
import { type View, short } from './Screen'
import { WalletBox } from './WalletBox'

type Phase = 'idle' | 'checked' | 'running' | 'done' | 'stopped'

const say = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A binding the name will point at: the Console's own (with the name it was made for), or a pasted one, whose
 *  name nameWedgie checks against its Bound log. */
type Binding = { tx: Hex; name: string | null }

/** Step 2 of the setup (D21): the name, after the binding, since its records point at the binding. The binding
 *  was made for this name (D22): the name is chosen above it. */
export function Naming(props: {
  wedgie: Wedgie | null
  device: Device | null
  label: string
  parent: string
  /** Use another name: the one the Wedgie's binding was made for. */
  onName: (label: string, parent: string) => void
  wallet: Connected | null
  onWallet: (c: Connected) => void
  onDevice: (d: Device) => void
  onView: (v: View | null) => void
  onBusy: (busy: boolean) => void
  /** The binding the Console just made, if it did: production only names. */
  justBound: Binding | null
  /** The binding above is running. */
  locked: boolean
}) {
  const { wedgie, device, wallet, label, parent } = props
  const [binding, setBinding] = useState<Binding | null>(null)
  const [pasted, setPasted] = useState('')
  const [plan, setPlan] = useState<Tx[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [at, setAt] = useState(-1)
  const [sent, setSent] = useState<Sent[]>([])
  const [oneTx, setOneTx] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (device) setBinding(props.justBound ?? recall(device.key, 'production'))
  }, [device, props.justBound])

  const name = `${label}.${parent}`
  // Another name than the binding's: the plan so far is for the old one
  useEffect(() => {
    setPlan(null)
    setPhase((p) => (p === 'running' ? p : 'idle'))
  }, [name])

  const nameIssue = label && parent ? nameProblem(label, parent) : null
  const otherName = binding?.name && binding.name !== name ? binding.name : null
  const ready = Boolean(
    wedgie && device && wallet && binding && !otherName && label && parent && !nameIssue && !props.locked,
  )
  // The rail: the binding, BECOME, the wallet's transactions, ENS read back, the Wedgie told
  const walletRail =
    plan && oneTx && plan.length > 1
      ? [described(plan)]
      : (plan ?? [{ what: 'Your wallet: the records, then the name' } as Tx]).map((t) => t.what)
  const rail = [
    'Read the binding back from World Chain',
    'BECOME on the Wedgie: press green',
    ...walletRail,
    'Read the name back through ENS',
    'Tell the Wedgie: its Human badge',
  ]
  const stepClass = (i: number) =>
    phase === 'done' || i < at ? 'done' : i === at ? (phase === 'stopped' ? 'failed' : 'now') : ''

  async function check() {
    if (!wallet || !device) return
    setProblem(null)
    try {
      // The plan as it stands, with stand-in records: what each transaction is doesn't depend on them
      const s = await readName(wallet.chain, wallet.account, label, parent)
      setPlan(namingTxs(s, { wallet: wallet.account, key: device.key, nullifier: '0x', poh: '', sc: device.sc }))
      setOneTx(wallet.batch) // one transaction when the wallet can batch (D25)
      setPhase('checked')
      setAt(-1)
    } catch (e) {
      setPlan(null)
      setProblem(say(e))
    }
  }

  async function run() {
    if (!wedgie || !device || !wallet || !binding || !plan) return
    setProblem(null)
    setSent([])
    setPhase('running')
    props.onBusy(true)
    let n = plan.length
    let walletSteps = oneTx && n > 1 ? 1 : n
    try {
      const out = await nameWedgie(wedgie, wallet, device, label, parent, binding.tx, (s) => {
        if (s.step === 'binding') setAt(0)
        if (s.step === 'plan') {
          n = s.txs.length
          walletSteps = oneTx && n > 1 ? 1 : n
          setPlan(s.txs)
        }
        if (s.step === 'device') {
          setAt(1)
          props.onView({ kind: 'become', name })
        }
        if (s.step === 'batch') {
          props.onView(null)
          setOneTx(true)
          walletSteps = 1
          setAt(2)
        }
        if (s.step === 'tx') {
          props.onView(null)
          setOneTx(false) // the wallet won't batch after all: one at a time
          walletSteps = s.n
          setAt(2 + s.i)
        }
        if (s.step === 'check') setAt(2 + walletSteps)
        if (s.step === 'confirm') setAt(3 + walletSteps)
      })
      setSent(out.sent)
      remember(device.key, 'production', { tx: binding.tx, name }) // a pasted one too, now that it's checked
      props.onDevice(await meet(wedgie))
      setPhase('done')
    } catch (e) {
      setPhase('stopped')
      setProblem(say(e))
    } finally {
      props.onView(null)
      props.onBusy(false)
    }
  }

  const running = phase === 'running'
  return (
    <section aria-labelledby="name-title" className="part">
      <h2 id="name-title">Name it in ENS</h2>
      <p className="lede">
        Sites find the Wedgie by its ENS name. The name's records hold the Wedgie's key and point at its binding on
        World Chain, so it comes after the binding. Your wallet sends each transaction, on Ethereum mainnet.
      </p>

      <h3>The binding it points at</h3>
      {binding && otherName ? (
        <div className="field">
          <p>
            The Wedgie's World App binding is for {otherName}, and a binding counts for its own name only. Bind it again
            above for {label && parent ? name : 'the new name'}, or name it {otherName}.
          </p>
          <div className="actions">
            <button
              type="button"
              className="quiet"
              disabled={running}
              onClick={() => {
                const at = otherName.indexOf('.')
                props.onName(otherName.slice(0, at), otherName.slice(at + 1))
              }}
            >
              Name it {otherName}
            </button>
          </div>
        </div>
      ) : binding ? (
        <p>
          World App binding{binding.name ? ` for ${binding.name}` : ''},{' '}
          <a href={`${EXPLORER}/tx/${binding.tx}`} target="_blank" rel="noreferrer">
            transaction <span className="hex">{short(binding.tx)}</span>
          </a>
          .
        </p>
      ) : (
        <div className="field">
          <p>Bind the Wedgie with World App first, above. Or paste the transaction of a binding it already has:</p>
          <div className="actions">
            <input
              className="hex"
              value={pasted}
              onChange={(e) => setPasted(e.target.value.trim())}
              placeholder="0x… on World Chain"
              aria-label="A binding's transaction hash"
              spellCheck={false}
            />
            <button
              type="button"
              className="quiet"
              disabled={!/^0x[0-9a-fA-F]{64}$/.test(pasted)}
              onClick={() => setBinding({ tx: pasted.toLowerCase() as Hex, name: null })}
            >
              Use it
            </button>
          </div>
        </div>
      )}

      <h3>Your wallet</h3>
      <WalletBox connected={wallet} onConnect={props.onWallet} />

      <h3>The name</h3>
      <p>{label && parent ? name : 'Pick it above, before the binding.'}</p>
      {nameIssue ? <p className="problem">{nameIssue}</p> : null}

      <ol className="steps">
        {rail.map((what, i) => (
          <li key={what} className={stepClass(i)}>
            <div>
              <strong>{what}</strong>
            </div>
          </li>
        ))}
      </ol>
      {problem ? <p className="problem">{problem}</p> : null}

      <div className="actions">
        {phase === 'checked' || phase === 'stopped' ? (
          <button type="button" className="primary" onClick={run} disabled={!ready}>
            Name it {name}
          </button>
        ) : (
          <button type="button" className="primary" onClick={check} disabled={!ready || running}>
            Check the name
          </button>
        )}
        {running ? <p>Watch the Wedgie, then your wallet.</p> : null}
      </div>

      {phase === 'done' ? (
        <div className="bound" role="status">
          <h3>{name} is live</h3>
          <p>
            ENS resolves it to your wallet, with Knock's records, and the Wedgie shows its Human badge.{' '}
            <a href={`https://app.ens.domains/${name}`} target="_blank" rel="noreferrer">
              See it in the ENS app
            </a>
            .
          </p>
          <ul className="sent">
            {sent.map((s) => (
              <li key={s.hash}>
                <a href={`${ETHERSCAN}/tx/${s.hash}`} target="_blank" rel="noreferrer">
                  {described(s.txs)}
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
