'use client'
import { useCallback, useEffect, useState } from 'react'
import type { Hex } from 'viem'
import { type Device, meet } from '../../lib/device'
import { type Tx, described, namingTxs, readName } from '../../lib/ens'
import { type Sent, nameWedgie } from '../../lib/name'
import type { Connected } from '../../lib/wallet'
import type { Wedgie } from '../../lib/wedgie'
import type { View } from './Screen'
import { TxLink } from './TxLink'
import { WalletBox } from './WalletBox'

type Phase = 'idle' | 'running' | 'stopped'

const say = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Step 4 (D21): the name in ENS, after the binding, since its records point at it. BECOME on the Wedgie, then the
 *  wallet's transactions, then ENS read back as any verifier reads it, then the Wedgie told. */
export function Naming(props: {
  wedgie: Wedgie
  device: Device
  label: string
  parent: string
  /** The binding's transaction, on World Chain */
  binding: Hex
  wallet: Connected | null
  onWallet: (c: Connected) => void
  onNamed: (device: Device, sent: Sent[]) => void
  onView: (v: View | null) => void
  onBusy: (busy: boolean) => void
}) {
  const { wedgie, device, wallet, label, parent } = props
  const [plan, setPlan] = useState<Tx[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [at, setAt] = useState(-1)
  const [oneTx, setOneTx] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const { onView, onBusy } = props
  const name = `${label}.${parent}`
  const tx = props.binding
  const running = phase === 'running'

  useEffect(
    () => () => {
      onView(null)
      onBusy(false)
    },
    [onView, onBusy],
  )

  // What the wallet will be asked for, as things stand: what each transaction is doesn't depend on the records
  const check = useCallback(async () => {
    if (!wallet) return
    setProblem(null)
    try {
      const s = await readName(wallet.chain, wallet.account, label, parent)
      setPlan(namingTxs(s, { wallet: wallet.account, key: device.key, nullifier: '0x', poh: '', sc: device.sc }))
      setOneTx(wallet.batch) // one transaction when the wallet can batch (D25)
    } catch (e) {
      setPlan(null)
      setProblem(say(e))
    }
  }, [wallet, label, parent, device.key, device.sc])

  useEffect(() => {
    check()
  }, [check])

  // The rail: the binding, BECOME, the wallet's transactions, ENS read back, the Wedgie told
  const walletRail =
    plan && oneTx && plan.length > 1 ? [described(plan)] : (plan ?? [{ what: 'Your wallet writes the name' } as Tx]).map((t) => t.what)
  const rail = [
    'Knock reads the binding back from World Chain',
    'Press green on your Wedgie\'s BECOME page',
    ...walletRail,
    'Knock reads the name back through ENS',
    'Your Wedgie learns its name and shows its Human badge',
  ]
  const state = (i: number) => (i < at ? 'done' : i === at ? (phase === 'stopped' ? 'failed' : 'now') : '')

  async function run() {
    if (!wallet || !plan) return
    setProblem(null)
    setPhase('running')
    onBusy(true)
    let n = plan.length
    let walletSteps = oneTx && n > 1 ? 1 : n
    try {
      const out = await nameWedgie(wedgie, wallet, device, label, parent, tx, (s) => {
        if (s.step === 'binding') setAt(0)
        if (s.step === 'plan') {
          n = s.txs.length
          walletSteps = oneTx && n > 1 ? 1 : n
          setPlan(s.txs)
        }
        if (s.step === 'device') {
          setAt(1)
          onView({ kind: 'become', name })
        }
        if (s.step === 'batch') {
          onView(null)
          setOneTx(true)
          walletSteps = 1
          setAt(2)
        }
        if (s.step === 'tx') {
          onView(null)
          setOneTx(false) // the wallet won't batch after all: one at a time
          walletSteps = s.n
          setAt(2 + s.i)
        }
        if (s.step === 'check') setAt(2 + walletSteps)
        if (s.step === 'confirm') setAt(3 + walletSteps)
      })
      setPhase('idle')
      props.onNamed(await meet(wedgie), out.sent)
    } catch (e) {
      setPhase('stopped')
      setProblem(say(e))
    } finally {
      onView(null)
      onBusy(false)
    }
  }

  return (
    <>
      <p>
        The name's records hold your Wedgie's key and point at its binding. Your wallet writes them on Ethereum, after
        your Wedgie agrees to the name.
      </p>

      <p className="note">
        The records point at the binding in <TxLink tx={tx} />.
      </p>

      <WalletBox connected={wallet} onConnect={props.onWallet} />

      <ol className="progress">
        {rail.map((what, i) => (
          <li key={what} className={state(i)}>
            {what}
          </li>
        ))}
      </ol>
      {problem ? <p className="callout bad">{problem}</p> : null}

      <div className="actions">
        <button type="button" className="btn go" onClick={run} disabled={!wallet || !plan || running}>
          Name it {name}
        </button>
        {running ? <p className="note">Watch your Wedgie, then your wallet.</p> : null}
        {!running && problem && wallet ? (
          <button type="button" className="btn" onClick={check}>
            Check again
          </button>
        ) : null}
      </div>
    </>
  )
}

/** What naming sent, for the done step: each transaction on Etherscan. */
export function SentList({ sent }: { sent: Sent[] }) {
  if (!sent.length) return null
  return (
    <ul className="sent">
      {sent.map((s) => (
        <li key={s.hash}>
          <TxLink tx={s.hash} on="ethereum">
            {described(s.txs)}
          </TxLink>
          , {s.gasUsed.toLocaleString()} gas
        </li>
      ))}
    </ul>
  )
}
