/**
 * MicroPython's raw REPL on a Wedgie, driven as wedgie.dev's own wedgie.py drives it: Ctrl-C stops its app, Ctrl-A
 * starts raw mode, code goes in 256-byte pieces and runs on Ctrl-D, and its output and its error come back, each
 * ended by a 0x04. A sealed Wedgie ignores Ctrl-C until its person says yes to FULL CONTROL on its screen (install.ts
 * asks). While this computer has it, the Wedgie's boot screen says what it's doing, with a bar (wedgie.py's busy).
 */
import type { Wedgie } from './wedgie'

const bytes = (s: string) => new TextEncoder().encode(s)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Python for a string or a list of strings: JSON's are Python's too, for the plain ASCII names used here */
const py = (v: string | string[]) => JSON.stringify(v)

/** The temp file a file is written to before it's checked and renamed into place (wedgie.py's put) */
const TMP = '_wedgie.tmp'

/** Each file's sha256, the root's files, and apps.json: wedgie.py's HASH_PY, with the names to hash */
const HASH_PY = `import os, json, hashlib, binascii
def _h(n):
    try:
        h = hashlib.sha256()
        with open(n, 'rb') as f:
            while True:
                b = f.read(1024)
                if not b: break
                h.update(b)
        return binascii.hexlify(h.digest()).decode()
    except OSError:
        return None
try:
    _a = json.load(open('apps.json'))
except Exception:
    _a = []
_n = %s
for _x in _a:
    _n += [f for f in _x.get('files', []) if isinstance(f, str)]
print(json.dumps({'hashes': {n: _h(n) for n in _n}, 'files': os.listdir(), 'apps': _a}))`

/** Every module but the screen's dropped, and every name, so the copy has the RAM: wedgie.py's FREE_PY */
const FREE_PY = `def _free():
    import gc, sys
    for n in list(sys.modules):
        if n not in ("lcd", "splash", "micropython") and n[0] != "_":
            del sys.modules[n]
    l = sys.modules.get("lcd")
    if l:
        del l._keys[:]
        l._on_show = None
    g = globals()
    for n in list(g):
        if not n.startswith("__"):
            del g[n]
    gc.collect()
_free()`

/** The boot screen and its bar, titled with what this computer does: wedgie.py's BUSY_PY, word for word */
const BUSY_PY = `_ld = None
try:
    import loader as _ld
except ImportError:
    pass
_bs = [None, None, None]
if _ld and hasattr(_ld, "screen"):
    def _ins(title, what, p):
        if _bs[0] != title:
            _bs[2] = None
            import gc
            gc.collect()
            _bs[0], _bs[1] = title, what
            _bs[2] = _ld.screen(title, what) or False
        elif _bs[1] != what:
            _bs[1] = what
            _ld.what(what)
        if _bs[2]:
            _bs[2].to(p)
else:
    import lcd as _L
    _d = _L.LCD()
    def _ins(title, what, p):
        W, I, M = _L.color(254, 254, 254), _L.color(26, 27, 26), _L.color(120, 123, 120)
        _d.fill(W)
        for y, c in ((10, _L.color(34, 196, 82)), (19, _L.color(169, 170, 171)), (28, _L.color(227, 49, 44))):
            _d.fill_rect(0, y, 240, 5, c)
        _d.center_text(title, 92, M, 2)
        _d.center_text(what[:28], 120, I)
        _d.rect(30, 160, 180, 14, _L.color(200, 200, 196))
        _d.fill_rect(32, 162, int(176 * p), 10, _L.color(34, 196, 82))
        _d.show()`

/** What the Wedgie has: sha256s (null: not there), its root's file names, its apps.json */
export type Have = { hashes: Record<string, string | null>; files: string[]; apps: Record<string, unknown>[] }

/** Python that raised: its last line */
export class ReplError extends Error {}

