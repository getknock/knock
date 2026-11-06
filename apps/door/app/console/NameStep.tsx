'use client'
import { useState } from 'react'
import type { Environment } from '../../lib/deployments'
import type { Device } from '../../lib/device'
import { nameProblem, namingTxs, readName } from '../../lib/ens'
import type { Connected } from '../../lib/wallet'
import { WalletBox } from './WalletBox'

const say = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Step 2: the name the Wedgie will have (D6). It comes before the binding, which is made for this name only (D22),
 *  and in production the wallet that will create it is checked first: a binding for a name it can't create would
 *  be no use. */
export function NameStep(props: {
  label: string
  parent: string
  onChange: (label: string, parent: string) => void
  env: Environment
  device: Device
  wallet: Connected | null
  onWallet: (c: Connected) => void
  /** The name, and what the check found */
  onChosen: (name: string, found: string) => void
  locked: boolean
}) {
  const { label, parent, wallet } = props
  const [checking, setChecking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const name = `${label}.${parent}`
  const issue = label && parent ? nameProblem(label, parent) : null
  const testing = props.env === 'staging'

  async function choose() {
    setProblem(null)
    if (testing) return props.onChosen(name, 'a test binding, which ENS never sees')
    if (!wallet) return
    setChecking(true)
    try {
      const s = await readName(wallet.chain, wallet.account, label, parent)
      // Throws when the name is someone else's; what the transactions are doesn't depend on the records
      namingTxs(s, { wallet: wallet.account, key: props.device.key, nullifier: '0x', poh: '', sc: props.device.sc })
      props.onChosen(name, s.held === 'yours' ? 'yours already, so Knock adds its records' : `free under ${parent}, and your wallet can create it`)
    } catch (e) {
      setProblem(say(e))
    } finally {
      setChecking(false)
    }
  }

  return (
    <>
      <p>Sites know your Wedgie by its name. Pick a label under an ENS name your wallet owns.</p>
      <div className="name-row">
        <input
          value={label}
          onChange={(e) => props.onChange(e.target.value.trim().toLowerCase(), parent)}
          placeholder="wedgie"
          aria-label="Its label"
          spellCheck={false}
          autoComplete="off"
          disabled={props.locked || checking}
        />
        <span aria-hidden="true">.</span>
        <input
          value={parent}
          onChange={(e) => props.onChange(label, e.target.value.trim().toLowerCase())}
          placeholder="itzraj.eth"
          aria-label="An ENS name your wallet owns"
          spellCheck={false}
          autoComplete="off"
          disabled={props.locked || checking}
        />
      </div>
      {issue ? (
        <p className="callout bad">{issue}</p>
      ) : (
        <p className="hint">The binding is made for this name only, so a lost Wedgie is no use under another.</p>
      )}
      {testing ? null : <WalletBox connected={wallet} onConnect={props.onWallet} />}
      {problem ? <p className="callout bad">{problem}</p> : null}
      <div className="actions">
        <button
          type="button"
          className="btn go"
          onClick={choose}
          disabled={!label || !parent || Boolean(issue) || (!testing && !wallet) || checking || props.locked}
        >
          {checking ? `Checking ${name}…` : label && parent && !issue ? `Use ${name}` : 'Use this name'}
        </button>
      </div>
    </>
  )
}
