'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { forget, killedTx, recall, remember } from '../../lib/bindings'
import type { Environment } from '../../lib/deployments'
import { type Device, forgetOn, meet } from '../../lib/device'
import { knockState, nameProblem } from '../../lib/ens'
import { KNOCKD, type Sent as Bound, latestBinding } from '../../lib/knockd'
import type { Sent } from '../../lib/name'
import { type Known, setup } from '../../lib/setup'
import { useSite } from '../../lib/sites'
import { type Connected, PUBLIC } from '../../lib/wallet'
import { Wedgie } from '../../lib/wedgie'
import { Bar } from './Bar'
import { BindStep } from './BindStep'
import { KillSwitch } from './KillSwitch'
import { NameStep } from './NameStep'
import { Naming, SentList } from './Naming'
import { Screen, type View, short } from './Screen'
import { Step } from './Step'
import { TxLink } from './TxLink'

const say = (e: unknown) => (e instanceof Error ? e.message : String(e))

function split(name: string): [string, string] {
  const at = name.indexOf('.')
  return [name.slice(0, at), name.slice(at + 1)]
}

/** The Knock Console, at getknock.dev: a Wedgie set up in four steps, each in the order its records need (D21). */
export function Console() {
  const [supported, setSupported] = useState(true)
  const [wedgie, setWedgie] = useState<Wedgie | null>(null)
  const [device, setDevice] = useState<Device | null>(null)
  const [meeting, setMeeting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [knockd, setKnockd] = useState<'checking' | 'ready' | 'down'>('checking')
  const [env, setEnv] = useState<Environment>('production')
  const [label, setLabel] = useState('')
  const [parent, setParent] = useState('')
  const [chosen, setChosen] = useState<{ name: string; found: string } | null>(null)
  const [wallet, setWallet] = useState<Connected | null>(null)
  const [known, setKnown] = useState<Known>({ state: 'checking' })
  const [lookAgain, setLookAgain] = useState(0)
  const [named, setNamed] = useState<Sent[]>([])
  const [view, setView] = useState<View | null>(null)
  const [binding, setBinding] = useState(false)
  const [naming, setNaming] = useState(false)
  const [killing, setKilling] = useState(false)
  const [inEns, setInEns] = useState<'live' | 'revoked' | 'gone' | null>(null)
  const [forgetting, setForgetting] = useState(false)
  const [forgetProblem, setForgetProblem] = useState<string | null>(null)
  const current = useRef<Wedgie | null>(null)
  const lastKey = useRef<Hex | null>(null)
  const club = useSite('club')

  const ping = useCallback(async () => {
    try {
      setKnockd((await fetch(`${KNOCKD}/health`)).ok ? 'ready' : 'down')
    } catch {
      setKnockd('down')
    }
  }, [])

  useEffect(() => {
    ping()
    const t = setInterval(ping, 15_000)
    return () => clearInterval(t)
  }, [ping])

  const attach = useCallback(async (w: Wedgie) => {
    current.current = w
    w.onclose = () => {
      if (current.current !== w) return
      current.current = null
      setWedgie(null)
      setDevice(null)
    }
    setWedgie(w)
    setMeeting(true)
    try {
      setDevice(await meet(w))
      setProblem(null)
    } catch (e) {
      setProblem(say(e))
    } finally {
      setMeeting(false)
    }
  }, [])

  useEffect(() => {
    if (!Wedgie.supported()) {
      setSupported(false)
      return
    }
    // A Wedgie this page was let into before comes back on its own; if another tab holds it, connect by hand.
    Wedgie.known()
      .then((w) => w && attach(w))
      .catch(() => {})
    const bye = () => void current.current?.close()
    window.addEventListener('pagehide', bye)
    return () => {
      window.removeEventListener('pagehide', bye)
      bye()
    }
  }, [attach])

  async function connect() {
    setProblem(null)
    try {
      await attach(await Wedgie.pick())
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) setProblem(say(e)) // closing the picker isn't one
    }
  }

  const key = device?.key ?? null
  const pohTx = device?.poh?.match(/^eip155:480:tx:(0x[0-9a-f]{64})$/i)?.[1] ?? null
  const name = `${label}.${parent}`
  const nameOk = Boolean(label && parent && !nameProblem(label, parent))

  // Another Wedgie, another name to choose
  useEffect(() => {
    if (key && lastKey.current && key !== lastKey.current) setChosen(null)
    if (key) lastKey.current = key
  }, [key])

  // Its name: the one it has, else the one this browser bound it for, until the person types one
  useEffect(() => {
    if (!device || label || parent) return
    const from = device.name ?? recall(device.key, 'production')?.name
    if (from && from.indexOf('.') > 0) {
      const [l, p] = split(from)
      setLabel(l)
      setParent(p)
    }
  }, [device, label, parent])

  const { set, stale, live, boundFor, killed, steps } = setup({
    device,
    name,
    nameOk,
    chosen: chosen?.name ?? null,
    known,
    remembered: key ? recall(key, env)?.name ?? null : null,
    killedTx: key ? killedTx(key, env) : null,
    inEns,
  })

  // What ENS has on the name a set-up Wedgie shows: it can't tell when its name was killed while it was away
  useEffect(() => {
    setInEns(null)
    if (!set || !device?.name) return
    let gone = false
    knockState(PUBLIC, device.name, device.key)
      .then((s) => !gone && setInEns(s))
      .catch(() => {}) // unread, it's taken at its word
    return () => {
      gone = true
    }
  }, [set, device?.name, device?.key])

  // A Wedgie that's set up keeps its name: another one is the kill switch's business. Once killed, it's chosen again.
  const wasSet = useRef(false)
  useEffect(() => {
    if (set && device?.name) {
      const [l, p] = split(device.name)
      setLabel(l)
      setParent(p)
      setChosen({ name: device.name, found: 'live in ENS' })
    } else if (wasSet.current) setChosen(null)
    wasSet.current = set
  }, [set, device?.name])

  // What World Chain has for this Wedgie: its latest binding, from knockd's index, in any browser
  useEffect(() => {
    if (!key) return setKnown({ state: 'checking' })
    if (knockd !== 'ready')
      return setKnown(knockd === 'down' ? { state: 'unknown', why: "knockd isn't answering" } : { state: 'checking' })
    let gone = false
    setKnown({ state: 'checking' })
    latestBinding(env, key)
      .then((on) => !gone && setKnown(on ? { state: 'bound', on, name: null } : { state: 'none' }))
      .catch((e) => !gone && setKnown({ state: 'unknown', why: say(e) }))
    return () => {
      gone = true
    }
  }, [env, key, knockd, lookAgain])

  function onBound(out: Bound) {
    if (!device) return
    remember(device.key, out.environment, { tx: out.tx, name })
    setKnown({ state: 'bound', on: out, name })
  }

  function onNamed(d: Device, sent: Sent[]) {
    setDevice(d)
    setNamed(sent)
  }

  // A stale Wedgie forgets the name ENS no longer has for it, and its binding with it, as the kill switch does (D20)
  async function forgetStale() {
    if (!wedgie || !device) return
    setForgetting(true)
    setForgetProblem(null)
    try {
      await forgetOn(wedgie, device.name)
      forget(device.key, 'production', (pohTx as Hex | null) ?? null)
      setDevice(await meet(wedgie))
    } catch (e) {
      setForgetProblem(say(e))
    } finally {
      setForgetting(false)
    }
  }

  function takeName(n: string) {
    const [l, p] = split(n)
    setLabel(l)
    setParent(p)
    setChosen(null)
  }

  const busy = binding || naming || killing || forgetting
  const boundTx = live.state === 'bound' && boundFor === name ? live.on.tx : null
  const human = set ? device?.nullifier : live.state === 'bound' ? live.on.bound.nullifier : null
  const screen: View =
    view ?? (!wedgie ? { kind: 'off' } : { kind: 'home', name: device?.name ?? null, human: set })

  return (
    <>
      <Bar />
      <main className="console">
        <header className="page-head">
          <h1>Set up your Wedgie</h1>
          <p className="lede">
            Connect it, choose its name, bind it to you with World ID, then put the name in ENS. After that, a Knock
            site lets you in with one press.
          </p>
          <p className="lost">
            Lost your Wedgie, or had it stolen? <a href="#kill">Kill its name</a> with your wallet. The Wedgie needn't
            be here.
          </p>
        </header>

        <div className="layout">
          <aside className="device-panel" aria-label="Your Wedgie">
            <Screen view={screen} waitingForGreen={screen.kind === 'bind' || screen.kind === 'become'} />
            {device ? (
              <dl className="facts">
                <dt>Name</dt>
                <dd>{device.name ?? 'none yet'}</dd>
                <dt>Human</dt>
                <dd>{human ? <code>{short(human)}</code> : 'not bound yet'}</dd>
                <dt>Key</dt>
                <dd>
                  <code>{short(device.key)}</code>
                </dd>
                <dt>App</dt>
                <dd>
                  {device.app} {device.firmware}
                </dd>
              </dl>
            ) : null}
            {wedgie ? (
              <button type="button" className="btn small" onClick={() => current.current?.close()} disabled={busy}>
                Disconnect
              </button>
            ) : null}
          </aside>

          <div className="flow">
            {set && !stale && device?.name ? (
              <div className="ready" role="status">
                <p className="ready-title">{device.name} is ready</p>
                <p>A Knock site lets it in with one green press, on any computer with Chrome or Edge.</p>
                <a className="btn go" href={club}>
                  Knock at the Human Club
                </a>
              </div>
            ) : null}

            <ol className="steps">
              <Step
                id="connect"
                n={1}
                state={steps[0]}
                title="Connect your Wedgie"
                done={
                  device ? (
                    <>
                      {device.app} {device.firmware}, its key <code>{short(device.key)}</code>.
                    </>
                  ) : null
                }
              >
                {!supported ? (
                  <p className="callout bad">
                    Your Wedgie connects over USB, which only Chrome, Edge and other Chromium browsers on a computer can
                    do. Open this page in one of those.
                  </p>
                ) : (
                  <>
                    <p>
                      Plug it into this computer with a cable that carries data, then connect it. Your browser asks
                      which device to use.
                    </p>
                    {problem ? <p className="callout bad">{problem}</p> : null}
                    <div className="actions">
                      <button type="button" className="btn go" onClick={connect} disabled={meeting}>
                        {meeting ? 'Checking your Wedgie…' : 'Connect your Wedgie'}
                      </button>
                    </div>
                  </>
                )}
              </Step>

              <Step
                id="name"
                n={2}
                state={steps[1]}
                title="Choose its name"
                done={
                  set && device?.name ? (
                    <>
                      <strong>{device.name}</strong>
                      {stale ? ', which ENS no longer has for it.' : '.'}
                    </>
                  ) : chosen ? (
                    <>
                      <strong>{chosen.name}</strong>: {chosen.found}.{' '}
                      {!set ? (
                        <button type="button" className="text-btn" onClick={() => setChosen(null)} disabled={busy}>
                          Change
                        </button>
                      ) : null}
                    </>
                  ) : null
                }
              >
                {device ? (
                  <NameStep
                    label={label}
                    parent={parent}
                    onChange={(l, p) => {
                      setLabel(l)
                      setParent(p)
                    }}
                    env={env}
                    device={device}
                    wallet={wallet}
                    onWallet={setWallet}
                    onChosen={(n, found) => setChosen({ name: n, found })}
                    locked={busy}
                  />
                ) : null}
              </Step>

              <Step
                id="bind"
                n={3}
                state={steps[2]}
                title="Bind it to you"
                done={
                  <>
                    Bound for {set ? device?.name : name}
                    {human ? (
                      <>
                        , to human <code>{short(human)}</code>
                      </>
                    ) : null}
                    {boundTx || pohTx ? (
                      <>
                        , in <TxLink tx={(boundTx ?? pohTx) as string} />
                      </>
                    ) : null}
                    .
                  </>
                }
              >
                {wedgie && device ? (
                  <BindStep
                    wedgie={wedgie}
                    device={device}
                    env={env}
                    name={name}
                    known={live}
                    boundFor={boundFor}
                    killed={killed}
                    knockd={knockd}
                    onBound={onBound}
                    onUseName={takeName}
                    onLookAgain={() => setLookAgain((n) => n + 1)}
                    onView={setView}
                    onBusy={setBinding}
                  />
                ) : null}
              </Step>

              <Step
                id="ens"
                n={4}
                state={steps[3]}
                title="Name it in ENS"
                done={
                  device?.name ? (
                    <>
                      {device.name} resolves in ENS, with Knock's records.{' '}
                      <a href={`https://app.ens.domains/${device.name}`} target="_blank" rel="noreferrer">
                        See it in the ENS app
                      </a>
                      .
                      <SentList sent={named} />
                    </>
                  ) : null
                }
              >
                {stale && device?.name ? (
                  <>
                    <div className="callout warn">
                      <p className="callout-title">
                        {stale === 'gone' ? `ENS no longer has ${device.name} for it` : `${device.name} is revoked`}
                      </p>
                      <p>
                        {stale === 'gone' ? (
                          'Its name was killed while it was away, or went to another Wedgie, so no site takes its knocks. The Wedgie still shows the name until it forgets it.'
                        ) : (
                          <>
                            Its <code>knock.status</code> in ENS isn't <code>active</code>, so no site takes its knocks.
                            To set it up again, kill the name with the kill switch, below: the Wedgie forgets it too.
                          </>
                        )}
                      </p>
                    </div>
                    {forgetProblem ? <p className="callout bad">{forgetProblem}</p> : null}
                    <div className="actions">
                      {stale === 'gone' ? (
                        <button type="button" className="btn go" onClick={forgetStale} disabled={busy}>
                          {forgetting ? 'Forgetting…' : `Have it forget ${device.name}`}
                        </button>
                      ) : (
                        <a className="btn go" href="#kill">
                          Go to the kill switch
                        </a>
                      )}
                    </div>
                    {stale === 'gone' ? (
                      <p className="note">It forgets its binding with the name, so setting it up again takes a new one.</p>
                    ) : null}
                  </>
                ) : env === 'staging' ? (
                  <p className="callout">
                    The Simulator's bindings are tests, and ENS names point only at World App ones. Turn testing off,
                    below, and bind with World App to name your Wedgie.
                  </p>
                ) : wedgie && device && boundTx ? (
                  <Naming
                    wedgie={wedgie}
                    device={device}
                    label={label}
                    parent={parent}
                    binding={boundTx}
                    wallet={wallet}
                    onWallet={setWallet}
                    onNamed={onNamed}
                    onView={setView}
                    onBusy={setNaming}
                  />
                ) : null}
              </Step>
            </ol>

            <details className="testing" open={env === 'staging' || undefined}>
              <summary>Testing without World App</summary>
              <label className="check">
                <input
                  type="checkbox"
                  checked={env === 'staging'}
                  onChange={(e) => setEnv(e.target.checked ? 'staging' : 'production')}
                  disabled={busy}
                />
                Bind with the World ID Simulator
              </label>
              <p className="muted">
                Its test identities bind on Knock's staging contract. Verifiers never take those bindings, and ENS
                names can't point at them.
              </p>
            </details>

            <KillSwitch
              wedgie={wedgie}
              device={device}
              wallet={wallet}
              onWallet={setWallet}
              onDevice={setDevice}
              onBusy={setKilling}
              busy={busy}
            />
          </div>
        </div>
      </main>
    </>
  )
}
