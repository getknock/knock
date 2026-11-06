'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type Device, meet } from '../../lib/device'
import { Refusal, type Request, knockOn, okOrigin, readRequest } from '../../lib/door'
import { Wedgie } from '../../lib/wedgie'
import { Screen, type View } from '../console/Screen'

type Phase = 'alone' | 'framed' | 'waiting' | 'connect' | 'knocking' | 'done' | 'refused' | 'trouble'

const say = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** The Door: the popup a site opens with door-sdk's knock(). It knocks once, for the site that opened it. */
export function Door() {
  const [phase, setPhase] = useState<Phase>('waiting')
  const [request, setRequest] = useState<Request | null>(null)
  const [device, setDevice] = useState<Device | null>(null)
  const [words, setWords] = useState<string | null>(null)
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
        setWords('Another tab has the Wedgie, like the Knock Console: disconnect it there, then try again.')
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

  const view: View =
    phase === 'knocking' && device?.name && request
      ? { kind: 'knock', name: device.name, origin: request.origin }
      : device
        ? { kind: 'home', name: device.name, human: device.status === 'active' && Boolean(device.nullifier) }
        : { kind: 'off' }

  return (
    <main className="door">
      <header className="door-bar">
        <img src="/icon.svg" alt="" />
        <span>Knock</span>
      </header>

      {phase === 'alone' || phase === 'framed' ? (
        <p className="lede">
          {phase === 'framed'
            ? "The Door doesn't open inside another page."
            : "This is the Door a site opens when it asks for a knock. Open it from a site's Knock button."}
        </p>
      ) : (
        <>
          <section className="asker" aria-live="polite">
            {request ? (
              <>
                <p className="origin">{request.origin}</p>
                <p>asks your Wedgie to knock, as a bound human</p>
              </>
            ) : (
              <p>Waiting for the site's request…</p>
            )}
          </section>

          <Screen view={view} waitingForGreen={phase === 'knocking' && Boolean(device)} />

          <section className="door-say" role="status">
            {phase === 'knocking' && device?.name ? (
              <p>
                Press green on the Wedgie to knock as <strong>{device.name}</strong>. Red says no.
              </p>
            ) : null}
            {phase === 'knocking' && !device ? <p>Meeting your Wedgie…</p> : null}
            {phase === 'done' ? (
              <p>
                Knocked as <strong>{device?.name}</strong>. {request?.origin} checks it now.
              </p>
            ) : null}
            {words ? <p className={phase === 'done' ? '' : 'problem'}>{words}</p> : null}
          </section>

          <div className="actions">
            {phase === 'connect' && request ? (
              <button
                type="button"
                className="primary"
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
              <button type="button" className="primary" onClick={() => knock(request)}>
                Try again
              </button>
            ) : null}
            {phase !== 'done' ? (
              <button type="button" className="quiet" onClick={() => window.close()}>
                {phase === 'refused' ? 'Close' : 'Cancel'}
              </button>
            ) : null}
          </div>
        </>
      )}
    </main>
  )
}
