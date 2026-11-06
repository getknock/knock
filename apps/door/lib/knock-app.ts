/**
 * The Knock app the Console installs: always getknock/wedgie's latest commit, read the way wedgie.dev reads an app
 * from a repo (wedgie.dev's src/apps/repos.ts). GitHub names the commit main is at, and every file comes from that
 * one commit: wedgie.json, held to wedgie.dev's rules for an app (src/apps/appjson.mjs), then each file it lists.
 * Nothing is kept here between visits, so a Knock pushed to the repo is the one the Console offers next.
 */
import { sha256 } from './repl'

export const REPO = 'getknock/wedgie'
const MOD = 'knock'

/** wedgie.dev's firmware list and shelf (its fw/manifest.json): its core files, and each shelf app's files */
export type Shelf = { version: string; core: string[]; carts: { mod: string; name?: string; files: string[]; repo?: string }[] }
const SHELF = 'https://wedgie.dev/fw/manifest.json'

/** The firmware's own modules (0.3.77's core): no app file is one of these, whatever the shelf says */
export const FIRMWARE = new Set(
  'atecc bar boot drive hatch home inbox job lcd listcheck loader logo main net oled optiga p256 power roots save slot small splash tls trustm ui usbdev wedgie wedgiedrive'.split(
    ' ',
  ),
)

// wedgie.dev's rules for an app's files (appjson.mjs): its mod's name, lowercase, one of these kinds, at most 256 KB
const FILE = /^[a-z][a-z0-9_]*\.(py|mpy|bin|json|txt)$/
const MAX_FILES = 30
const MAX_APP_BYTES = 256 * 1024

export type KnockApp = {
  repo: string
  /** The commit, or the branch when GitHub's API didn't say (60 lookups an hour per visitor) */
  sha: string
  at: string | null
  mod: string
  name: string
  about: string
  version: string | null
  entry: string | null
  usb: boolean
  fw: string | null
  chip: string | null
  files: { name: string; size: number; sha256: string }[]
  data: Map<string, Uint8Array>
}

type AppJson = {
  mod?: unknown
  name?: unknown
  about?: unknown
  files?: unknown
  version?: unknown
  entry?: unknown
  usb?: unknown
  fw?: unknown
  chip?: unknown
}

/** wedgie.dev's shelf, or null when it can't be read */
export async function shelfOf(get: typeof fetch = fetch): Promise<Shelf | null> {
  try {
    const r = await get(SHELF, { cache: 'no-cache' })
    const m = (await r.json()) as Shelf
    return r.ok && Array.isArray(m.core) && Array.isArray(m.carts) ? m : null
  } catch {
    return null
  }
}

/** What's wrong with wedgie.json's Knock, by wedgie.dev's rules for an app from a repo: nothing, when it's [] */
export function problems(a: AppJson, shelf: Shelf | null): string[] {
  const bad: string[] = []
  const core = shelf?.core ?? []
  if (a.mod !== MOD) return [`mod: ${String(a.mod)}, not ${MOD}`]
  if (shelf?.carts.some((c) => c.mod === MOD && (c.repo ?? '').toLowerCase() !== REPO)) bad.push(`${MOD} is another app on wedgie.dev`)
  if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > 14) bad.push('name: 1-14 characters')
  if (a.about !== undefined && (typeof a.about !== 'string' || a.about.length > 140)) bad.push('about: up to 140 characters')
  if (!Array.isArray(a.files) || !a.files.length || a.files.length > MAX_FILES) return [...bad, `files: 1-${MAX_FILES} of them`]
  const seen = new Set<string>()
  for (const p of a.files) {
    const stem = typeof p === 'string' ? p.replace(/\.[a-z]+$/, '') : ''
    if (typeof p !== 'string' || p.includes('/') || !FILE.test(p)) bad.push(`${String(p)}: a plain file at the repo's top, lowercase, .py .mpy .bin .json or .txt`)
    else if (stem !== MOD && !stem.startsWith(`${MOD}_`)) bad.push(`${p}: not named ${MOD}.py or ${MOD}_*`)
    else if (core.includes(p) || FIRMWARE.has(stem)) bad.push(`${p}: a firmware file`)
    else if (seen.has(p)) bad.push(`${p}: twice`)
    else seen.add(p)
  }
  if (!seen.has(`${MOD}.py`) && !seen.has(`${MOD}.mpy`)) bad.push(`files: no ${MOD}.py`)
  if (a.entry !== undefined && (typeof a.entry !== 'string' || !/^[a-z_][a-z0-9_]*$/i.test(a.entry))) bad.push('entry: a function name')
  if (a.fw !== undefined && (typeof a.fw !== 'string' || !/^\d+\.\d+\.\d+$/.test(a.fw))) bad.push('fw: a version like 0.3.36')
  if (a.version !== undefined && (typeof a.version !== 'string' || !/^\d+(\.\d+){0,2}$/.test(a.version))) bad.push('version: a number')
  return bad
}

