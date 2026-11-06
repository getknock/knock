/**
 * Knock onto a Wedgie (install.ts, repl.ts, knock-app.ts): the rules, then whole installs against a pretend Wedgie
 * (install.fake.py) that answers as wedgie firmware and runs the Console's Python in CPython, a folder its flash.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Restarted, cartV, entryFor, fit, installKnock, knockOf, lookAt, oldFiles, outdated, type Progress } from './install'
import { type KnockApp, type Shelf, latestKnock, problems } from './knock-app'
import { sha256 } from './repl'
import { Stopped } from './stopped'
import { Wedgie } from './wedgie'

const enc = (s: string) => new TextEncoder().encode(s)
const hex = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex')

// Knock 7, as getknock/wedgie might have it: a knock.py past one 1 KB piece, so a file goes in several
const FILES: Record<string, Uint8Array> = {
  'knock.py': enc(`FW = "knock-7"\n${'# the app\n'.repeat(300)}`),
  'knock_key.py': enc('def make(n):\n    return n\n'),
}
function appOf(files = FILES, version = '7'): KnockApp {
  const names = Object.keys(files).sort()
  return {
    repo: 'getknock/wedgie',
    sha: 'a'.repeat(40),
    at: '2026-11-06T04:35:54Z',
    mod: 'knock',
    name: 'Knock',
    about: 'Prove a human is here.',
    version,
    entry: 'run',
    usb: true,
    fw: '0.3.36',
    chip: 'OPTIGA Trust M',
    files: names.map((name) => ({ name, size: files[name].length, sha256: hex(files[name]) })),
    data: new Map(names.map((n) => [n, files[n]])),
  }
}
const SHELF: Shelf = {
  version: '0.3.77',
  core: ['boot.py', 'main.py', 'slot.mpy', 'wedgie.mpy', 'lcd.mpy'],
  carts: [
    { mod: 'safe', name: 'Safe Signer', files: ['safe.mpy', 'safe_ui.mpy', 'safe_icons.bin'] },
    { mod: 'frog', name: 'Frog', files: ['frog.mpy'] },
  ],
}

describe('the rules', () => {
  test("an app's version on the Wedgie is wedgie.py's cart_v", async () => {
    // hashlib.sha256("\n".join(["ab", "None"]).encode()).hexdigest()[:12]
    expect(await cartV(['ab', null])).toBe(hex(enc('ab\nNone')).slice(0, 12))
  })

  test("Knock's apps.json entry is the one wedgie.dev writes for an app from a repo", async () => {
    const a = appOf()
    expect(await entryFor(a)).toEqual({
      mod: 'knock',
      name: 'Knock',
      entry: 'run',
      usb: true,
      about: 'Prove a human is here.',
      v: await cartV(a.files.map((f) => f.sha256)),
      repo: 'getknock/wedgie',
      files: ['knock.py', 'knock_key.py'],
    })
  })

  test('which Knock runs, and whether the repo has a newer one', () => {
    expect(knockOf('knock-6')).toBe(6)
    expect(knockOf('knock-6x')).toBeNull()
    expect(knockOf(undefined)).toBeNull()
    expect(outdated('knock-6', appOf())).toBe(true)
    expect(outdated('knock-7', appOf())).toBe(false)
    expect(outdated('safe', appOf())).toBe(false)
  })

  test('a Wedgie Knock fits on, and the ones it does not', () => {
    const h = { type: 'hello', fw: 'wedgie-0.3.77', version: '0.3.77', chip: 'OPTIGA Trust M' }
    expect(fit(h, appOf())).toBeNull()
    expect(fit({ ...h, chip: null }, appOf())).toBeNull() // asked for later
    expect(fit({ ...h, version: '0.3.30' }, appOf())).toContain('0.3.36 or newer')
    expect(fit({ ...h, chip: 'ATECC608' }, appOf())).toContain('has an ATECC608')
    expect(fit({ ...h, chip: 'none' }, appOf())).toContain('no secure chip')
    expect(fit({ ...h, fw: 'usb-1' }, appOf())).toContain('USB to itself')
  })

  test("the old app's files: a shelf app's and the ones apps.json lists, never the firmware's, Knock's or saves", () => {
    const have = {
      hashes: {
        'safe.mpy': 'x',
        'safe.py': 'x', // a compiled file's old source goes too
        'safe_ui.mpy': 'x',
        'safe_icons.bin': null, // not there
        'frog.mpy': null,
        'knock.py': 'x',
        'main.py': 'x',
        'slot.mpy': 'x',
        'mine.py': 'x',
        'mine_more.py': 'x',
      },
      files: [],
      apps: [{ mod: 'mine', files: ['mine.py', 'mine_more.py', 'slot.mpy', '/saves/mine/x.json', '../up.py'] }],
    }
    expect(oldFiles(have, SHELF, appOf())).toEqual(['mine.py', 'mine_more.py', 'safe.mpy', 'safe.py', 'safe_ui.mpy'])
    // without the shelf: only apps.json's, and still no firmware module, whatever apps.json says
    expect(oldFiles(have, null, appOf())).toEqual(['mine.py', 'mine_more.py'])
  })

  test('what the Wedgie hashes: every shelf file, with sources for compiled ones, and Knock', () => {
    const names = lookAt(SHELF, appOf())
    expect(names).toContain('safe.py')
    expect(names).toContain('slot.py')
    expect(names).toContain('knock_key.py')
    expect(new Set(names).size).toBe(names.length)
  })

  test("wedgie.json's Knock, by wedgie.dev's rules for an app", () => {
    const ok = { mod: 'knock', name: 'Knock', files: ['knock.py', 'knock_key.py'], version: '6', fw: '0.3.36' }
    expect(problems(ok, SHELF)).toEqual([])
    expect(problems({ ...ok, mod: 'other' }, SHELF)[0]).toContain('not knock')
    expect(problems({ ...ok, files: ['knock.py', 'main.py'] }, SHELF).join()).toContain('main.py')
    expect(problems({ ...ok, files: ['knock.py', 'lcd.py'] }, null).join()).toContain('lcd.py: not named knock.py')
    expect(problems({ ...ok, files: ['knock.py', 'sub/knock_x.py'] }, SHELF).join()).toContain('plain file')
    expect(problems({ ...ok, files: ['knock_key.py'] }, SHELF).join()).toContain('no knock.py')
    expect(problems({ ...ok, name: 'A name far too long' }, SHELF).join()).toContain('name')
    expect(
      problems(ok, { ...SHELF, carts: [...SHELF.carts, { mod: 'knock', files: ['knock.py'], repo: 'someone/else' }] }).join(),
    ).toContain('another app')
  })
})

describe('reading Knock from getknock/wedgie', () => {
  const json = (v: unknown) => new Response(JSON.stringify(v))
  const wedgieJson = { apps: [{ mod: 'knock', name: 'Knock', about: 'x', files: ['knock_key.py', 'knock.py'], version: '7', entry: 'run', usb: true, fw: '0.3.36', chip: 'OPTIGA Trust M' }] }

  function github(over: Record<string, Response | (() => Response)> = {}): [typeof fetch, string[]] {
    const asked: string[] = []
    const get = (async (url: string | URL | Request) => {
      const u = String(url)
      asked.push(u)
      const o = over[u]
      if (o) return typeof o === 'function' ? o() : o
      if (u === 'https://api.github.com/repos/getknock/wedgie/commits/main')
        return json({ sha: 'b'.repeat(40), commit: { committer: { date: '2026-11-07T00:00:00Z' } } })
      const m = u.match(/^https:\/\/raw\.githubusercontent\.com\/getknock\/wedgie\/([^/]+)\/(.+)$/)
      if (m && m[2] === 'wedgie.json') return json(wedgieJson)
      if (m && FILES[m[2]]) return new Response(FILES[m[2]].slice())
      return new Response('', { status: 404 })
    }) as typeof fetch
    return [get, asked]
  }

  test('every file from the one commit main is at', async () => {
    const [get, asked] = github()
    const a = await latestKnock(SHELF, get)
    expect(a.sha).toBe('b'.repeat(40))
    expect(a.version).toBe('7')
    expect(a.files.map((f) => f.name)).toEqual(['knock.py', 'knock_key.py'])
    expect(a.files[0].sha256).toBe(hex(FILES['knock.py']))
    expect(asked.filter((u) => u.includes('raw.githubusercontent')).every((u) => u.includes(`/${'b'.repeat(40)}/`))).toBe(true)
  })

  test("past GitHub's lookups an hour, main itself", async () => {
    const [get, asked] = github({ 'https://api.github.com/repos/getknock/wedgie/commits/main': new Response('', { status: 403 }) })
    const a = await latestKnock(SHELF, get)
    expect(a.sha).toBe('main')
    expect(asked.some((u) => u.endsWith('/main/knock.py'))).toBe(true)
  })

  test('a wedgie.json against the rules, or a missing file, installs nothing', async () => {
    const bad = { apps: [{ ...wedgieJson.apps[0], files: ['knock.py', 'main.py'] }] }
    const [get] = github({ [`https://raw.githubusercontent.com/getknock/wedgie/${'b'.repeat(40)}/wedgie.json`]: () => json(bad) })
    await expect(latestKnock(SHELF, get)).rejects.toThrow('main.py')
    const [gone] = github({ [`https://raw.githubusercontent.com/getknock/wedgie/${'b'.repeat(40)}/knock_key.py`]: () => new Response('', { status: 404 }) })
    await expect(latestKnock(SHELF, gone)).rejects.toThrow("knock_key.py isn't there")
  })
})

describe('installing on a Wedgie', () => {
  const dirs: string[] = []
  const procs: { kill(): void }[] = []
  afterEach(() => {
    for (const p of procs.splice(0)) p.kill()
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** A pretend Wedgie with Safe Signer on it, its saves, and the firmware's own files */
  async function wedgie(...opts: string[]): Promise<{ w: Wedgie; flash: string; screen: () => string }> {
    const top = mkdtempSync(join(tmpdir(), 'knock-install-'))
    dirs.push(top)
    const flash = join(top, 'flash')
    mkdirSync(join(flash, 'saves', 'safe'), { recursive: true })
    for (const n of ['boot.py', 'main.py', 'slot.mpy', 'safe.mpy', 'safe_ui.mpy']) writeFileSync(join(flash, n), `# ${n}\n`)
    writeFileSync(join(flash, 'saves', 'safe', 'signer.json'), '{"keep": true}')
    writeFileSync(join(flash, 'apps.json'), JSON.stringify([{ mod: 'safe', name: 'Safe Signer', v: 'x', usb: true }]))
    const p = Bun.spawn(['python3', '-I', join(import.meta.dir, 'install.fake.py'), flash, ...opts], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
    })
    procs.push(p)
    const port = {
      getInfo: () => ({ usbVendorId: 0x2e8a }),
      open: async () => {},
      close: async () => {},
      readable: p.stdout,
      writable: new WritableStream<Uint8Array>({
        write(chunk) {
          p.stdin.write(chunk)
          p.stdin.flush()
        },
      }),
    }
    const g = globalThis as { navigator?: object }
    g.navigator ??= {}
    Object.defineProperty(g.navigator, 'serial', { value: { getPorts: async () => [port] }, configurable: true })
    const w = (await Wedgie.known()) as Wedgie
    return { w, flash, screen: () => (existsSync(`${flash}.screen`) ? readFileSync(`${flash}.screen`, 'utf8') : '') }
  }

  const files = (flash: string) => readdirSync(flash).sort()

  test('Knock goes on, Safe Signer comes off, saves stay, and the real reset takes the port', async () => {
    const { w, flash, screen } = await wedgie()
    const steps: Progress['step'][] = []
    const a = appOf()
    const outcome = await installKnock(w, a, SHELF, (p) => steps.push(p.step))
    expect(outcome).toBe('gone')
    expect(steps).toEqual(['checking', 'asking', 'writing', 'writing', 'tidying', 'restarting'])
    expect(files(flash)).toEqual(['apps.json', 'boot.py', 'knock.py', 'knock_key.py', 'main.py', 'saves', 'slot.mpy'])
    for (const f of a.files) expect(hex(new Uint8Array(readFileSync(join(flash, f.name))))).toBe(f.sha256)
    expect(JSON.parse(readFileSync(join(flash, 'apps.json'), 'utf8'))).toEqual([await entryFor(a)])
    expect(readFileSync(join(flash, 'saves', 'safe', 'signer.json'), 'utf8')).toBe('{"keep": true}')
    expect(screen()).toContain('FULL CONTROL? (Install Knock)')
    expect(screen()).toContain('Installing Knock')
    expect(w.connected).toBe(false)
  }, 30_000)

  test('an update keeps the port when its restart does, and Knock answers', async () => {
    const { w, flash } = await wedgie('stay')
    writeFileSync(join(flash, 'knock.py'), 'FW = "knock-6"\n')
    writeFileSync(join(flash, 'apps.json'), JSON.stringify([{ mod: 'knock', name: 'Knock', repo: 'getknock/wedgie', files: ['knock.py'] }]))
    const steps: Progress['step'][] = []
    expect(await installKnock(w, appOf(), SHELF, (p) => steps.push(p.step))).toBe('answered')
    expect(steps.filter((s) => s === 'tidying')).toEqual(['tidying']) // Safe Signer's files, still there from before
    const h = await w.ask({ type: 'hello' })
    expect(h.running).toBe('knock')
    expect(h.app).toBe('knock-7')
    await w.close()
  }, 30_000)

  test('with no room for both, the old app comes off first', async () => {
    const { w, flash } = await wedgie('full', 'stay')
    const steps: Progress['step'][] = []
    expect(await installKnock(w, appOf(), SHELF, (p) => steps.push(p.step))).toBe('answered')
    expect(steps).toEqual(['checking', 'asking', 'tidying', 'writing', 'writing', 'restarting'])
    expect(files(flash)).not.toContain('safe.mpy')
    await w.close()
  }, 30_000)

  test('a file that copies wrong stops it, and the app it had still runs', async () => {
    const { w, flash } = await wedgie('corrupt', 'stay')
    const err = await installKnock(w, appOf(), SHELF, () => {}).catch((e) => e)
    expect(err).toBeInstanceOf(Restarted)
    expect(err.message).toContain("didn't copy cleanly")
    expect(err.message).toContain('keeps the app it had')
    expect(err.message).not.toContain('Unplug')
    expect(err.gone).toBe(false)
    expect(JSON.parse(readFileSync(join(flash, 'apps.json'), 'utf8'))[0].mod).toBe('safe')
    expect(files(flash)).toContain('safe.mpy')
    expect(files(flash)).not.toContain('knock.py')
    expect((await w.ask({ type: 'hello' })).open).toBe(false) // restarted: locked again
    await w.close()
  }, 30_000)

  test('a stop after the old app came off for room says so, and the restart takes the port', async () => {
    const { w } = await wedgie('corrupt', 'full')
    const err = await installKnock(w, appOf(), SHELF, () => {}).catch((e) => e)
    expect(err).toBeInstanceOf(Restarted)
    expect(err.message).toContain('had come off first')
    expect(err.gone).toBe(true)
  }, 30_000)

  test('with no raw REPL after the yes, it says to unplug the Wedgie', async () => {
    const { w, flash } = await wedgie('noraw', 'stay')
    const before = files(flash)
    const err = await installKnock(w, appOf(), SHELF, () => {}).catch((e) => e)
    expect(err).toBeInstanceOf(Restarted)
    expect(err.message).toContain('stopped answering')
    expect(err.message).toContain('Unplug it')
    expect(files(flash)).toEqual(before)
    await w.close()
  }, 30_000)

  test('red on FULL CONTROL? changes nothing', async () => {
    const { w, flash } = await wedgie('refuse')
    const before = files(flash)
    const err = await installKnock(w, appOf(), SHELF, () => {}).catch((e) => e)
    expect(err).toBeInstanceOf(Stopped)
    expect(err.message).toContain('No green press')
    expect(files(flash)).toEqual(before)
    await w.close()
  }, 30_000)

  test("a Wedgie that said no before says so, and doesn't ask", async () => {
    const { w } = await wedgie('saidno')
    await expect(installKnock(w, appOf(), SHELF, () => {})).rejects.toThrow('Unplug it')
    await Bun.sleep(300)
    await w.close()
  }, 30_000)

  test("old firmware, or another chip, is turned away before it's asked", async () => {
    for (const opt of ['old', 'atecc']) {
      const { w, screen } = await wedgie(opt, opt === 'atecc' ? 'chipless' : 'stay')
      const steps: Progress['step'][] = []
      const err = await installKnock(w, appOf(), SHELF, (p) => steps.push(p.step)).catch((e) => e)
      expect(err).toBeInstanceOf(Stopped)
      expect(err.message).toContain(opt === 'old' ? 'wedgie firmware 0.3.36' : 'ATECC608')
      expect(steps).toEqual(['checking'])
      expect(screen()).not.toContain('FULL CONTROL?')
      await w.close()
    }
  }, 30_000)

  test("a newer Knock than the repo's isn't replaced", async () => {
    const { w } = await wedgie('stay')
    const older = appOf(FILES, '5')
    const knock6 = { 'knock.py': enc('FW = "knock-6"\n') }
    // Knock 6 on it first, from a repo with Knock 6
    await installKnock(w, appOf(knock6, '6'), SHELF, () => {})
    await expect(installKnock(w, older, SHELF, () => {})).rejects.toThrow('newer than the Knock 5')
    await Bun.sleep(300)
    await w.close()
  }, 30_000)
})

test('sha256 here is the Wedgie\'s', async () => {
  expect(await sha256(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})
