'use client'
import { IDKit, type IDKitResult, proofOfHuman } from '@worldcoin/idkit-core'
import { useRouter } from 'next/navigation'
import encodeQR from 'qr'
import { useEffect, useRef, useState } from 'react'
import { type Hex, stringToHex } from 'viem'
import type { Answer } from '../lib/checks'
import type { Intent } from '../lib/intent'
import { Bouncer, Said } from './Knock'
import { useVisitor } from './Visitor'
import { type Injected, connect, discover, walletNo } from './wallet'

/**
 * The World ID way in (D35), for one act: a wallet signs in, then World App proves the visitor is the human Knock
 * knows, for the club's challenge. The first time, World App's proof for Knock's action starts their Knock session,
 * and knockd binds them for that wallet, as a Wedgie is bound. A visitor who came in this way signed in already, so
 * World App alone proves each act after that.
 */

type RpContext = { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string }

/** The club's World ID request for an act */
type Asked = { name: string; app_id: `app_${string}`; rp_context: RpContext; environment: 'production' | 'staging'; signal: string } & (
  /** byWallet: the session was found by the wallet's name, which anyone can have Knock bind for */
  | { kind: 'prove'; session: `session_${string}`; byWallet: boolean }
  | { kind: 'enroll'; action: string }
)

type Phase =
  | { at: 'idle' }
  | { at: 'wallets' }
  | { at: 'signing'; wallet: string }
  | { at: 'asking' }
  | { at: 'world'; asked: Asked; link: string; n: number; d: string }
  /** Their session, found by a name they give: after World App said it proved them for Knock before (replayed), or
   *  a name they gave that Knock didn't know */
  | { at: 'find'; replayed: boolean; why: string | null; tried: string }
  | { at: 'checking'; enroll: boolean }
  /** The club couldn't finish, and the same proof can go again */
  | { at: 'again'; result: IDKitResult; enroll: boolean; why: string }
  | { at: 'done' }

class ClubNo extends Error {
  constructor(
    readonly error: string,
    why: string,
  ) {
    super(why)
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => null)
  if (!r.ok || !j?.ok) throw new ClubNo(j?.error ?? 'club', j?.why ?? `The club said ${r.status}.`)
  return j as T
}

/** A QR code as one SVG path, a run of dark modules at a time */
function qrOf(text: string): { n: number; d: string } {
  const rows = encodeQR(text, 'raw', { ecc: 'medium', border: 2 })
  let d = ''
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!row[x]) continue
      let run = 1
      while (row[x + run]) run++
      d += `M${x} ${y}h${run}v1h-${run}z`
      x += run - 1
    }
  })
  return { n: rows.length, d }
}

const RP_TROUBLE = new Set([
  'invalid_rp_signature',
  'unknown_rp',
  'inactive_rp',
  'duplicate_nonce',
  'timestamp_too_old',
  'timestamp_too_far_in_future',
  'invalid_timestamp',
  'rp_signature_expired',
])

/** What World App's no means, in words a person can act on */
function worldSays(error: string, enroll: boolean, environment: string): string {
  if (error === 'credential_unavailable' || error === 'world_id_4_not_available')
    return "World App has no proof-of-human credential for you, and that's the one the club asks for."
  if (error === 'invalid_network')
    return `World App answers the other environment: the club proves humans in ${environment}, which ${environment === 'staging' ? "World ID's Simulator" : 'World App'} answers.`
  if (RP_TROUBLE.has(error)) return `World App turned down Knock's request (${error}). Try again.`
  if (error === 'timeout') return 'Nobody answered in World App in time. Try again for a new code.'
  return enroll ? `World ID: ${error}.` : `World ID: ${error}. If World App can't prove this Knock session, it may be someone else's.`
}

