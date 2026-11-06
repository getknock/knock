'use client'
import { useEffect, useRef } from 'react'
import { canvasPainter, drawQr, logo } from '../../lib/screen'
import { mono } from '../fonts'

/** What the Wedgie's screen shows: the Console mirrors it. */
export type View =
  | { kind: 'off' }
  /** A Wedgie that runs another app (its name), or none: what it draws isn't Knock's to show */
  | { kind: 'app'; name: string | null }
  | { kind: 'home'; name: string | null; human: boolean }
  | { kind: 'qr'; n: number; bits: string }
  | { kind: 'bind'; key: string; nullifier: string }
  | { kind: 'become'; name: string }
  | { kind: 'knock'; name: string; origin: string }
  /** The firmware's red question before a computer gets its REPL (hatch.ask) */
  | { kind: 'full' }
  /** The boot screen and its bar while the Console has the REPL (repl.ts busy) */
  | { kind: 'installing'; title: string; what: string; p: number }

const INK = '#000000'
const MUTED = '#6b6b6b'
// The firmware's own colors (ui.py): its red, green, and the boot screen's grays
const RED = '#e3312c'
const GREEN = '#22c452'
const WHITE = '#fefefe'

/** A key or hash as the Wedgie shortens it. */
export function short(h: string): string {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h
}

function draw(c: CanvasRenderingContext2D, view: View) {
  const p = canvasPainter(c)
  const text = (t: string, y: number, size: number, color = INK, weight = 700) => {
    c.fillStyle = color
    c.font = `${weight} ${size}px ${mono.style.fontFamily}`
    c.textAlign = 'center'
    c.textBaseline = 'top'
    c.fillText(t, 120, y)
  }
  c.textAlign = 'start'
  if (view.kind === 'off') {
    p.rect(0, 0, 240, 240, '#000000')
    text('Plug in your Wedgie', 112, 13, '#8a8a8a', 400)
    return
  }
  if (view.kind === 'app') {
    p.rect(0, 0, 240, 240, '#000000')
    text(view.name ?? 'No app', 98, 17, WHITE)
    text(view.name ? 'runs here, not Knock' : 'Knock can go on it', 124, 13, '#8a8a8a', 400)
    return
  }
  if (view.kind === 'qr') {
    drawQr(p, view.n, view.bits)
    return
  }
  if (view.kind === 'full') {
    // ui.ask(scary=True): white on red, the yes bar green, a white line over the red no bar
    p.rect(0, 0, 240, 240, RED)
    text('! WARNING !', 14, 16, WHITE)
    text('FULL CONTROL?', 48, 16, WHITE)
    ;['This computer could run any', 'code and make the chip sign', 'anything: send your money.', '', "Didn't ask? Press red"].forEach(
      (l, i) => text(l, 100 + i * 15, 12, WHITE, 400),
    )
    p.rect(0, 184, 240, 26, GREEN)
    text('full control', 190, 15, WHITE)
    p.rect(0, 212, 240, 2, WHITE)
    text('no', 220, 15, WHITE)
    return
  }
  if (view.kind === 'installing') {
    // BUSY_PY's boot screen: the waistband's stripes, what's going on, and the bar
    p.rect(0, 0, 240, 240, WHITE)
    ;[
      [10, GREEN],
      [19, '#a9aaab'],
      [28, RED],
    ].forEach(([y, color]) => p.rect(0, y as number, 240, 5, color as string))
    text(view.title, 92, 16, '#787b78')
    text(view.what.slice(0, 28), 120, 13, INK, 400)
    p.rect(30, 160, 180, 14, '#c8c8c4')
    p.rect(31, 161, 178, 12, WHITE)
    p.rect(32, 162, Math.round(176 * Math.min(1, Math.max(0, view.p))), 10, GREEN)
    return
  }
  p.rect(0, 0, 240, 240, '#ffffff')
  if (view.kind === 'home') {
    logo(p, 85, 50, 5)
    text(view.name ?? 'Knock', 140, 15)
    text(view.human ? 'bound to a human' : 'not bound yet', 164, 13, MUTED, 400)
    return
  }
  // The BIND and BECOME pages: what it does, in words, and whose question it is
  const title = view.kind === 'become' ? 'BECOME' : view.kind === 'knock' ? 'KNOCK' : 'BIND'
  c.font = `800 18px ${mono.style.fontFamily}`
  const w = c.measureText(title).width
  logo(p, Math.round(120 - (34 + w) / 2), 6, 2)
  c.fillStyle = INK
  c.textBaseline = 'top'
  c.fillText(title, Math.round(120 - (34 + w) / 2) + 34, 11)
  text(view.kind === 'knock' ? 'a bound human' : 'the Knock Console asks', 214, 11, MUTED, 400)
  if (view.kind === 'knock') {
    // The device's own KNOCK page: as which name, for which site, and whose word the site is
    text(`as ${view.name}`, 52, 13)
    text('for', 88, 13, MUTED, 400)
    const lines = view.origin.match(/.{1,24}/g) ?? []
    lines.forEach((l, i) => text(l, 109 + i * 21, 13))
    text('unverified: the Door says so', 109 + lines.length * 21 + 8, 11, MUTED, 400)
    return
  }
  if (view.kind === 'become') {
    const [first, ...rest] = view.name.split('.')
    text(first, 58, 22)
    if (rest.length) text(`.${rest.join('.')}`, 88, 13, MUTED, 400)
    text('its key goes in ENS under', 130, 13)
    text('this name, for anyone', 151, 13)
    return
  }
  const lines: [string, string][] = [
    ["this wedgie's key", INK],
    [short(view.key), MUTED],
    ["to one human's World ID", INK],
    [short(view.nullifier), MUTED],
    ['', INK],
    ['on World Chain', INK],
  ]
  lines.forEach(([t, color], i) => text(t, 52 + i * 21, 13, color, color === INK ? 700 : 400))
}

export function Screen({ view, waitingForGreen }: { view: View; waitingForGreen: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = canvas.current?.getContext('2d')
    if (!c) return
    const paint = () => {
      c.setTransform(2, 0, 0, 2, 0, 0)
      c.imageSmoothingEnabled = false
      draw(c, view)
    }
    paint()
    document.fonts?.ready.then(paint)
  }, [view])
  const label =
    view.kind === 'qr'
      ? 'The Wedgie shows a QR code for World ID'
      : view.kind === 'bind'
        ? "The Wedgie asks: bind this wedgie's key to one human's World ID?"
        : view.kind === 'become'
          ? `The Wedgie asks: become ${view.name}? Its key goes in ENS under this name.`
        : view.kind === 'knock'
          ? `The Wedgie asks: knock as ${view.name} for ${view.origin}?`
        : view.kind === 'full'
          ? 'The Wedgie asks in red: FULL CONTROL? Green gives this computer full control until it restarts.'
        : view.kind === 'installing'
          ? `The Wedgie's screen: ${view.title}${view.what ? `, ${view.what}` : ''}, ${Math.round(view.p * 100)}%`
        : view.kind === 'home'
          ? `The Wedgie's home screen: ${view.name ?? 'Knock'}`
        : view.kind === 'app'
          ? view.name
            ? `The Wedgie runs ${view.name}, not Knock`
            : 'The Wedgie has no app on it'
          : 'No Wedgie connected'
  return (
    <div className="wedgie">
      <canvas ref={canvas} width={480} height={480} role="img" aria-label={label} />
      <div className="buttons" aria-hidden="true">
        <span className={`button go${waitingForGreen ? ' now' : ''}`} />
        <span className="button stop" />
      </div>
    </div>
  )
}
