'use client'
import { useEffect, useRef, useState } from 'react'
import { deviceNode } from '@knock-dev/protocol'
import type { Hex } from 'viem'
import { bindWedgie, showQr } from '../../lib/bind'
import { ACTION, type Environment } from '../../lib/deployments'
import { type Device, same } from '../../lib/device'
import { forgetHuman, recallHuman, rememberHuman } from '../../lib/humans'
import { type Human, KNOCKD, type SessionId, type Sent, human as findHuman } from '../../lib/knockd'
import type { Wedgie } from '../../lib/wedgie'
import type { Known } from '../../lib/setup'
import { type View, short } from './Screen'
import { TxLink } from './TxLink'

type Phase = 'idle' | 'context' | 'qr' | 'device' | 'chain' | 'stopped'
/** Who's binding, and how the Console knows (D24). */
type Who = { human: Human; whence: string }
const STEPS = ['context', 'qr', 'device', 'chain'] as const

const say = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Step 3: the binding (D22, D24), for the name chosen above. It's offered only when World Chain has no binding of
 * this Wedgie's: one it has for another name is said first, and binding again takes a second, deliberate yes.
 */
export function BindStep(props: {
  wedgie: Wedgie
  device: Device
  env: Environment
  name: string
  known: Known
  /** The name World Chain's binding is for, when the Console knows it */
  boundFor: string | null
  /** The kill switch took this Wedgie's last binding away, here */
  killed: boolean
  knockd: 'checking' | 'ready' | 'down'
  onBound: (out: Sent) => void
  /** Name it what its binding is for instead */
  onUseName: (name: string) => void
  onLookAgain: () => void
  onView: (v: View | null) => void
  onBusy: (busy: boolean) => void
}) {
  const { wedgie, device, env, name, known, knockd } = props
  const [phase, setPhase] = useState<Phase>('idle')
  const [reached, setReached] = useState(-1)
  const [link, setLink] = useState<string | null>(null)
  const [qr, setQr] = useState<{ n: number; bits: string } | null>(null)
  const [qrUp, setQrUp] = useState(true)
  const [nullifier, setNullifier] = useState<Hex | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  /** Bind again, though World Chain has a binding of this Wedgie's for another name: the person said so */
  const [again, setAgain] = useState(false)
  const [found, setFound] = useState<Who | null>(null)
  const [foundByName, setFoundByName] = useState<Who | null>(null)
  const [picked, setPicked] = useState<Who | null>(null)
  const [asNew, setAsNew] = useState(false)
  const [findBy, setFindBy] = useState('')
  const [finding, setFinding] = useState(false)
  const abort = useRef<AbortController | null>(null)

  const busy = phase === 'context' || phase === 'qr' || phase === 'device' || phase === 'chain'
  const who = asNew ? null : (picked ?? found ?? foundByName)
  const me = who?.human ?? null
  const { onView, onBusy } = props

  useEffect(() => onBusy(busy), [busy, onBusy])
  useEffect(
    () =>
      onView(
        phase === 'qr' && qr && qrUp
          ? { kind: 'qr', ...qr }
          : phase === 'device' && nullifier
            ? { kind: 'bind', key: device.key, nullifier }
            : null,
      ),
    [phase, qr, qrUp, nullifier, device.key, onView],
  )
  useEffect(
    () => () => {
      onView(null)
      onBusy(false)
    },
    [onView, onBusy],
  )

  // Another environment, another human
  useEffect(() => {
    setPicked(null)
    setAsNew(false)
  }, [env])

  // Who's binding (D24), from KnockBinding, so any browser knows: the human this Wedgie was last bound to (its name
  // killed or not), else the one this browser bound. A failed read leaves what was known.
  const key = device.key
  useEffect(() => {
    if (knockd !== 'ready') return
    let gone = false
    ;(async () => {
      try {
        const byKey = await findHuman(env, { key })
        if (gone) return
        if (byKey) return setFound({ human: byKey, whence: "this Wedgie's last human" })
        const here = recallHuman(env)
        const h = here ? await findHuman(env, { session: here.session }) : null
        if (gone) return
        if (h && here && same(h.nullifier, here.nullifier)) return setFound({ human: h, whence: 'who bound here before' })
        if (here) forgetHuman(env) // another deployment's
        setFound(null)
      } catch {}
    })()
    return () => {
      gone = true
    }
  }, [env, knockd, key])

  // Else the human the name was last bound for: a new Wedgie under a name its human had before
  useEffect(() => {
    setFoundByName(null)
    if (knockd !== 'ready' || found) return
    let gone = false
    findHuman(env, { node: deviceNode(name) })
      .then((h) => !gone && setFoundByName(h ? { human: h, whence: `${name}'s last human` } : null))
      .catch(() => {})
    return () => {
      gone = true
    }
  }, [env, knockd, found, name])

  // While the QR is up, ask the Wedgie now and then whether it still is: red, or two minutes, takes it down.
  useEffect(() => {
    if (phase !== 'qr') return
    const t = setInterval(async () => {
      try {
        setQrUp(Boolean((await wedgie.ask({ type: 'hello' })).knock_qr))
      } catch {}
    }, 4000)
    return () => clearInterval(t)
  }, [phase, wedgie])

  /** A returning human, found on chain by a name they bound (killed or not), their nullifier, or a session. */
  async function findMe() {
    const q = findBy.trim().toLowerCase()
    setProblem(null)
    setFinding(true)
    try {
      let by: { nullifier: Hex } | { session: SessionId } | { node: Hex }
      if (/^session_[0-9a-f]{128}$/.test(q)) by = { session: q as SessionId }
      else if (/^0x[0-9a-f]{64}$/.test(q)) by = { nullifier: q as Hex }
      else {
        try {
          by = { node: deviceNode(q) }
        } catch {
          throw new Error(`${q} isn't a name, a nullifier (0x and 64 hex digits) or a session id.`)
        }
      }
      const h = await findHuman(env, by)
      if (!h) throw new Error(`Knock has no human for ${q}: nothing was bound by it here.`)
      rememberHuman(env, h)
      setPicked({ human: h, whence: `found by ${q.length > 24 ? short(q) : q}` })
      setAsNew(false)
      setFindBy('')
    } catch (e) {
      setProblem(say(e))
    } finally {
      setFinding(false)
    }
  }

  function bindAsNew() {
    forgetHuman(env)
    setPicked(null)
    setAsNew(true)
  }

  async function start() {
    const ac = new AbortController()
    abort.current = ac
    setProblem(null)
    setLink(null)
    setQr(null)
    setQrUp(true)
    setNullifier(null)
    try {
      const out = await bindWedgie(
        wedgie,
        env,
        device.key,
        name,
        me,
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
      rememberHuman(out.environment, { nullifier: out.bound.nullifier, session: out.session })
      setPhase('idle')
      props.onBound(out)
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
    if (!qr) return
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

  const testing = env === 'staging'
  // In this step, a binding World Chain has is always for another name: one for this name makes it done
  const elsewhere = known.state === 'bound' ? known : null
  const mayBind = knockd === 'ready' && (known.state === 'none' || (elsewhere !== null && again))
  const at = (i: number) =>
    i < reached ? 'done' : i === reached ? (phase === 'stopped' ? 'failed' : 'now') : phase === 'idle' ? '' : 'later'

  return (
    <>
      <p>
        {testing
          ? "The World ID Simulator vouches for a test identity, and your Wedgie agrees with a green press. Knock records it on its staging contract."
          : "World App proves you're a human, and your Wedgie agrees with a green press. Knock records the binding on World Chain, and pays for it."}
      </p>

      {knockd === 'down' ? (
        <p className="callout bad">
          Knock's signer, knockd, isn't answering at <code>{KNOCKD}</code>. Start it from the repo with{' '}
          <code>cargo run -p knockd</code>.
        </p>
      ) : null}
      {knockd === 'ready' && known.state === 'checking' ? (
        <p className="note">Looking on World Chain for a binding this Wedgie already has…</p>
      ) : null}
      {knockd === 'ready' && known.state === 'unknown' ? (
        <div className="callout bad">
          <p>Couldn't look for a binding this Wedgie already has: {known.why}</p>
          <div className="actions">
            <button type="button" className="btn small" onClick={props.onLookAgain}>
              Look again
            </button>
          </div>
        </div>
      ) : null}

      {props.killed ? (
        <p className="note">Its last binding went with its name, through the kill switch, so naming it again takes a new one.</p>
      ) : null}

      {elsewhere ? (
        <div className="callout warn">
          <p className="callout-title">This Wedgie is bound already</p>
          <p>
            Its binding is for {props.boundFor ?? `another name than ${name}`}, in <TxLink tx={elsewhere.on.tx} />, and a
            binding counts for its own name only.
            {again
              ? ` Binding again makes a new one, for ${name}. The old one stays on World Chain, with no name pointing at it.`
              : null}
          </p>
          {again ? null : (
            <div className="actions">
              {props.boundFor ? (
                <button type="button" className="btn" onClick={() => props.onUseName(props.boundFor as string)}>
                  Use {props.boundFor}
                </button>
              ) : null}
              <button type="button" className="btn quiet" onClick={() => setAgain(true)}>
                Bind again for {name}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {mayBind ? (
        <>
          <div className="who" aria-live="polite">
            {me ? (
              <p>
                You bind as human <code>{short(me.nullifier)}</code>, {who?.whence}.{' '}
                <button type="button" className="text-btn" onClick={bindAsNew} disabled={busy}>
                  Not you?
                </button>
              </p>
            ) : (
              <>
                <p>
                  {testing
                    ? 'A first binding here: the Simulator proves a test identity once, and starts its Knock session.'
                    : 'Your first binding: World App proves you for Knock once, and that proof starts your Knock session. Every Wedgie after it binds by that session.'}
                </p>
                <details className="find">
                  <summary>Bound a Wedgie before?</summary>
                  <p>Find yourself by a name you bound, killed ones too, or by your nullifier.</p>
                  <div className="find-row">
                    <input
                      value={findBy}
                      onChange={(e) => setFindBy(e.target.value)}
                      placeholder="wedgie.itzraj.eth or 0x…"
                      spellCheck={false}
                      aria-label="A name you bound, or your nullifier"
                      disabled={busy || finding}
                    />
                    <button
                      type="button"
                      className="btn small"
                      onClick={findMe}
                      disabled={!findBy.trim() || busy || finding}
                    >
                      {finding ? 'Finding…' : 'Find me'}
                    </button>
                  </div>
                </details>
              </>
            )}
          </div>

          <ol className="progress">
            <li className={at(0)}>
              {me
                ? 'Knock asks World ID for a proof of your session'
                : `Knock asks World ID for a proof for ${ACTION[env]}, which World App gives once per human`}
            </li>
            <li className={at(1)}>
              {testing ? (
                <>
                  Scan the QR on your Wedgie in the{' '}
                  <a href="https://simulator.worldcoin.org" target="_blank" rel="noreferrer">
                    World ID Simulator
                  </a>
                  , or paste its link there
                </>
              ) : (
                'Scan the QR on your Wedgie with World App'
              )}
              {phase === 'qr' && link ? (
                <span className="link-row">
                  <code>{link}</code>
                  <button type="button" className="btn small" onClick={copy}>
                    {copied ? 'Copied' : 'Copy link'}
                  </button>
                  {!qrUp ? (
                    <button type="button" className="btn small" onClick={showAgain}>
                      Show the QR again
                    </button>
                  ) : null}
                </span>
              ) : null}
            </li>
            <li className={at(2)}>Press green on your Wedgie's BIND page. Red says no.</li>
            <li className={at(3)}>Knock checks both yeses, then records the binding on World Chain</li>
          </ol>

          {problem ? <p className="callout bad">{problem}</p> : null}

          <div className="actions">
            <button type="button" className="btn go" onClick={start} disabled={busy}>
              {testing ? 'Bind with the Simulator' : 'Bind with World App'}
            </button>
            {phase === 'context' || phase === 'qr' ? (
              <button type="button" className="btn" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            ) : null}
            {phase === 'device' ? <p className="note">Waiting for a press on your Wedgie.</p> : null}
            {phase === 'chain' ? <p className="note">Recording it on World Chain…</p> : null}
          </div>
        </>
      ) : problem ? (
        <p className="callout bad">{problem}</p>
      ) : null}
    </>
  )
}
