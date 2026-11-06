// knock() against a pretend browser: window.open gives a pretend popup, and messages are handed to the SDK's
// listener as the browser would, with their source and origin. What the popup is sent, and to which origin, is
// checked, and that nothing but the Door's own popup at the Door's origin is listened to.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type Assertion, KnockError, knock } from '../src/index.ts'

const CHALLENGE = `0x${'ab'.repeat(32)}` as const
const DOOR = 'http://localhost:3000'
const assertion = { v: 1, name: 'wedgie.itzraj.eth', challenge: CHALLENGE, counter: 43 } as unknown as Assertion

type Popup = { closed: boolean; posted: [unknown, string][]; postMessage: (m: unknown, o: string) => void; close: () => void }
let listeners: ((e: unknown) => void)[]
let opened: string[]
let popup: Popup | null

beforeEach(() => {
  listeners = []
  opened = []
  popup = {
    closed: false,
    posted: [],
    postMessage(m, o) {
      this.posted.push([m, o])
    },
    close() {
      this.closed = true
    },
  }
  ;(globalThis as { window?: unknown }).window = {
    open: (url: string) => {
      opened.push(url)
      return popup
    },
    addEventListener: (_: string, f: (e: unknown) => void) => listeners.push(f),
    removeEventListener: (_: string, f: (e: unknown) => void) => {
      listeners = listeners.filter((x) => x !== f)
    },
  }
})
afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

const from = (source: unknown, origin: string, data: unknown) => {
  for (const f of [...listeners]) f({ source, origin, data })
}
const tick = () => new Promise((r) => setTimeout(r, 5))

describe('knock', () => {
  test("opens the Door, sends the challenge once it's ready, to the Door's origin only, and gives back the knock", async () => {
    const out = knock({ challenge: CHALLENGE })
    expect(opened).toEqual([`${DOOR}/knock`])
    from(popup, DOOR, { type: 'knock/ready' })
    await tick()
    expect(popup?.posted).toEqual([[{ type: 'knock/request', challenge: CHALLENGE, mode: 1 }, DOOR]])
    from(popup, DOOR, { type: 'knock/result', ok: true, assertion })
    expect(await out).toEqual(assertion)
    expect(listeners).toHaveLength(0)
  })

  test("a challenge still on its way: the popup opens at once, and the request goes when it comes, once", async () => {
    let give: (c: `0x${string}`) => void = () => {}
    const out = knock({ challenge: new Promise((r) => (give = r)) })
    expect(opened).toHaveLength(1)
    from(popup, DOOR, { type: 'knock/ready' })
    from(popup, DOOR, { type: 'knock/ready' })
    await tick()
    expect(popup?.posted).toHaveLength(0)
    give(CHALLENGE)
    await tick()
    expect(popup?.posted).toHaveLength(1)
    from(popup, DOOR, { type: 'knock/result', ok: true, assertion })
    expect(await out).toEqual(assertion)
  })

  test("a result from another window, or from another origin, is no result", async () => {
    const out = knock({ challenge: CHALLENGE })
    from(popup, DOOR, { type: 'knock/ready' })
    from({ other: 'window' }, DOOR, { type: 'knock/result', ok: true, assertion: { forged: true } })
    from(popup, 'https://evil.example', { type: 'knock/result', ok: true, assertion: { forged: true } })
    from(popup, DOOR, { type: 'knock/result', ok: true, assertion })
    expect(await out).toEqual(assertion)
  })

  test("the Door's no comes back as its code and words, and the Door is closed", async () => {
    const out = knock({ challenge: CHALLENGE })
    from(popup, DOOR, { type: 'knock/ready' })
    from(popup, DOOR, { type: 'knock/result', ok: false, error: 'rejected', why: 'Red on the Wedgie.' })
    const e = await out.catch((x) => x)
    expect(e).toBeInstanceOf(KnockError)
    expect([e.code, e.message]).toEqual(['rejected', 'Red on the Wedgie.'])
    expect(popup?.closed).toBe(true)
  })

  test('a closed popup, a blocked one, a bad challenge, a failed one, or no answer in time', async () => {
    const closed = knock({ challenge: CHALLENGE })
    if (popup) popup.closed = true
    expect((await closed.catch((x) => x)).code).toBe('closed')

    popup = null
    expect((await knock({ challenge: CHALLENGE }).catch((x) => x)).code).toBe('blocked')

    popup = { closed: false, posted: [], postMessage() {}, close() { this.closed = true } } as Popup
    expect((await knock({ challenge: '0x1234' }).catch((x) => x)).code).toBe('challenge')
    expect(popup.closed).toBe(true)

    popup = { closed: false, posted: [], postMessage() {}, close() { this.closed = true } } as Popup
    const failed = await knock({ challenge: Promise.reject(new Error('verifier down')) }).catch((x) => x)
    expect([failed.code, failed.message]).toEqual(['challenge', 'No challenge from your verifier: verifier down'])

    popup = { closed: false, posted: [], postMessage() {}, close() { this.closed = true } } as Popup
    expect((await knock({ challenge: CHALLENGE, timeoutMs: 20 }).catch((x) => x)).code).toBe('timeout')
    expect(popup.closed).toBe(true)
    expect(listeners).toHaveLength(0)
  })

  test('another Door: opened there, and only its origin is answered', async () => {
    const out = knock({ challenge: CHALLENGE, door: 'https://door.knock.example' })
    expect(opened).toEqual(['https://door.knock.example/knock'])
    from(popup, DOOR, { type: 'knock/ready' })
    await tick()
    expect(popup?.posted).toHaveLength(0)
    from(popup, 'https://door.knock.example', { type: 'knock/ready' })
    await tick()
    expect(popup?.posted[0][1]).toBe('https://door.knock.example')
    from(popup, 'https://door.knock.example', { type: 'knock/result', ok: true, assertion })
    expect(await out).toEqual(assertion)
  })
})