/** The World ID way for one act, as a hook: begin it, then pick a wallet, and World App does the rest */
export function useWorld() {
  const visitor = useVisitor()
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>({ at: 'idle' })
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [act, setAct] = useState<Intent['act']>('in')
  const [wallets, setWallets] = useState<Injected[]>([])
  const intent = useRef<Intent | null>(null)
  const then = useRef<((a: Answer) => void) | undefined>(undefined)
  const stop = useRef<AbortController | null>(null)
  const replayed = useRef(false)

  useEffect(
    () => discover((w) => setWallets((ws) => (ws.some((x) => x.info.uuid === w.info.uuid) ? ws : [...ws, w]))),
    [],
  )
  useEffect(() => () => stop.current?.abort(), [])

  function finish(a: Answer) {
    setAnswer(a)
    setPhase({ at: 'done' })
    then.current?.(a)
    router.refresh()
  }

  function begin(i: Intent, after?: (a: Answer) => void) {
    stop.current?.abort()
    intent.current = i
    then.current = after
    replayed.current = false
    setAct(i.act)
    setAnswer(null)
    if (visitor?.world) void ask({})
    else setPhase({ at: 'wallets' })
  }

  function cancel() {
    stop.current?.abort()
    setPhase({ at: 'idle' })
  }

  async function pick(w: Injected) {
    setAnswer(null)
    setPhase({ at: 'signing', wallet: w.info.name })
    try {
      const address = await connect(w)
      const { message } = await post<{ message: string }>('/api/world/wallet', { address })
      const signature = (await w.provider.request({ method: 'personal_sign', params: [stringToHex(message), address] })) as Hex
      await ask({ signIn: { message, signature } })
    } catch (e) {
      const why = e instanceof ClubNo ? e.message : walletNo(e)
      setPhase({ at: 'wallets' })
      if (why) setAnswer({ kind: 'no-knock', code: 'wallet', why })
    }
  }

  async function ask(extra: { signIn?: { message: string; signature: Hex }; find?: string; fresh?: boolean }) {
    const i = intent.current
    if (!i) return
    stop.current?.abort()
    const ctl = new AbortController()
    stop.current = ctl
    setPhase({ at: 'asking' })
    let asked: Asked
    try {
      asked = await post<Asked>('/api/world/ask', { intent: i, ...extra })
    } catch (e) {
      const no = e instanceof ClubNo ? e : new ClubNo('club', e instanceof Error ? e.message : String(e))
      if (no.error === 'no_wallet' || no.error === 'bad_sign_in') {
        setPhase({ at: 'wallets' })
        return setAnswer({ kind: 'no-knock', code: no.error, why: no.message })
      }
      if (extra.find) return setPhase({ at: 'find', replayed: replayed.current, why: no.message, tried: extra.find })
      return finish({ kind: 'no-knock', code: no.error, why: no.message })
    }
    try {
      const { app_id, rp_context, environment, signal } = asked
      const request =
        asked.kind === 'prove'
          ? await IDKit.proveSession(asked.session, { app_id, rp_context, environment }).constraints({ type: 'proof_of_human', signal })
          : await IDKit.request({ app_id, action: asked.action, session_id: 'create', rp_context, allow_legacy_proofs: false, environment }).preset(
              proofOfHuman({ signal }),
            )
      setPhase({ at: 'world', asked, link: request.connectorURI, ...qrOf(request.connectorURI) })
      const done = await request.pollUntilCompletion({ pollInterval: 2000, timeout: 300_000, signal: ctl.signal })
      if (ctl.signal.aborted) return
      if (done.success) return submit(done.result, asked.kind === 'enroll')
      if (asked.kind === 'enroll' && (done.error === 'max_verifications_reached' || done.error === 'nullifier_replayed')) {
        replayed.current = true
        return setPhase({ at: 'find', replayed: true, why: null, tried: '' })
      }
      if (done.error === 'user_rejected' || done.error === 'verification_rejected')
        return finish({ kind: 'no-knock', code: 'rejected', why: 'You said no in World App.' })
      finish({ kind: 'no-knock', code: done.error, why: worldSays(done.error, asked.kind === 'enroll', environment) })
    } catch (e) {
      if (!ctl.signal.aborted) finish({ kind: 'no-knock', code: 'world', why: e instanceof Error ? e.message : String(e) })
    }
  }

  async function submit(result: IDKitResult, enroll: boolean) {
    setPhase({ at: 'checking', enroll })
    const r = await fetch('/api/world/proof', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result }),
    }).catch(() => null)
    const j = r ? await r.json().catch(() => null) : null
    if (typeof j?.ok !== 'boolean')
      return setPhase({ at: 'again', result, enroll, why: r ? `The club said ${r.status}.` : "The club couldn't be reached." })
    if (j.ok) return finish({ kind: 'in', name: j.name, done: j.done })
    if (j.passed) return finish({ kind: 'declined', name: j.name, error: j.error, why: j.why })
    if (j.again) return setPhase({ at: 'again', result, enroll, why: j.why })
    if (j.check >= 1) return finish({ kind: 'bounced', check: j.check, error: j.error, why: j.why })
    finish({ kind: 'no-knock', code: j.error, why: j.why })
  }

  const busy = phase.at === 'signing' || phase.at === 'asking' || phase.at === 'world' || phase.at === 'checking'
  return { phase, answer, act, wallets, begin, cancel, pick, ask, submit, busy, open: phase.at !== 'idle' }
}

export type World = ReturnType<typeof useWorld>

