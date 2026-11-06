'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { bindWedgie, showQr } from '../../lib/bind'
import { remember } from '../../lib/bindings'
import { EXPLORER, type Environment } from '../../lib/deployments'
import { type Device, meet } from '../../lib/device'
import { type Bound, KNOCKD } from '../../lib/knockd'
import type { Connected } from '../../lib/wallet'
import { Wedgie } from '../../lib/wedgie'
import { KillSwitch } from './KillSwitch'
import { Naming } from './Naming'
import { Screen, type View, short } from './Screen'

type Phase = 'idle' | 'context' | 'qr' | 'device' | 'chain' | 'done' | 'stopped'
const STEPS = ['context', 'qr', 'device', 'chain'] as const

function say(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function Console() {
  const [supported, setSupported] = useState(true)
  const [wedgie, setWedgie] = useState<Wedgie | null>(null)
  const [device, setDevice] = useState<Device | null>(null)
  const [knockd, setKnockd] = useState<'checking' | 'ready' | 'down'>('checking')
  const [env, setEnv] = useState<Environment>('staging')
  const [phase, setPhase] = useState<Phase>('idle')
  const [reached, setReached] = useState(-1)
  const [link, setLink] = useState<string | null>(null)
  const [qr, setQr] = useState<{ n: number; bits: string } | null>(null)
  const [qrUp, setQrUp] = useState(true)
  const [nullifier, setNullifier] = useState<Hex | null>(null)
  const [bound, setBound] = useState<Bound | null>(null)
  const [justBound, setJustBound] = useState<Hex | null>(null)
  const [wallet, setWallet] = useState<Connected | null>(null)
  const [override, setOverride] = useState<View | null>(null)
  const [elsewhere, setElsewhere] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const abort = useRef<AbortController | null>(null)
  const current = useRef<Wedgie | null>(null)

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
    try {
      setDevice(await meet(w))
      setProblem(null)
    } catch (e) {
      setProblem(say(e))
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

  // While the QR is up, ask the Wedgie now and then whether it still is: red, or two minutes, takes it down.
  useEffect(() => {
    if (phase !== 'qr' || !wedgie) return
    const t = setInterval(async () => {
      try {
        setQrUp(Boolean((await wedgie.ask({ type: 'hello' })).knock_qr))
      } catch {}
    }, 4000)
    return () => clearInterval(t)
  }, [phase, wedgie])

  async function connect() {
    setProblem(null)
    try {
      await attach(await Wedgie.pick())
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotFoundError')) setProblem(say(e)) // closing the picker isn't one
    }
  }

  async function start() {
    if (!wedgie || !device) return
    const ac = new AbortController()
    abort.current = ac
    setProblem(null)
    setBound(null)
    setLink(null)
    setQr(null)
    setQrUp(true)
    setNullifier(null)
    try {
      const out = await bindWedgie(
        wedgie,
        env,
        device.key,
        (s) => {
          setPhase(s.step)
          setReached(STEPS.indexOf(s.step))
          if (s.step === 'qr') {
            setLink(s.link)
            setQr(s.qr)
          }
          if (s.step === 'device') {
            setQr(null)
            setNullifier(s.nullifier)
          }
        },
        ac.signal,
      )
      setBound(out)
      remember(device.key, out.environment, out.tx)
      if (out.environment === 'production') setJustBound(out.tx)
      setPhase('done')
    } catch (e) {
      setQr(null)
      wedgie.ask({ type: 'knock_cancel' }).catch(() => {})
      if (ac.signal.aborted) {
        setPhase('idle')
        setReached(-1)
      } else {
        setPhase('stopped')
        setProblem(say(e))
      }
    }
  }

  async function showAgain() {
    if (!wedgie || !qr) return
    try {
      await showQr(wedgie, qr)
      setQrUp(true)
    } catch (e) {
      setProblem(say(e))
    }
  }

  async function copy() {
    if (!link) return
    await navigator.clipboard.writeText(link)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const busy = phase === 'context' || phase === 'qr' || phase === 'device' || phase === 'chain'
  const human = device?.status === 'active' && Boolean(device?.nullifier)
  const view: View = override ?? (!wedgie
    ? { kind: 'off' }
    : phase === 'qr' && qr && qrUp
      ? { kind: 'qr', ...qr }
      : phase === 'device' && nullifier && device
        ? { kind: 'bind', key: device.key, nullifier }
        : { kind: 'home', name: device?.name ?? null, human })
  const stepClass = (i: number) =>
    phase === 'done' || i < reached ? 'done' : i === reached ? (phase === 'stopped' ? 'failed' : 'now') : ''

  return (
    <>
      <header className="bar">
        <img src="/icon.svg" alt="" />
        <h1>Knock Console</h1>
        <p className="status" role="status">
          <span className={`dot ${knockd}`} />
          {knockd === 'ready' ? 'knockd is ready' : knockd === 'down' ? "knockd isn't running" : 'Looking for knockd'}
        </p>
      </header>

      <main className="console">
        <section aria-label="Your Wedgie">
          <Screen view={view} waitingForGreen={phase === 'device' || override?.kind === 'become'} />
          {device ? (
            <dl className="facts">
              <dt>Name</dt>
              <dd>{device.name ?? 'not named yet'}</dd>
              <dt>Key</dt>
              <dd className="hex">{short(device.key)}</dd>
              <dt>Human</dt>
              <dd>{human && device.nullifier ? <span className="hex">bound, {short(device.nullifier)}</span> : 'not bound yet'}</dd>
              <dt>App</dt>
              <dd>
                {device.app}, firmware {device.firmware}
              </dd>
            </dl>
          ) : null}
          <div className="side-actions">
            {!supported ? null : wedgie ? (
              <button type="button" className="quiet" onClick={() => current.current?.close()} disabled={busy || elsewhere}>
                Disconnect
              </button>
            ) : (
              <button type="button" className="primary" onClick={connect}>
                Connect your Wedgie
              </button>
            )}
          </div>
        </section>

        <div>
          <section aria-labelledby="bind-title" className="part">
            <h2 id="bind-title">Bind this Wedgie to a human</h2>
            <p className="lede">
              A World ID proof says one human is here, and a green press on the Wedgie says it agrees. Both go to World
              Chain together, and from then on the Wedgie can knock as a human.
            </p>

            {!supported ? (
              <p className="problem">This page talks to the Wedgie over USB, which only Chrome and Edge can do. Open it in one of those.</p>
            ) : null}
            {knockd === 'down' ? (
              <p className="problem">
                knockd isn't answering at <code>{KNOCKD}</code>. Start it from the repo with <code>cargo run -p knockd</code>.
              </p>
            ) : null}
            {problem ? <p className="problem">{problem}</p> : null}

            <fieldset className="where" disabled={busy || elsewhere}>
              <legend>Who proves it</legend>
              <label>
                <input type="radio" name="env" checked={env === 'staging'} onChange={() => setEnv('staging')} />
                World ID Simulator
                <small>A test identity in your browser. Binds on the staging contract.</small>
              </label>
              <label>
                <input type="radio" name="env" checked={env === 'production'} onChange={() => setEnv('production')} />
                World App
                <small>Your own World ID, on your phone. One binding per human.</small>
              </label>
            </fieldset>

            <ol className="steps">
              <li className={stepClass(0)}>
                <div>
                  <strong>knockd signs a World ID request</strong>
                  <p>Only Knock's own server can ask World ID for a knock-bind proof.</p>
                </div>
              </li>
              <li className={stepClass(1)}>
                <div>
                  <strong>Scan the QR on your Wedgie</strong>
                  {env === 'staging' ? (
                    <p>
                      In the{' '}
                      <a href="https://simulator.worldcoin.org" target="_blank" rel="noreferrer">
                        World ID Simulator
                      </a>
                      , scan the Wedgie's QR or paste the link below.
                    </p>
                  ) : (
                    <p>Open World App on your phone and scan the QR on the Wedgie's screen.</p>
                  )}
                  {phase === 'qr' && link ? (
                    <div className="link">
                      <code>{link}</code>
                      <button type="button" className="quiet" onClick={copy}>
                        {copied ? 'Copied' : 'Copy link'}
                      </button>
                      {!qrUp ? (
                        <button type="button" className="quiet" onClick={showAgain}>
                          Show the QR again
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
              <li className={stepClass(2)}>
                <div>
                  <strong>Press green on the Wedgie's BIND page</strong>
                  <p>It names what it binds: its own key, to the human the proof is for. Red says no.</p>
                </div>
              </li>
              <li className={stepClass(3)}>
                <div>
                  <strong>knockd sends it to World Chain</strong>
                  <p>It checks both yeses first, so a binding that would fail costs nothing.</p>
                </div>
              </li>
            </ol>

            <div className="actions">
              <button
                type="button"
                className="primary"
                onClick={start}
                disabled={!device || knockd !== 'ready' || busy || elsewhere}
              >
                Bind this Wedgie
              </button>
              {phase === 'context' || phase === 'qr' ? (
                <button type="button" className="quiet" onClick={() => abort.current?.abort()}>
                  Cancel
                </button>
              ) : null}
              {phase === 'device' ? <p>Waiting for a press on the Wedgie. Red stops it.</p> : null}
            </div>

            {bound ? (
              <div className="bound" role="status">
                <h3>Bound on World Chain</h3>
                <p>
                  <a href={`${EXPLORER}/tx/${bound.tx}`} target="_blank" rel="noreferrer">
                    Transaction <span className="hex">{short(bound.tx)}</span>
                  </a>
                  , block {bound.block}, {bound.gasUsed.toLocaleString()} gas.
                </p>
                <p>
                  Nullifier <span className="hex">{short(bound.bound.nullifier)}</span>, key hash{' '}
                  <span className="hex">{short(bound.bound.keyHash)}</span>.
                </p>
                {bound.environment === 'production' ? (
                  <p>Next, name it in ENS, below: the name's records point at this binding.</p>
                ) : (
                  <p>
                    This was the Simulator's test identity, so the Wedgie's own screen stays as it was. Only a World App
                    binding can be named in ENS.
                  </p>
                )}
              </div>
            ) : null}
          </section>

          <Naming
            wedgie={wedgie}
            device={device}
            wallet={wallet}
            onWallet={setWallet}
            onDevice={setDevice}
            onView={setOverride}
            onBusy={setElsewhere}
            justBound={justBound}
            locked={busy}
          />
          <KillSwitch
            wedgie={wedgie}
            device={device}
            wallet={wallet}
            onWallet={setWallet}
            onDevice={setDevice}
            onBusy={setElsewhere}
            busy={busy || elsewhere}
          />
        </div>
      </main>
    </>
  )
}
