import { Refusal } from '@knock-dev/verify'
import { type NextRequest, NextResponse } from 'next/server'
import { toHex } from 'viem'
import { type Actor, SESSION_MS, apply, byProof, endSession, holdStep, startSession, takeStep } from '../../../../lib/club'
import { COOKIE, WALLET_COOKIE, db, ours, reads } from '../../../../lib/server'
import {
  type SessionId,
  bindWallet,
  checkBound,
  nonceOf,
  proveSession,
  readFirstProof,
  readSessionProof,
  signBinding,
} from '../../../../lib/world'

// A first proof waits for knockd's binding on World Chain: seconds, as a rule
export const maxDuration = 60

/** A refusal, numbered as the club's World ID checks are, and whether the same proof can be sent again */
const bounced = (b: Refusal, again = false) =>
  NextResponse.json({ ok: false, check: b.check, error: b.error, why: b.why, again }, { status: b.status })

/**
 * World App's proof for an act (D35), checked, then the act. A proof of a Knock session: KnockBinding has the
 * session, and World ID's verifier holds the proof, for the club's challenge. A first proof: knockd binds the club's
 * key for the visitor's wallet with it, and the club reads the binding on World Chain before it drops the key.
 * Either way the human is their nullifier for Knock's action, the one their Wedgie carries.
 */
export async function POST(req: NextRequest) {
  if (!ours(req)) return NextResponse.json({ ok: false, check: 0, error: 'origin', why: 'Come in from the club’s own pages.' }, { status: 403 })
  const body = await req.json().catch(() => null)
  const d = await db()
  const now = Date.now()
  const nonce = nonceOf(body?.result)
  const held = nonce ? await takeStep(d, nonce, ['prove', 'enroll'], now) : null
  try {
    if (!held) throw new Refusal(2, 'bad_challenge', 'The club didn’t ask for this proof, or it was used, or it’s too old. Try again.')
    let actor: Actor
    let session: string
    if (held.step === 'prove') {
      const p = readSessionProof(body.result, held.session as SessionId, held.challenge) // 1–3
      actor = byProof(await proveSession(reads, p), held.name, toHex(p.sessionNullifier[0], { size: 32 })) // 3, 4
      session = held.session
    } else {
      const p = readFirstProof(body.result, held.action, held.signal) // 1–3
      const tx = await bindWallet(p, held.node, held.key, signBinding(held.secret, held.key, p.nullifier, p.expiresAtMin))
      await checkBound(reads, tx, { nullifier: p.nullifier, key: held.key, node: held.node }) // 4
      actor = byProof(p.nullifier, held.name, tx)
      session = p.session
    }
    // A fundraiser's gifts go to the wallet its starter came in with
    const out = await apply(d, held.intent, actor, now, held.intent.act === 'raise' ? held.wallet : null) // 5, 8, and the act
    const res = NextResponse.json(
      out.ok
        ? { ok: true, name: actor.name, done: out.done }
        : { ok: false, passed: true, check: 0, error: out.declined.error, why: out.declined.message, name: actor.name },
    )
    await endSession(d, req.cookies.get(COOKIE)?.value)
    res.cookies.set(COOKIE, await startSession(d, actor.nullifier, now, { wallet: held.wallet, session }), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.nextUrl.protocol === 'https:',
      path: '/',
      maxAge: SESSION_MS / 1000,
    })
    res.cookies.delete(WALLET_COOKIE)
    return res
  } catch (e) {
    if (!(e instanceof Refusal)) throw e
    // knockd or a chain didn't answer, and the proof is still good: the club holds it again for another try
    const again = Boolean(held && nonce && e.error === 'unavailable')
    if (again && held && nonce) await holdStep(d, nonce, held, now)
    return bounced(e, again)
  }
}
