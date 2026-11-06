'use client'
import { useEffect, useRef } from 'react'
import { canvasPainter, drawQr, logo } from '../../lib/screen'
import { mono } from '../fonts'

/** What the Wedgie's screen shows: the Console mirrors it. */
export type View =
  | { kind: 'off' }
  | { kind: 'home'; name: string | null; human: boolean }
  | { kind: 'qr'; n: number; bits: string }
  | { kind: 'bind'; key: string; nullifier: string }
  | { kind: 'become'; name: string }
  | { kind: 'knock'; name: string; origin: string }

const INK = '#000000'
const MUTED = '#6b6b6b'

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
  if (view.kind === 'qr') {
    drawQr(p, view.n, view.bits)
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
        : view.kind === 'home'
          ? `The Wedgie's home screen: ${view.name ?? 'Knock'}`
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
