/**
 * What a knock at the Human Club is for, decided before it's made (D32): coming in; starting, signing or closing a
 * petition; starting or closing a fundraiser. The page and the club's server both read an act with readIntent, so
 * what the page lets you send is what the server takes. A fundraiser's gifts go to the wallet its starter's Wedgie
 * name resolves to, so a fundraiser always shows that name; a petition and its signatures can show none.
 */
import { formatEther, parseEther } from 'viem'

export type Intent =
  /** Knock in: see what you've started, signed and given */
  | { act: 'in' }
  | { act: 'start'; title: string; target: string; body: string; listed: boolean }
  | { act: 'sign'; petition: number; listed: boolean; reason: string }
  /** Only the human who started it, with any of their Wedgies */
  | { act: 'close'; petition: number; outcome: 'won' | 'closed' }
  /** A fundraiser: gifts in ETH, to the starter's Wedgie name. Its goal is in ETH, as typed ("0.5"). */
  | { act: 'raise'; title: string; story: string; goal: string }
  | { act: 'stop'; fundraiser: number }

export const LIMITS = {
  title: [8, 90],
  target: [2, 80],
  body: [40, 3000],
  reason: [0, 280],
  story: [40, 5000],
  message: [0, 280],
} as const satisfies Record<string, readonly [number, number]>

/** A fundraiser's goal, and a gift, in ETH */
export const GOAL = { min: parseEther('0.001'), max: parseEther('1000') }
export const GIFT = { min: parseEther('0.0001'), max: parseEther('100') }

const length = (s: string) => [...s].length

/** Text as the club keeps it: trimmed, Unix newlines, at most one blank line in a row, and nothing that reorders
 *  or hides characters. Null when it holds a character the club won't show. */
export function cleanText(s: string): string | null {
  const t = s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/ +\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  // Control characters but the newline, and the bidi overrides and isolates that can disguise text
  if (/[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/.test(t)) return null
  return t
}

/** One field's text, or why not */
export function field(x: unknown, what: keyof typeof LIMITS, said: string): string | { why: string } {
  if (x === undefined || x === null || x === '') x = ''
  if (typeof x !== 'string') return { why: `${said} isn't text.` }
  const t = cleanText(x)
  if (t === null) return { why: `${said} has a character the club doesn't take.` }
  const [min, max] = LIMITS[what]
  const n = length(t)
  if (n < min) return { why: n === 0 ? `${said} is empty.` : `${said} needs at least ${min} characters.` }
  if (n > max) return { why: `${said} can be ${max} characters at most; it has ${n}.` }
  return t
}

/** An amount of ETH as people type it ("0.5", "2"), in wei, within bounds; or why not */
export function ethOf(x: unknown, bounds: { min: bigint; max: bigint }, said: string): bigint | { why: string } {
  const s = typeof x === 'string' ? x.trim() : typeof x === 'number' ? String(x) : ''
  if (!/^\d{1,7}(\.\d{1,18})?$/.test(s)) return { why: `${said} is an amount of ETH, such as 0.5.` }
  const wei = parseEther(s)
  if (wei < bounds.min) return { why: `${said} is at least ${formatEther(bounds.min)} ETH.` }
  if (wei > bounds.max) return { why: `${said} is at most ${formatEther(bounds.max)} ETH.` }
  return wei
}

const id = (x: unknown) => (Number.isSafeInteger(x) && (x as number) > 0 ? (x as number) : null)
const line = (s: string) => s.replace(/\s+/g, ' ')

/** An act from the page, checked for shape and length, or why it isn't one */
export function readIntent(x: unknown): Intent | { why: string } {
  const o = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>
  switch (o.act) {
    case 'in':
      return { act: 'in' }
    case 'start': {
      const title = field(o.title, 'title', 'The title')
      if (typeof title !== 'string') return title
      const target = field(o.target, 'target', 'Who it’s to')
      if (typeof target !== 'string') return target
      const body = field(o.body, 'body', 'What it asks')
      if (typeof body !== 'string') return body
      return { act: 'start', title: line(title), target: line(target), body, listed: o.listed === true }
    }
    case 'sign': {
      const petition = id(o.petition)
      if (!petition) return { why: 'No such petition.' }
      const reason = field(o.reason, 'reason', 'Your reason')
      if (typeof reason !== 'string') return reason
      return { act: 'sign', petition, listed: o.listed === true, reason }
    }
    case 'close': {
      const petition = id(o.petition)
      if (!petition) return { why: 'No such petition.' }
      if (o.outcome !== 'won' && o.outcome !== 'closed') return { why: 'A petition closes as won, or just closed.' }
      return { act: 'close', petition, outcome: o.outcome }
    }
    case 'raise': {
      const title = field(o.title, 'title', 'The title')
      if (typeof title !== 'string') return title
      const story = field(o.story, 'story', 'What it’s for')
      if (typeof story !== 'string') return story
      const goal = ethOf(o.goal, GOAL, 'The goal')
      if (typeof goal !== 'bigint') return goal
      return { act: 'raise', title: line(title), story, goal: formatEther(goal) }
    }
    case 'stop': {
      const fundraiser = id(o.fundraiser)
      if (!fundraiser) return { why: 'No such fundraiser.' }
      return { act: 'stop', fundraiser }
    }
    default:
      return { why: 'The club takes knocks to come in, and to start, sign or close a petition or a fundraiser.' }
  }
}

/** The UTC day, as YYYYMMDD: one new petition, and one new fundraiser, a day per human */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '')

/** The verifier's action for an act (check 8: once per human per action), or none */
export function actionOf(i: Intent, now: number): string | null {
  if (i.act === 'start') return `start-${dayOf(now)}`
  if (i.act === 'raise') return `raise-${dayOf(now)}`
  if (i.act === 'sign') return `sign-${i.petition}`
  return null
}

/** The next milestone a petition is going for, as change.org shows one */
export function goalOf(count: number): number {
  for (const m of [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 25_000, 50_000, 100_000]) if (count < m) return m
  return Math.ceil((count + 1) / 100_000) * 100_000
}

/** ETH for people: at most 4 decimals, trailing zeros dropped */
export function eth(wei: bigint | string): string {
  const v = typeof wei === 'string' ? BigInt(wei) : wei
  const [whole, frac = ''] = formatEther(v).split('.')
  const cut = frac.slice(0, 4).replace(/0+$/, '')
  const shown = cut ? `${whole}.${cut}` : whole
  return shown === '0' && v > 0n ? '<0.0001' : shown
}
