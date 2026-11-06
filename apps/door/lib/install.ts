/**
 * Knock onto a Wedgie from the Console, the way `wedgie.py install .` puts an app from a folder on, and wedgie.dev an
 * app from a repo: Knock isn't on wedgie.dev's shelf, so there's no checked install, signed by wedgie.dev, for it.
 * The Wedgie asks FULL CONTROL? in red, and after a green press the Console has its raw REPL (repl.ts). Knock's files,
 * from getknock/wedgie's latest commit (knock-app.ts), go into its root, each checked by its sha256 on the Wedgie once
 * written. Then apps.json names Knock, the app it had comes off (its saves and the keys in its chip stay), and a
 * restart starts Knock, locked again. The Wedgie keeps its red "modified" border, as for any app that isn't on
 * wedgie.dev's shelf.
 */
import { FIRMWARE, type KnockApp, type Shelf } from './knock-app'
import { type Have, Repl, sha256 } from './repl'
import { Stopped } from './stopped'
import type { Message, Wedgie } from './wedgie'

/** What the firmware keeps free on its flash (save.py FLOOR) */
const FLOOR = 32 * 1024

export type Progress =
  | { step: 'checking' }
  | { step: 'asking' }
  | { step: 'writing'; file: string; n: number; of: number; p: number }
  | { step: 'tidying'; files: string[] }
  | { step: 'restarting' }

/** A version as numbers: "0.3.76" is [0, 3, 76] */
export function versionOf(v: unknown): number[] {
  return typeof v === 'string' && /^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : []
}

export function older(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0)
  return false
}

/** The Knock a Wedgie runs, by its number: knock.py's FW, "knock-6", is 6. Null for anything else. */
export function knockOf(app: unknown): number | null {
  const m = typeof app === 'string' ? app.match(/^knock-(\d+)$/) : null
  return m ? Number(m[1]) : null
}

/** The Knock a hello says runs, or null for another app or none */
export const knockOn = (h: Message): number | null => (h.running === 'knock' ? knockOf(h.app) : null)

/** Is the Knock it runs (its FW, as a Device's app) older than the repo's? */
export function outdated(app: unknown, a: KnockApp): boolean {
  const on = knockOf(app)
  return on !== null && a.version !== null && on < Number(a.version)
}

/** Why Knock can't go on the Wedgie that said hello, or null if it can. The chip's left to chipOf when hello
 *  doesn't know it yet. */
export function fit(h: Message, a: KnockApp): string | null {
  if (typeof h.fw !== 'string' || !h.fw.startsWith('wedgie-'))
    return "Its app has USB to itself, so the Console can't reach the firmware. Switch it to another app at wedgie.dev first."
  if (a.fw && older(versionOf(h.version), versionOf(a.fw)))
    return `Knock needs wedgie firmware ${a.fw} or newer, and this Wedgie has ${String(h.version)}. Update it at wedgie.dev first.`
  if (a.chip && h.chip && h.chip !== a.chip)
    return h.chip === 'none'
      ? `Knock keeps its key in an ${a.chip} chip, and this Wedgie has no secure chip.`
      : `Knock keeps its key in an ${a.chip} chip, and this Wedgie has an ${String(h.chip)}.`
  return null
}

/** wedgie.py's cart_v, wedgie.dev's cartV: an app's version on the Wedgie, from its files' sha256s in order */
export async function cartV(hashes: (string | null)[]): Promise<string> {
  return (await sha256(new TextEncoder().encode(hashes.map((h) => h ?? 'None').join('\n')))).slice(0, 12)
}

/** Knock's apps.json entry, as wedgie.dev writes one for an app from a repo (install.ts appsFor): its files are
 *  listed, so a later install from wedgie.dev knows which files to take off. */
export async function entryFor(a: KnockApp) {
  return {
    mod: a.mod,
    name: a.name,
    ...(a.entry ? { entry: a.entry } : {}),
    ...(a.usb ? { usb: true } : {}),
    about: a.about,
    v: await cartV(a.files.map((f) => f.sha256)),
    repo: a.repo,
    files: a.files.map((f) => f.name),
  }
}

/** A compiled file's source: knock.mpy's is knock.py, and MicroPython would import that one first */
const twin = (n: string) => (n.endsWith('.mpy') ? `${n.slice(0, -4)}.py` : null)
const withTwins = (names: Iterable<string>) => {
  const out = new Set(names)
  for (const n of [...out]) {
    const t = twin(n)
    if (t) out.add(t)
  }
  return out
}

/** The names to hash on the Wedgie: the shelf's every file, and Knock's (apps.json's own are added there) */
export function lookAt(shelf: Shelf | null, a: KnockApp): string[] {
  return [...withTwins([...(shelf?.core ?? []), ...(shelf?.carts.flatMap((c) => c.files) ?? []), ...a.files.map((f) => f.name)])].sort()
}

/** The old app's files, as wedgie.py's others(): every app file on the Wedgie (a shelf app's, or one its apps.json
 *  lists) that neither the firmware nor Knock needs. Without the shelf, only what apps.json lists. Never a firmware
 *  module, apps.json, or a file outside its root. */
export function oldFiles(have: Have, shelf: Shelf | null, a: KnockApp): string[] {
  const listed = have.apps.flatMap((x) => (Array.isArray(x.files) ? x.files.filter((f): f is string => typeof f === 'string') : []))
  const every = withTwins([...(shelf?.carts.flatMap((c) => c.files) ?? []), ...listed])
  const need = withTwins([...(shelf?.core ?? []), ...a.files.map((f) => f.name)])
  return [...every]
    .filter((n) => !need.has(n) && have.hashes[n])
    .filter((n) => /^[A-Za-z0-9_]+\.[A-Za-z0-9]+$/.test(n) && n !== 'apps.json' && !FIRMWARE.has(n.replace(/\.[^.]+$/, '')))
    .sort()
}

