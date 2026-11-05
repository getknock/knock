/**
 * The Wedgie's QR page, drawn here as the Wedgie draws it (getknock/wedgie knock_knock.draw_qr): the same
 * 240 x 240 pixels, the same module size and quiet zone, the SCAN header when there's room, and Knock's logo in
 * the middle when the code's own format bits say it can lose what the logo covers.
 */
import { dark } from './qr'

/** Something to draw on in rectangles, as the firmware does: a canvas, or a test's pixels. */
export type Painter = {
  rect(x: number, y: number, w: number, h: number, color: string): void
  text?(word: string, x: number, y: number, color: string): void
}

/** wedgie.json's icon: k black, y yellow, w white (knock.py's ICON). */
export const ICON = [
  '............',
  '..kkkkkkk...',
  '..kyyyyyk..w',
  '..kyyyyyk.w.',
  '..kyyyyyk...',
  '..kyyyyyk.ww',
  '..kyyykyk...',
  '..kyyyyyk.w.',
  '..kyyyyyk..w',
  '..kyyyyyk...',
  '.kkkkkkkkk..',
  '............',
]
const INKS: Record<string, string> = { k: '#000000', y: '#ffdc00', w: '#ffffff' }
const LABEL = '#6e56cf'
/** The share of a code's modules the logo's white square may take: H mends 30%, Q 25% (knock_knock.LOGO). */
const LOGO: Record<string, number> = { H: 0.09, Q: 0.05 }

/** The code's error correction from its format bits (either copy), or null: knock_knock.qr_level. */
export function qrLevel(n: number, bits: string): 'L' | 'M' | 'Q' | 'H' | null {
  const copies = [
    (i: number): [number, number] => (i < 6 ? [i, 8] : i === 6 ? [7, 8] : i < 9 ? [8, 15 - i] : [8, 14 - i]),
    (i: number): [number, number] => (i < 8 ? [8, n - 1 - i] : [n - 15 + i, 8]),
  ]
  for (const at of copies) {
    let f = 0
    for (let i = 0; i < 15; i++) f |= Number(dark(n, bits, ...at(i))) << i
    f ^= 0x5412
    let rem = f >> 10
    for (let j = 0; j < 10; j++) rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    if (f === (((f >> 10) << 10) | rem)) return 'MLHQ'[f >> 13] as 'L' | 'M' | 'Q' | 'H'
  }
  return null
}

/** [u, k]: the logo's cells u px on a white square k modules across, or null: knock_knock.logo_fit. */
export function logoFit(n: number, s: number, level: string | null): [number, number] | null {
  const share = level ? LOGO[level] : undefined
  if (!share) return null
  for (const u of [5, 4, 3, 2]) {
    const k = Math.ceil((14 * u + 2 * s) / s) | 1
    if (k * k <= share * n * n) return [u, k]
  }
  return null
}

/** A filled rectangle with corners rounded to r: knock._round. */
function round(p: Painter, x: number, y: number, w: number, h: number, r: number, color: string) {
  p.rect(x, y + r, w, h - 2 * r, color)
  for (let i = 0; i < r; i++) {
    const k = Math.floor(r - Math.sqrt(r * r - (r - i - 0.5) ** 2) + 0.5)
    p.rect(x + k, y + i, w - 2 * k, 1, color)
    p.rect(x + k, y + h - 1 - i, w - 2 * k, 1, color)
  }
}

/** The logo, 14u px square, top left at (x, y): the icon's cells u px, one cell in on its tile (knock.logo). */
export function logo(p: Painter, x: number, y: number, u: number) {
  round(p, x, y, 14 * u, 14 * u, 3 * u, LABEL)
  ICON.forEach((row, r) => {
    for (let i = 0; i < 12; i++) if (row[i] !== '.') p.rect(x + (i + 1) * u, y + (r + 1) * u, u, u, INKS[row[i]])
  })
}

/** The QR page, 240 x 240. Returns what the Wedgie answers with it: px a module, and whether the logo's in. */
export function drawQr(p: Painter, n: number, bits: string): { scale: number; logo: boolean } {
  const s = Math.floor(240 / (n + 8))
  let top = 0
  p.rect(0, 0, 240, 240, '#ffffff')
  if ((n + 8) * s + 40 <= 240) {
    // knock.head("SCAN", 6): the logo at 2 px a cell, the word in the firmware's 8 px font at twice its size
    const x = (240 - (34 + 64)) >> 1
    logo(p, x, 6, 2)
    p.text?.('SCAN', x + 34, 12, '#000000')
    top = 40
  }
  const x0 = (240 - n * s) >> 1
  const y0 = top + ((240 - top - n * s) >> 1)
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) if (dark(n, bits, r, c)) p.rect(x0 + c * s, y0 + r * s, s, s, '#000000')
  const fit = logoFit(n, s, qrLevel(n, bits))
  if (fit) {
    const [u, k] = fit
    const x = x0 + ((n - k) >> 1) * s
    const y = y0 + ((n - k) >> 1) * s
    p.rect(x, y, k * s, k * s, '#ffffff')
    logo(p, x + ((k * s - 14 * u) >> 1), y + ((k * s - 14 * u) >> 1), u)
  }
  return { scale: s, logo: fit !== null }
}

/** A canvas as a Painter. */
export function canvasPainter(c: CanvasRenderingContext2D): Painter {
  return {
    rect(x, y, w, h, color) {
      c.fillStyle = color
      c.fillRect(x, y, w, h)
    },
    text(word, x, y, color) {
      c.fillStyle = color
      c.font = 'bold 16px ui-monospace, monospace'
      c.textBaseline = 'top'
      c.fillText(word, x, y)
    },
  }
}
