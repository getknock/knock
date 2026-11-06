import { randomBytes } from 'node:crypto'
import { Refusal } from '@knock-dev/verify'
import { type NextRequest, NextResponse } from 'next/server'
import { type Address, type Hex, getAddress, toHex } from 'viem'
import { Declined, HOLD_MS, before, hashOf, holdStep, readStep, takeStep } from '../../../../lib/club'
import { readIntent } from '../../../../lib/intent'
import { WALLET_COOKIE, db, me, nameOfWallet, ours, signedBy } from '../../../../lib/server'
import {
  ACTION,
  KnockdSaid,
  type SessionId,
  WORLD_ENV,
  contextFor,
  enrollmentKey,
  nodeOf,
  sessionFor,
  signInNonce,
  walletNode,
} from '../../../../lib/world'

/**
 * A World ID request for one act (D35), for World App to prove. First the visitor's wallet: signed in just now, a
 * moment ago (its cookie), or the one their World ID session came in with. Then their Knock session: that one, one
 * found by a Wedgie's name or a wallet they give, the one of the human they knocked in as, or their wallet's own.
 * With a session, World App proves it, for the club's challenge. With none, or when a visitor says they're new
 * (fresh), World App's first proof for Knock's action starts one, and binds a key the club makes for the wallet.
 * Anyone can have Knock bind for a wallet's name, so a session found by it may be someone else's; a binding of the
 * wallet's own owner, made after, takes the name back.
 */
export async function POST(req: NextRequest) {
  let token: string | null = null
  const answer = (json: object, status = 200) => {
    const res = NextResponse.json(json, { status })
    // A wallet that signed in stays signed in for another try, whatever came of this one
    if (token)
      res.cookies.set(WALLET_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: req.nextUrl.protocol === 'https:',
        path: '/',
        maxAge: HOLD_MS / 1000,
      })
    return res
  }
  const no = (status: number, error: string, why: string) => answer({ ok: false, error, why }, status)

  if (!ours(req)) return no(403, 'origin', 'Come in from the club’s own pages.')
  const body = await req.json().catch(() => null)
  const intent = readIntent(body?.intent)
  if ('why' in intent) return no(400, 'bad_act', intent.why)
  const d = await db()
  const now = Date.now()
  const who = await me()
  const cameWith = who?.wallet && who.world ? { wallet: getAddress(who.wallet), session: who.world as SessionId } : null

  let wallet: Address | null = null
  let name = ''
  if (body?.signIn) {
    const { message, signature } = body.signIn as { message?: unknown; signature?: unknown }
    const nonce = signInNonce(message)
    const held = nonce ? await takeStep(d, nonce, 'wallet', now) : null
    if (!held || held.message !== message) return no(401, 'bad_sign_in', 'The club didn’t ask for this sign-in, or it’s too old. Sign in again.')
    if (typeof signature !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){1,10000}$/.test(signature) || !(await signedBy(held.address, held.message, signature as Hex)))
      return no(401, 'bad_sign_in', 'The wallet’s signature doesn’t hold for this sign-in.')
    wallet = held.address
    name = await nameOfWallet(wallet)
    token = randomBytes(32).toString('base64url')
    await holdStep(d, hashOf(token), { step: 'signed', wallet, name }, now)
  } else {
    const jar = req.cookies.get(WALLET_COOKIE)?.value
    const signed = jar ? await readStep(d, hashOf(jar), 'signed', now) : null
    if (jar && signed) {
      ;({ wallet, name } = signed)
      token = jar
      await holdStep(d, hashOf(jar), signed, now)
    } else if (cameWith && who) {
      wallet = cameWith.wallet
      name = who.name
    }
  }
  if (!wallet) return no(401, 'no_wallet', 'Sign in with a wallet first.')

  try {
    await before(d, intent, who?.nullifier ?? null)
  } catch (e) {
    if (e instanceof Declined) return no(409, e.error, e.message)
    throw e
  }

  const find = typeof body?.find === 'string' ? body.find.trim().slice(0, 300) : ''
  let byWallet = false
  try {
    let session: SessionId | null
    if (find) {
      const node = nodeOf(find)
      if (!node) return no(400, 'bad_name', 'Give the ENS name of a Wedgie you’ve bound, or a wallet you’ve come in with.')
      session = await sessionFor({ node })
      if (!session) return no(404, 'no_session', `Knock has no human for ${find}.`)
    } else if (cameWith && cameWith.wallet === wallet) session = cameWith.session
    else if (who) session = await sessionFor({ nullifier: who.nullifier as Hex })
    else if (body?.fresh === true) session = null
    else {
      session = await sessionFor({ node: walletNode(wallet) })
      byWallet = session !== null
    }

    if (session) {
      const c = await contextFor(true)
      const challenge = toHex(randomBytes(32))
      await holdStep(d, c.rp_context.nonce, { step: 'prove', intent, wallet, name, session, challenge }, now)
      return answer({ ok: true, kind: 'prove', name, app_id: c.app_id, rp_context: c.rp_context, environment: WORLD_ENV, session, signal: challenge, byWallet })
    }
    const c = await contextFor(false)
    const node = walletNode(wallet)
    const k = enrollmentKey(node)
    await holdStep(d, c.rp_context.nonce, { step: 'enroll', intent, wallet, name, action: ACTION, node, ...k }, now)
    return answer({ ok: true, kind: 'enroll', name, app_id: c.app_id, rp_context: c.rp_context, environment: WORLD_ENV, action: ACTION, signal: k.signal })
  } catch (e) {
    if (e instanceof Refusal) return no(e.status, e.error, e.why)
    if (e instanceof KnockdSaid) return no(502, e.error, `knockd, Knock’s server, said no: ${e.message}`)
    throw e
  }
}