export async function sha256(data: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

function base64(data: Uint8Array): string {
  let s = ''
  for (const b of data) s += String.fromCharCode(b)
  return btoa(s)
}

export class Repl {
  private buf = new Uint8Array(0)
  private wake?: () => void
  private screen: { title: string; what: string; p: number; ok: boolean } | null = null

  private constructor(private w: Wedgie) {
    w.tap = (b) => {
      const next = new Uint8Array(this.buf.length + b.length)
      next.set(this.buf)
      next.set(b, this.buf.length)
      this.buf = next
      this.wake?.()
    }
  }

  /** Stop what it runs (Ctrl-C) and take its raw REPL. Its person said yes first, or Ctrl-C does nothing. */
  static async enter(w: Wedgie): Promise<Repl> {
    const r = new Repl(w)
    await w.send(bytes('\r\x03\x03'))
    await sleep(150)
    r.buf = new Uint8Array(0)
    await w.send(bytes('\x01'))
    try {
      await r.until('raw REPL; CTRL-B to exit\r\n>', 4000)
    } catch (e) {
      await r.leave().catch(() => {}) // no raw REPL: the same bytes restart it, which locks it again
      throw e
    }
    return r
  }

  /** What came before marker, once it's come; what came after it stays for the next read */
  private async until(marker: string, ms: number): Promise<Uint8Array> {
    const m = bytes(marker)
    const end = Date.now() + ms
    for (;;) {
      const at = find(this.buf, m)
      if (at >= 0) {
        const head = this.buf.slice(0, at)
        this.buf = this.buf.slice(at + m.length)
        return head
      }
      const left = end - Date.now()
      if (left <= 0) throw new Error(`the Wedgie stopped answering (waiting for ${JSON.stringify(marker)})`)
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left)
        this.wake = () => {
          clearTimeout(t)
          resolve()
        }
      })
      this.wake = undefined
    }
  }

  /** Run code; what it printed. A Python error throws its last line. */
  async exec(code: string, ms = 30_000): Promise<string> {
    const data = bytes(code)
    for (let i = 0; i < data.length; i += 256) {
      await this.w.send(data.subarray(i, i + 256))
      await sleep(5)
    }
    await this.w.send(bytes('\x04'))
    await this.until('OK', 5000)
    const out = new TextDecoder().decode(await this.until('\x04', ms))
    const err = new TextDecoder().decode(await this.until('\x04', 5000)).trim()
    if (err) throw new ReplError(err.split('\n').pop()?.trim() || err)
    return out
  }

  /** Its RAM back, as wedgie.py's take_over does: the app's modules stay loaded after Ctrl-C */
  async free() {
    await this.exec(FREE_PY).catch(() => {})
  }

  /** The boot screen, titled with what this computer is doing */
  async busy(title: string, what = '') {
    if (!this.screen) {
      const ok = await this.exec(BUSY_PY, 8000).then(
        () => true,
        () => false,
      )
      this.screen = { title, what, p: 0, ok }
    }
    Object.assign(this.screen, { title, what, p: 0 })
    await this.draw()
  }

  /** The bar (0..1, forward only) and the line under it; drawn when it moved a step */
  async progress(p: number, what?: string) {
    const s = this.screen
    if (!s) throw new Error("nothing on the Wedgie's screen says what's happening: busy() first")
    const w = what ?? s.what
    if (w === s.what && (p <= s.p || (p - s.p < 0.08 && p < 1))) return
    s.p = Math.max(s.p, p)
    s.what = w
    await this.draw()
  }

  private async draw() {
    const s = this.screen
    if (s?.ok) await this.exec(`_ins(${py(s.title)}, ${py(s.what.slice(0, 28))}, ${s.p.toFixed(2)})`, 8000).catch(() => {})
  }

  /** The sha256 of each of names (and of each file apps.json lists), its files, and its apps.json */
  async look(names: string[]): Promise<Have> {
    return JSON.parse(await this.exec(HASH_PY.replace('%s', () => py(names)), 60_000)) as Have
  }

  /** Bytes free on its flash */
  async room(): Promise<number> {
    return Number((await this.exec("import os\n_s = os.statvfs('/')\nprint(_s[0] * _s[3])")).trim())
  }

  /** A file in its root: written to a temp file, its sha256 checked there, then renamed into place. The bar goes
   *  span[0]..span[1]. */
  async put(name: string, data: Uint8Array, span: [number, number], what = name) {
    if (!/^[A-Za-z0-9_.]+$/.test(name)) throw new Error(`${name}: only a plain name in its root`)
    const [a, z] = span
    await this.progress(a, what)
    await this.exec(`import binascii, os, hashlib\n_f = open(${py(TMP)}, 'wb')`)
    for (let i = 0; i < data.length; i += 1024) {
      await this.exec(`_f.write(binascii.a2b_base64(${py(base64(data.subarray(i, i + 1024)))}))`)
      await this.progress(a + ((z - a) * Math.min(data.length, i + 1024)) / data.length, what)
    }
    await this.exec('_f.close()')
    const got = (
      await this.exec(
        `h = hashlib.sha256()\nwith open(${py(TMP)}, 'rb') as f:\n    while True:\n        b = f.read(1024)\n        if not b: break\n        h.update(b)\nprint(binascii.hexlify(h.digest()).decode())`,
      )
    ).trim()
    if (got !== (await sha256(data))) throw new Error(`${name} didn't copy cleanly onto the Wedgie`)
    await this.exec(`try:\n    os.remove(${py(name)})\nexcept OSError:\n    pass\nos.rename(${py(TMP)}, ${py(name)})`)
    await this.progress(z, what)
  }

  /** Files off its root, and their modules out of memory */
  async remove(names: string[]) {
    for (const n of names)
      await this.exec(
        `import os, sys\ntry:\n    os.remove(${py(n)})\nexcept OSError:\n    pass\nsys.modules.pop(${py(n.replace(/\.[^.]+$/, ''))}, None)`,
      )
  }

  async sync() {
    await this.exec('import os\ntry:\n    os.sync()\nexcept AttributeError:\n    pass')
  }

  /** Out of raw mode, then a soft reset: a fresh heap for its app, which starts again locked */
  async leave() {
    this.w.tap = undefined
    await this.w.send(bytes('\x02'))
    await sleep(50)
    await this.w.send(bytes('\x04'))
  }
}

function find(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
