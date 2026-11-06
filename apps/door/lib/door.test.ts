// The Door with stand-ins: messages as the browser hands them over (source, origin, data), and a pretend Wedgie
// that answers KNOCK with the vectors' own signed KnockPass. The site's origin is the message's, never the site's
// say; nothing but the opener is listened to; and a knock that doesn't hold never leaves the Door.
import { describe, expect, test } from 'bun:test'
import { NO_HUMAN_REF, digest, signDigest } from '@knock-dev/protocol'
import type { Hex } from 'viem'
import vectors from '../../../spec/vectors/v1.json'
import type { Device } from './device'
import { Refusal, knockOn, okOrigin, readRequest } from './door'
import type { Message, Wedgie } from './wedgie'

const P = vectors.structs.KnockPass
const KEY = vectors.key.compressed as Hex
const SECRET = (vectors.key as Record<string, string>).secret as Hex
const opener = { the: 'site' }
const device: Device = {
  app: 'knock',
  firmware: '5',
  key: KEY,
  name: vectors.device.name,
  status: 'active',
  nullifier: P.message.nullifier as Hex,
  poh: `eip155:480:tx:0x${'cd'.repeat(32)}`,
  counter: 41,
  sc: 'S1',
}

/** A pretend Wedgie: on knock_pass, a green press (the vectors' pass for their request, else one signed now with
 *  the vectors' key), red, or a pass for another origin. */
function wedgie(press: 'green' | 'red' | 'elsewhere' = 'green') {
  const asked: Message[] = []
  const w = {
    ask: async (m: Message) => {
      asked.push(m)
      if (press === 'red') return { type: 'knock_error', error: 'rejected' }
      const origin = press === 'elsewhere' ? 'https://evil.example' : (m.origin as string)
      const message = {
        challenge: m.challenge as Hex,
        origin,
        deviceNode: vectors.device.node as Hex,
        counter: 42n,
        mode: 1 as const,
        nullifier: BigInt(P.message.nullifier),
        humanRef: NO_HUMAN_REF,
      }
      const d = digest('KnockPass', message)
      return {
        type: 'knock_pass_sig',
        ...message,
        counter: 42,
        nullifier: P.message.nullifier,
        digest: d,
        key: KEY,
        ...signDigest(d, SECRET),
      }
    },
  }
  return { w: w as unknown as Wedgie, asked }
}

describe('a request', () => {
  const req = (data: unknown, origin = 'https://bouncer.example', source: unknown = opener) =>
    readRequest({ source, origin, data }, opener)

  test("is the opener's, with the origin the browser gives, whatever the site says it is", () => {
    const r = req({ type: 'knock/request', challenge: P.message.challenge, origin: 'https://bank.example', mode: 1 })
    expect(r).toEqual({ ok: true, request: { challenge: P.message.challenge as Hex, mode: 1, origin: 'https://bouncer.example' } })
  })

  test("from any other window, or not a request: nothing to answer", () => {
    expect(req({ type: 'knock/request', challenge: P.message.challenge }, undefined, { another: 'window' })).toBeNull()
    expect(readRequest({ source: null, origin: 'https://x.example', data: { type: 'knock/request' } }, null)).toBeNull()
    expect(req({ type: 'something/else' })).toBeNull()
  })

  test('a no for an origin the Wedgie would refuse, a bad challenge, or mode 2', () => {
    for (const [data, origin, code] of [
      [{ type: 'knock/request', challenge: P.message.challenge }, 'null', 'bad_origin'],
      [{ type: 'knock/request', challenge: P.message.challenge }, 'http://evil.example', 'bad_origin'],
      [{ type: 'knock/request', challenge: '0x1234' }, 'https://bouncer.example', 'bad_request'],
      [{ type: 'knock/request', challenge: P.message.challenge, mode: 2 }, 'https://bouncer.example', 'bad_request'],
    ] as const) {
      const r = req(data, origin)
      expect(r?.ok).toBe(false)
      expect(r && !r.ok && r.refusal.code).toBe(code)
    }
    expect(okOrigin('http://localhost:3001')).toBe(true)
    expect(okOrigin('http://localhost.evil.example')).toBe(false)
    expect(okOrigin('https://user@bouncer.example')).toBe(false)
    expect(okOrigin('https://Bouncer.example')).toBe(false)
  })
})

describe('a knock', () => {
  const request = { challenge: P.message.challenge as Hex, mode: 1 as const, origin: P.message.origin }

  test("the vectors' pass: KNOCK asked for this challenge and origin, and the knock is theirs, signature and all", async () => {
    const { w, asked } = wedgie()
    const a = await knockOn(w, device, request)
    expect(asked).toEqual([{ type: 'knock_pass', challenge: P.message.challenge, origin: P.message.origin, mode: 1 }])
    expect(a).toEqual({
      v: 1,
      name: vectors.device.name,
      challenge: P.message.challenge as Hex,
      origin: P.message.origin,
      deviceNode: vectors.device.node as Hex,
      counter: 42,
      mode: 1,
      nullifier: P.message.nullifier as Hex,
      humanRef: NO_HUMAN_REF,
      r: P.r as Hex,
      s: P.s as Hex,
    })
  })

  test('red on the Wedgie, a pass for another origin, or a Wedgie not set up: a refusal, and no knock', async () => {
    await expect(knockOn(wedgie('red').w, device, request)).rejects.toMatchObject({ code: 'rejected' })
    await expect(knockOn(wedgie('elsewhere').w, device, request)).rejects.toMatchObject({ code: 'bad_signature' })
    for (const d of [{ ...device, name: null }, { ...device, status: 'revoked' }, { ...device, nullifier: null }]) {
      const { w, asked } = wedgie()
      const e = await knockOn(w, d, request).catch((x) => x)
      expect(e).toBeInstanceOf(Refusal)
      expect(e.code).toBe('not_enrolled')
      expect(asked).toHaveLength(0)
    }
  })
})
