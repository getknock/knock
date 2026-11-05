import { describe, expect, test } from 'bun:test'
import decodeQR from 'qr/decode.js'
import { dark, knockQr } from './qr'
import { type Painter, drawQr, logoFit, qrLevel } from './screen'

// IDKit links are about this long: staging.world.org/verify?t=wld&i=<uuid>&k=<the request's key>
const STAGING = 'https://staging.world.org/verify?t=wld&i=6c0f3a1e-9b2d-4e57-a8c4-1f2e3d4c5b6a&k=S25vY2sga25vY2suIFdobydzIHRoZXJlPyBBIGh1bWFuLg%3D%3D'
const PRODUCTION = 'https://world.org/verify?t=wld&i=6c0f3a1e-9b2d-4e57-a8c4-1f2e3d4c5b6a&k=S25vY2sga25vY2suIFdobydzIHRoZXJlPyBBIGh1bWFuLg%3D%3D'
const SHORT = 'https://knock.example/'

/** 240 x 240 RGBA pixels, painted as the Wedgie paints its screen. */
function paper(): { p: Painter; img: { width: number; height: number; data: Uint8Array } } {
  const data = new Uint8Array(240 * 240 * 4)
  const p: Painter = {
    rect(x, y, w, h, color) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
      for (let yy = Math.max(0, y); yy < Math.min(240, y + h); yy++)
        for (let xx = Math.max(0, x); xx < Math.min(240, x + w); xx++) data.set([r, g, b, 255], (yy * 240 + xx) * 4)
    },
  }
  return { p, img: { width: 240, height: 240, data } }
}

describe('knock_qr', () => {
  test('a link at H: n x n modules, high bit first, the finder where it belongs', () => {
    const { n, bits } = knockQr(STAGING)
    expect(n).toBe(61) // version 11, as on the Wedgie (PLAN.md D13)
    expect(bits.length).toBe(2 + 2 * Math.ceil((n * n) / 8))
    const row = (r: number) => Array.from({ length: 8 }, (_, c) => Number(dark(n, bits, r, c))).join('')
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(row)).toEqual(
      ['11111110', '10000010', '10111010', '10111010', '10111010', '10000010', '11111110', '00000000'],
    )
  })

  test("the code's format bits say H, as the Wedgie reads them", () => {
    for (const link of [STAGING, PRODUCTION, SHORT]) {
      const { n, bits } = knockQr(link)
      expect(qrLevel(n, bits)).toBe('H')
    }
  })

  test('a code with both format copies spoiled has no level, so no logo', () => {
    const { n, bits } = knockQr(SHORT)
    const b = Array.from(Buffer.from(bits.slice(2), 'hex'))
    const flip = (r: number, c: number) => {
      const i = r * n + c
      b[i >> 3] ^= 0x80 >> (i & 7)
    }
    flip(0, 8)
    flip(8, n - 1)
    const spoiled = `0x${Buffer.from(b).toString('hex')}`
    expect(qrLevel(n, spoiled)).toBeNull()
    expect(drawQr(paper().p, n, spoiled).logo).toBe(false)
  })

  test('logo_fit gives what the Wedgie gives, for every code that fits its screen', () => {
    // [n, px a module, logo_fit at H, at Q]: getknock/wedgie knock_knock.logo_fit, versions 1 to 23
    const device: [number, number, number[] | null, number[] | null][] = [
      [21, 8, null, null], [25, 7, [2, 7], null], [29, 6, [2, 7], null], [33, 5, [2, 9], null],
      [37, 5, [3, 11], null], [41, 4, [2, 9], [2, 9]], [45, 4, [3, 13], [2, 9]], [49, 4, [3, 13], [2, 9]],
      [53, 3, [2, 13], null], [57, 3, [3, 17], null], [61, 3, [3, 17], [2, 13]], [65, 3, [3, 17], [2, 13]],
      [69, 3, [3, 17], [2, 13]], [73, 2, [2, 17], null], [77, 2, [3, 23], [2, 17]], [81, 2, [3, 23], [2, 17]],
      [85, 2, [3, 23], [2, 17]], [89, 2, [3, 23], [2, 17]], [93, 2, [3, 23], [2, 17]], [97, 2, [3, 23], [2, 17]],
      [101, 2, [3, 23], [2, 17]], [105, 2, [4, 31], [3, 23]], [109, 2, [4, 31], [3, 23]],
    ]
    for (const [n, s, h, q] of device) {
      expect(Math.floor(240 / (n + 8))).toBe(s)
      expect(logoFit(n, s, 'H')).toEqual(h as [number, number] | null)
      expect(logoFit(n, s, 'Q')).toEqual(q as [number, number] | null)
      expect(logoFit(n, s, 'M')).toBeNull()
      expect(logoFit(n, s, null)).toBeNull()
    }
  })

  test('drawn as the Wedgie draws it, logo and all, it reads back as the link', () => {
    for (const link of [STAGING, PRODUCTION, SHORT]) {
      const { n, bits } = knockQr(link)
      const { p, img } = paper()
      const shown = drawQr(p, n, bits)
      expect(shown.scale).toBe(Math.floor(240 / (n + 8)))
      expect(shown.logo).toBe(n > 21) // version 1 has no room for one
      expect(decodeQR(img)).toBe(link)
    }
  })
})