/** Knock as getknock/wedgie has it now: the commit main is at, its wedgie.json entry, and every file from that commit */
export async function latestKnock(shelf: Shelf | null, get: typeof fetch = fetch): Promise<KnockApp> {
  let sha = 'main'
  let at: string | null = null
  try {
    const r = await get(`https://api.github.com/repos/${REPO}/commits/main`)
    if (r.ok) {
      const j = (await r.json()) as { sha?: string; commit?: { committer?: { date?: string } } }
      if (typeof j.sha === 'string' && /^[0-9a-f]{40}$/.test(j.sha)) {
        sha = j.sha
        at = j.commit?.committer?.date ?? null
      }
    }
  } catch {
    // past GitHub's 60 lookups an hour: main itself, as wedgie.dev does
  }
  const base = `https://raw.githubusercontent.com/${REPO}/${sha}/`
  const read = async (name: string) => {
    const r = await get(base + name, sha === 'main' ? { cache: 'no-cache' } : undefined)
    if (!r.ok) throw new Error(`${REPO}: ${name} isn't there (${r.status})`)
    return new Uint8Array(await r.arrayBuffer())
  }
  let j: { apps?: AppJson[] }
  try {
    j = JSON.parse(new TextDecoder().decode(await read('wedgie.json')))
  } catch (e) {
    throw new Error(e instanceof SyntaxError ? `${REPO}'s wedgie.json isn't valid JSON` : String(e instanceof Error ? e.message : e))
  }
  const a = (Array.isArray(j.apps) ? j.apps : []).find((x) => x && x.mod === MOD)
  if (!a) throw new Error(`${REPO}'s wedgie.json has no ${MOD} app`)
  const bad = problems(a, shelf)
  if (bad.length) throw new Error(`${REPO}'s ${MOD} doesn't follow wedgie.dev's rules for an app: ${bad.join('; ')}`)
  const names = [...(a.files as string[])].sort()
  const data = new Map<string, Uint8Array>()
  const files: KnockApp['files'] = []
  for (const name of names) {
    const d = await read(name)
    data.set(name, d)
    files.push({ name, size: d.length, sha256: await sha256(d) })
  }
  const size = files.reduce((n, f) => n + f.size, 0)
  if (size > MAX_APP_BYTES) throw new Error(`${REPO}'s ${MOD} is ${Math.round(size / 1024)} KB; an app can be ${MAX_APP_BYTES / 1024} KB`)
  return {
    repo: REPO,
    sha,
    at,
    mod: MOD,
    name: a.name as string,
    about: typeof a.about === 'string' ? a.about : '',
    version: typeof a.version === 'string' ? a.version : null,
    entry: typeof a.entry === 'string' ? a.entry : null,
    usb: a.usb === true,
    fw: typeof a.fw === 'string' ? a.fw : null,
    chip: typeof a.chip === 'string' ? a.chip : null,
    files,
    data,
  }
}