/** A Wedgie's name, or a wallet that came in before: how a human Knock knows is found, when their wallet isn't bound */
function Find({ lead, why, tried = '', onFind }: { lead: string; why: string | null; tried?: string; onFind: (name: string) => void }) {
  const [name, setName] = useState(tried)
  const go = () => name.trim() && onFind(name.trim())
  return (
    <div className="find">
      <label>
        <span>{lead}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              go()
            }
          }}
          placeholder="wedgie.yourname.eth"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <button type="button" className="plain" onClick={go} disabled={!name.trim()}>
        Find me
      </button>
      {why ? (
        <p className="said out" role="alert">
          {why}
        </p>
      ) : null}
    </div>
  )
}

/** The World ID way, as an act shows it: a wallet to sign in with, World App's code, then the bouncer's list */
export function WorldWay({ w, list, round }: { w: World; list: boolean; round: number }) {
  const p = w.phase
  return (
    <div className="world">
      {p.at === 'wallets' ? (
        <div className="wallets">
          <p className="hint">
            Sign in with your wallet first. It names you at the club, by its ENS name or its address, and takes your
            fundraisers' gifts. Signing in costs nothing and sends nothing.
          </p>
          {w.wallets.length ? (
            w.wallets.map((x) => (
              <button key={x.info.uuid} type="button" className="plain wallet" onClick={() => w.pick(x)}>
                <img src={x.info.icon} alt="" width={22} height={22} /> Sign in with {x.info.name}
              </button>
            ))
          ) : (
            <p className="hint">
              No wallet here. Signing in needs a wallet in this browser that announces itself (EIP-6963), such as
              MetaMask or Rabby.
            </p>
          )}
        </div>
      ) : null}
      {p.at === 'signing' ? (
        <p className="said" role="status">
          Sign the club's message in {p.wallet}.
        </p>
      ) : null}
      {p.at === 'asking' ? (
        <p className="said" role="status">
          Asking Knock for a World ID request…
        </p>
      ) : null}
      {p.at === 'world' ? (
        <div className="scan">
          <svg viewBox={`0 0 ${p.n} ${p.n}`} role="img" aria-label="A code for World App to scan" shapeRendering="crispEdges">
            <rect width={p.n} height={p.n} fill="#fff" />
            <path d={p.d} fill="#000" />
          </svg>
          <div className="scan-say">
            <p>
              <strong>Scan it with {p.asked.environment === 'staging' ? "World ID's Simulator" : 'World App'}.</strong>{' '}
              {p.asked.kind === 'enroll'
                ? "It proves you're a unique human. Then Knock binds this wallet to you on World Chain, the way it binds a Wedgie, so the club counts you once."
                : `It proves you're the human Knock knows, for this one act, as ${p.asked.name}.`}
            </p>
            <a className="plain" href={p.link}>
              On this phone? Open World App
            </a>
            {p.asked.kind === 'enroll' ? (
              <Find lead="Bound a Wedgie before? Give its name instead." why={null} onFind={(find) => w.ask({ find })} />
            ) : null}
            {p.asked.kind === 'prove' && p.asked.byWallet ? (
              <button type="button" className="text-btn" onClick={() => w.ask({ fresh: true })}>
                Not you? You're new to Knock
              </button>
            ) : null}
            <button type="button" className="text-btn" onClick={w.cancel}>
              Stop
            </button>
          </div>
        </div>
      ) : null}
      {p.at === 'find' ? (
        <div className="said">
          <p>
            {p.replayed ? 'World App has proved you for Knock before, so Knock knows you already. ' : ''}Give the name of
            a Wedgie you've bound, or a wallet you've come in with, and prove it's you.
          </p>
          <Find lead="Its name, or the wallet's address" why={p.why} tried={p.tried} onFind={(find) => w.ask({ find })} />
          {p.replayed ? null : (
            <button type="button" className="text-btn" onClick={() => w.ask({ fresh: true })}>
              I'm new to Knock
            </button>
          )}
        </div>
      ) : null}
      {p.at === 'checking' ? (
        <p className="said" role="status">
          {p.enroll ? 'Knock is binding you on World Chain. It takes up to a minute…' : 'The bouncer is checking your proof…'}
        </p>
      ) : null}
      {p.at === 'again' ? (
        <div className="said out" role="status">
          <p>{p.why} Your proof is still good.</p>
          <button type="button" className="plain" onClick={() => w.submit(p.result, p.enroll)}>
            Send it again
          </button>
        </div>
      ) : null}
      {list && (p.at === 'checking' || p.at === 'done') ? <Bouncer answer={w.answer} act={w.act} round={round} door="world" /> : null}
      <Said answer={w.answer} />
    </div>
  )
}