/** The secure chip's kind, asked for when hello doesn't know it yet ({"type": "chip"}; busy: ask again) */
async function chipOf(w: Wedgie): Promise<string | null> {
  for (let i = 0; i < 4; i++) {
    const c = await w.ask({ type: 'chip' }, 15_000)
    if (!c.busy) return c.kind === 'trustm' ? 'OPTIGA Trust M' : c.kind === 'atecc' ? 'ATECC608' : 'none'
    await sleep(1000)
  }
  return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Install Knock, or update it, from a: the repo's latest (latestKnock). Each step is said through on(). 'answered':
 * Knock answered on this port after the restart. 'gone': the port went with the restart, as it does after full
 * control (boot.py starts over with a real reset), and the Console finds the Wedgie again (Wedgie.back).
 */
/** An install that stopped after the Wedgie gave full control. Leaving the REPL restarts it, locked, with the app it
 *  had (or none, when the old app's files came off first for room); gone: its port went with the restart. */
export class Restarted extends Stopped {
  constructor(
    message: string,
    readonly gone: boolean,
  ) {
    super(message)
  }
}

export async function installKnock(
  w: Wedgie,
  a: KnockApp,
  shelf: Shelf | null,
  on: (p: Progress) => void,
): Promise<'answered' | 'gone'> {
  on({ step: 'checking' })
  const h = await w.ask({ type: 'hello' }, 3000)
  const no = fit(h, a)
  if (no) throw new Stopped(no)
  if (a.chip && !h.chip) {
    const again = fit({ ...h, chip: await chipOf(w) }, a)
    if (again) throw new Stopped(again)
  }
  const runs = knockOn(h)
  if (runs !== null && a.version !== null && runs > Number(a.version))
    throw new Stopped(`This Wedgie runs Knock ${runs}, newer than the Knock ${a.version} in ${a.repo}.`)
  const job = `${runs !== null ? 'Update' : 'Install'} ${a.name}`

  // The red question. A yes lasts until it restarts; a no restarts it.
  if (h.sealed && !h.open) {
    on({ step: 'asking' })
    const v = await w.ask({ type: 'open', for: job }, 65_000)
    if (v.type !== 'open')
      throw new Stopped(
        v.asked_ms == null
          ? "Your Wedgie said no to this computer before, and won't ask again until it's unplugged. Unplug it, plug it back in, then try again."
          : 'No green press on the Wedgie, so nothing changed on it.',
      )
  }
  await w.ask({ type: 'stop' }, 1000).catch(() => {}) // its app may own the loop and not answer: Ctrl-C stops it
  let r: Repl | null = null
  let stopped: unknown = null
  let emptied = false
  try {
    const repl = await Repl.enter(w) // with no raw REPL, it leaves, which restarts the Wedgie
    r = repl
    await repl.free()
    await repl.busy(`${runs !== null ? 'Updating' : 'Installing'} ${a.name}`)
    const have = await repl.look(lookAt(shelf, a))
    const todo = a.files.filter((f) => have.hashes[f.name] !== f.sha256)
    const gone = oldFiles(have, shelf, a)
    // The old app comes off after Knock's on, so a stop halfway leaves it as it was, unless there's no room for both
    const size = todo.reduce((n, f) => n + f.size, 0)
    const biggest = Math.max(0, ...todo.map((f) => f.size))
    const first = gone.length > 0 && (await repl.room()) < size + biggest + FLOOR
    if (first) {
      on({ step: 'tidying', files: gone })
      emptied = true
      await repl.remove(gone)
    }
    let done = 0
    for (const [i, f] of todo.entries()) {
      on({ step: 'writing', file: f.name, n: i + 1, of: todo.length, p: done / (size || 1) })
      await repl.put(f.name, a.data.get(f.name) as Uint8Array, [done / (size || 1), (done + f.size) / (size || 1)])
      done += f.size
    }
    await repl.put('apps.json', new TextEncoder().encode(JSON.stringify([await entryFor(a)])), [1, 1], '')
    await repl.sync()
    if (!first && gone.length) {
      on({ step: 'tidying', files: gone })
      // Knock is on: an old file that won't come off only takes room
      await repl
        .remove(gone)
        .then(() => repl.sync())
        .catch(() => {})
    }
  } catch (e) {
    stopped = e
  }
  on({ step: 'restarting' })
  await r?.leave().catch(() => {})
  // Its first hello after the restart, Knock's (or after a stop, the app it had), unless the port went with it
  let back: Message | null = null
  for (let i = 0; i < 40 && w.connected && !back; i++) {
    await sleep(500)
    const h = await w.ask({ type: 'hello' }, 1000).catch(() => null)
    if (h && (stopped !== null || knockOn(h) !== null)) back = h
  }
  if (stopped !== null) {
    const why = stopped instanceof Error ? stopped.message : String(stopped)
    const left = emptied
      ? "The old app's files had come off first, to make room, so your Wedgie has no app until Knock is on it."
      : 'Your Wedgie keeps the app it had.'
    // still open: it never restarted (no raw REPL to leave), so its app waits for the computer
    const stuck = w.connected && (!back || back.open === true) ? ' Unplug it and plug it back in, then try again.' : ''
    throw new Restarted(`The install stopped: ${why}. ${left}${stuck}`, !w.connected)
  }
  if (back) return 'answered'
  if (w.connected) throw new Stopped("Knock went on, but the Wedgie hasn't answered since it restarted. Unplug it and plug it in again.")
  return 'gone'
}
