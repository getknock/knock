import { randomBytes } from 'node:crypto'
import { type NextRequest, NextResponse } from 'next/server'
import { Declined, before, hold } from '../../../../lib/club'
import { readIntent } from '../../../../lib/intent'
import { db, me, ours } from '../../../../lib/server'

/** A challenge for one act: the club checks the act, then holds it for the knock that answers the challenge */
export async function POST(req: NextRequest) {
  if (!ours(req)) return NextResponse.json({ ok: false, error: 'origin', why: 'Knock from the club’s own pages.' }, { status: 403 })
  const body = await req.json().catch(() => null)
  const intent = readIntent(body?.intent)
  if ('why' in intent) return NextResponse.json({ ok: false, error: 'bad_act', why: intent.why }, { status: 400 })
  const d = await db()
  try {
    await before(d, intent, (await me())?.nullifier ?? null)
  } catch (e) {
    if (e instanceof Declined) return NextResponse.json({ ok: false, error: e.error, why: e.message }, { status: 409 })
    throw e
  }
  const challenge = `0x${randomBytes(32).toString('hex')}`
  await hold(d, challenge, intent, Date.now())
  return NextResponse.json({ ok: true, challenge })
}
