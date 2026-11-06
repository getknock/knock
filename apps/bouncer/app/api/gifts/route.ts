import { type NextRequest, NextResponse } from 'next/server'
import { Declined, askGift } from '../../../lib/club'
import { GIFT, ethOf, field } from '../../../lib/intent'
import { db, me, ours } from '../../../lib/server'

/** A gift about to be given: the club gives it a reference, in the amount's last wei, and says where it goes */
export async function POST(req: NextRequest) {
  if (!ours(req)) return NextResponse.json({ ok: false, why: 'Give from the club’s own pages.' }, { status: 403 })
  const o = await req.json().catch(() => null)
  const fundraiser = Number.isSafeInteger(o?.fundraiser) && o.fundraiser > 0 ? (o.fundraiser as number) : null
  if (!fundraiser) return NextResponse.json({ ok: false, why: 'No such fundraiser.' }, { status: 400 })
  const amount = ethOf(o?.amount, GIFT, 'A gift')
  if (typeof amount !== 'bigint') return NextResponse.json({ ok: false, why: amount.why }, { status: 400 })
  const message = field(o?.message, 'message', 'Your message')
  if (typeof message !== 'string') return NextResponse.json({ ok: false, why: message.why }, { status: 400 })
  try {
    const human = (await me())?.nullifier ?? null
    const g = await askGift(await db(), fundraiser, amount, { human, message, showFrom: o?.showFrom === true }, Date.now())
    return NextResponse.json({ ok: true, ...g, chainId: 1, human: human !== null })
  } catch (e) {
    if (e instanceof Declined) return NextResponse.json({ ok: false, error: e.error, why: e.message }, { status: 409 })
    throw e
  }
}
