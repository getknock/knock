'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type Device, meet } from '../../lib/device'
import { Refusal, type Request, knockOn, okOrigin, readRequest } from '../../lib/door'
import { Wedgie } from '../../lib/wedgie'
import { Screen, type View } from '../console/Screen'

type Phase = 'alone' | 'framed' | 'waiting' | 'connect' | 'knocking' | 'done' | 'refused' | 'trouble'

const say = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** How long the Wedgie's KNOCK page waits for a press (knock_pass) */
const PRESS_MS = 120_000

/** The Door: the popup a site opens with door-sdk's knock(). It knocks once, for the site that opened it. */
export function Door() {
  const [phase, setPhase] = useState<Phase>('waiting')
  const [request, setRequest] = useState<Request | null>(null)
  const [device, setDevice] = useState<Device | null>(null)
  const [words, setWords] = useState<string | null>(null)
  const [asked, setAsked] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const wedgie = useRef<Wedgie | null>(null)
  const answered = useRef(false)
  const requested = useRef(false)

  // One answer, to the site's origin only (a refusal for an origin we can't name goes nowhere)
  const answer = useCallback((origin: string, m: Record<string, unknown>) => {
    if (answered.current || !window.opener || !okOrigin(origin)) return
    answered.current = true
    window.opener.postMessage({ type: 'knock/result', ...m }, origin)
  }, [])

  const knock = useCallback(
    async (req: Request, picked?: Wedgie) => {
      setWords(null)
      let w = picked ?? wedgie.current
      try {
        if (!w) w = await Wedgie.known()
      } catch {
        setPhase('trouble')
        setWords('Another tab has your Wedgie, such as the Knock Console. Disconnect it there, then try again.')
        return
      }
      if (!w) {
        setPhase('connect') // a Wedgie this page hasn't met: the browser asks, from a click
        return
      }
      wedgie.current = w
      setPhase('knocking')
      try {
        const d = await meet(w)
        setDevice(d)
        setAsked(Date.now())
        const assertion = await knockOn(w, d, req)
        answer(req.origin, { ok: true, assertion })
        setPhase('done')
        await w.close().catch(() => {})
        wedgie.current = null
        setTimeout(() => window.close(), 1500)
      } catch (e) {
        if (e instanceof Refusal) {
          answer(req.origin, { ok: false, error: e.code, why: e.message })
          setPhase('refused')
        } else {
          answer(req.origin, { ok: false, error: 'not_ready', why: say(e) })
          setPhase('refused')
        }
        setWords(say(e))
      } finally {
        setAsked(null)
      }
    },
    [answer],
  )

  useEffect(() => {
    if (window.top !== window.self) {
      setPhase('framed') // never inside another page: it could cover what the Door says
      return
    }
    if (!window.opener) {
      setPhase('alone')
      return
    }
    const onMessage = (e: MessageEvent) => {
      const r = readRequest(e, window.opener)
      if (!r || answered.current) return
      if (!r.ok) {
        answer(e.origin, { ok: false, error: r.refusal.code, why: r.refusal.message })
        setPhase('refused')
        setWords(r.refusal.message)
        return
      }
      if (requested.current) return // one request per Door
      requested.current = true
      setRequest(r.request)
      knock(r.request)
    }
    window.addEventListener('message', onMessage)
    window.opener.postMessage({ type: 'knock/ready' }, '*') // says nothing but that the Door is up
    const bye = () => void wedgie.current?.close()
    window.addEventListener('pagehide', bye)
    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('pagehide', bye)
    }
  }, [answer, knock])

  // The time left to press, while the Wedgie waits for one
  useEffect(() => {
    if (asked === null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [asked])
  const left = asked === null ? null : Math.max(0, Math.ceil((asked + PRESS_MS - now) / 1000))

  const pressing = phase === 'knocking' && Boolean(device?.name) && asked !== null
  const view: View =
    pressing && device?.name && request
      ? { kind: 'knock', name: device.name, origin: request.origin }
      : device
        ? { kind: 'home', name: device.name, human: device.status === 'active' && Boolean(device.nullifier) }
        : { kind: 'off' }

  return (
    <div className="door">
      <header className="door-bar">
        <img src="/icon.svg" alt="" width={22} height={22} />
        Knock
      </header>

      {phase === 'alone' || phase === 'framed' ? (
        <main className="door-main">
          <h1 className="door-title">The Door</h1>
          <p>
            {phase === 'framed'
              ? "The Door doesn't open inside another page, since that page could cover what it says."
              : "Sites open this window when you press their Knock button: it asks your Wedgie to knock for them. There's nothing to do here on its own."}
          </p>
          {phase === 'alone' ? (
            <p>
              <a href="https://getknock.dev">Set up your Wedgie</a>, or read{' '}
              <a href="https://docs.getknock.dev">the docs</a>.
            </p>
          ) : null}
        </main>
      ) : (
        <main className="door-main">
          <section className="asker" aria-live="polite">
            {request ? (
              <>
                <p className="origin">{request.origin}</p>
                <p>asks your Wedgie to knock, as a bound human</p>
                <p className="muted small">Your browser told the Door this address.</p>
              </>
            ) : (
              <p className="muted">Waiting for the site's request…</p>
            )}
          </section>

          <Screen view={view} waitingForGreen={pressing} />

          <section className="door-say" role="status">
            {phase === 'connect' ? <p>Connect your Wedgie to knock. Your browser asks which device to use.</p> : null}
            {phase === 'knocking' && !pressing ? <p>Checking your Wedgie…</p> : null}
            {pressing && device?.name ? (
              <>
                <p>
                  Press green to knock as <strong>{device.name}</strong>. Red says no.
                </p>
                {left !== null ? (
                  <p className="muted small">
                    {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} to press
                  </p>
                ) : null}
              </>
            ) : null}
            {phase === 'done' ? (
              <p className="knocked">
                Knocked as <strong>{device?.name}</strong>. {request?.origin} checks it now, and this window closes.
              </p>
            ) : null}
            {words && phase !== 'done' ? <p className="callout bad">{words}</p> : null}
          </section>

          <div className="actions">
            {phase === 'connect' && request ? (
              <button
                type="button"
                className="btn go"
                onClick={async () => {
                  try {
                    await knock(request, await Wedgie.pick())
                  } catch (e) {
                    if (!(e instanceof DOMException && e.name === 'NotFoundError')) setWords(say(e))
                  }
                }}
              >
                Connect your Wedgie
              </button>
            ) : null}
            {phase === 'trouble' && request ? (
              <button type="button" className="btn go" onClick={() => knock(request)}>
                Try again
              </button>
            ) : null}
            {phase !== 'done' ? (
              <button type="button" className="btn" onClick={() => window.close()}>
                {phase === 'refused' ? 'Close' : 'Cancel'}
              </button>
            ) : null}
          </div>
        </main>
      )}
    </div>
  )
}
