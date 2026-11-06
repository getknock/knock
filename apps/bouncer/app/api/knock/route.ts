import { type NextRequest, NextResponse } from 'next/server'
import { SESSION_MS, apply, endSession, startSession, take } from '../../../lib/club'
import { type Assertion, Refusal, check, parse } from '@knock-dev/verify'
import { COOKIE, db, originOf, ours, site, walletOf } from '../../../lib/server'

/** A refusal, with the HTTP status knock-verifier would give it */
const bounced = (b: Refusal) => NextResponse.json({ ok: false, check: b.check, error: b.error, why: b.why }, { status: b.status })

/** A knock, for the act its challenge was issued for: the club's verifier checks it, then the club does the act */
export async function POST(req: NextRequest) {
  if (!ours(req)) return NextResponse.json({ ok: false, check: 0, error: 'origin', why: 'Knock from the club’s own pages.' }, { status: 403 })
  const body = await req.json().catch(() => null)
  try {
    const a: Assertion = parse(body?.assertion) // V1
    const now = Date.now()
    const d = await db()
    const intent = await take(d, a.challenge, now) // V2
    if (!intent)
      throw new Refusal(2, 'bad_challenge', 'The club didn’t issue this knock’s challenge, or it was used or is too old. Knock again.')
    const k = await check(site(originOf(req), d), a, now) // V3–V7
    // A fundraiser's gifts go to the wallet its starter's Wedgie name resolves to, read now
    const out = await apply(d, intent, k, now, intent.act === 'raise' ? await walletOf(k.name) : null) // V8, and the act
    // In: one human, bound on World Chain. The act is done, or declined, and either way they're in.
    const res = NextResponse.json(
      out.ok
        ? { ok: true, name: k.name, done: out.done }
        : { ok: false, passed: true, check: 0, error: out.declined.error, why: out.declined.message, name: k.name },
    )
    await endSession(d, req.cookies.get(COOKIE)?.value)
    res.cookies.set(COOKIE, await startSession(d, k.nullifier, now), {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.nextUrl.protocol === 'https:',
      path: '/',
      maxAge: SESSION_MS / 1000,
    })
    return res
  } catch (e) {
    if (e instanceof Refusal) return bounced(e)
    throw e
  }
}
