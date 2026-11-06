/**
 * @knock-dev/door-sdk: a site asks a Knock Door for a knock. knock() opens the Door's popup, hands it the site's
 * challenge, and resolves with what the Wedgie signed, for the site's verifier. The Door takes the site's origin
 * from the browser (the message's own origin), never from the site, and answers that origin only (PLAN §3).
 */
export type Hex = `0x${string}`

/** A knock: the KnockPass the Wedgie signed after a green press, and the name it knocks as. Nothing in it is to be
 *  trusted until the site's verifier has checked it against ENS and World Chain (V1–V8). */
export type Assertion = {
  v: 1
  name: string
  challenge: Hex
  origin: string
  deviceNode: Hex
  counter: number
  mode: 1
  nullifier: Hex
  humanRef: Hex
  r: Hex
  s: Hex
}

/** Why a knock didn't happen: closed (the popup was closed), blocked (no popup), timeout, challenge (the site's
 *  own challenge failed), or the Door's word for it (rejected: red on the Wedgie; not_enrolled; busy; …). */
export class KnockError extends Error {
  constructor(
    readonly code: string,
    why: string,
  ) {
    super(why)
  }
}

/** The Door the SDK opens unless told otherwise: Knock's own (D29). */
export const DOOR = 'https://door.getknock.dev'

export type KnockOptions = {
  /** The site's challenge from its verifier, or a promise of one: the popup opens at once, since browsers allow a
   *  popup only in a click's own handler, and the request goes once both are ready. */
  challenge: Hex | Promise<Hex>
  /** 1, Bound: humanity from the Wedgie's binding. (2, Fresh, isn't offered yet.) */
  mode?: 1
  door?: string
  /** How long the whole knock may take, presses included: 3 minutes unless told. */
  timeoutMs?: number
}

const CHALLENGE = /^0x[0-9a-fA-F]{64}$/

/** Call it from a click: it opens the Door, and resolves with the knock or rejects with a KnockError. */
export function knock(o: KnockOptions): Promise<Assertion> {
  const door = new URL(o.door ?? DOOR)
  const popup = window.open(new URL('/knock', door).href, 'knock-door', 'popup,width=420,height=680')
  if (!popup)
    return Promise.reject(new KnockError('blocked', 'The browser blocked the Door: knock from a click, or allow popups here.'))

  return new Promise<Assertion>((resolve, reject) => {
    let challenge: Hex | null = null
    let ready = false
    let sent = false
    const send = () => {
      if (sent || !ready || !challenge) return
      sent = true
      // Only the Door's origin can read it: a popup that navigated elsewhere gets nothing
      popup.postMessage({ type: 'knock/request', challenge, mode: o.mode ?? 1 }, door.origin)
    }
    const end = (error: KnockError | null, a?: Assertion) => {
      window.removeEventListener('message', onMessage)
      clearInterval(watch)
      clearTimeout(timer)
      if (error) {
        if (!popup.closed) popup.close()
        reject(error)
      } else resolve(a as Assertion)
    }
    // The Door's word only: from the popup this call opened, at the Door's origin
    const onMessage = (e: MessageEvent) => {
      if (e.source !== popup || e.origin !== door.origin) return
      const m = e.data as { type?: string; ok?: boolean; assertion?: Assertion; error?: string; why?: string }
      if (m?.type === 'knock/ready') {
        ready = true
        send()
      } else if (m?.type === 'knock/result') {
        if (m.ok && m.assertion) end(null, m.assertion)
        else end(new KnockError(m.error ?? 'refused', m.why ?? 'The Door said no.'))
      }
    }
    const watch = setInterval(() => {
      if (popup.closed) end(new KnockError('closed', 'The Door was closed before the Wedgie knocked.'))
    }, 400)
    const timer = setTimeout(
      () => end(new KnockError('timeout', 'No knock in time: the Door is closed, try again.')),
      o.timeoutMs ?? 180_000,
    )
    window.addEventListener('message', onMessage)
    Promise.resolve(o.challenge).then(
      (c) => {
        if (typeof c !== 'string' || !CHALLENGE.test(c))
          return end(new KnockError('challenge', 'The challenge must be 0x and 64 hex digits, from your verifier.'))
        challenge = c
        send()
      },
      (e) => end(new KnockError('challenge', `No challenge from your verifier: ${e instanceof Error ? e.message : String(e)}`)),
    )
  })
}
