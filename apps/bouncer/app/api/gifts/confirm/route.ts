import { type NextRequest, NextResponse } from 'next/server'
import { Declined, takeGift } from '../../../../lib/club'
import { db, ours, seenTx } from '../../../../lib/server'

/** A gift's transaction, from the giver's wallet: the club reads it on mainnet before the gift counts */
export async function POST(req: NextRequest) {
  if (!ours(req)) return NextResponse.json({ ok: false, why: 'Give from the club’s own pages.' }, { status: 403 })
  const o = await req.json().catch(() => null)
  const ref = typeof o?.ref === 'string' && /^[0-9a-f]{32}$/.test(o.ref) ? o.ref : null
  const tx = typeof o?.tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(o.tx) ? (o.tx as `0x${string}`) : null
  if (!ref || !tx) return NextResponse.json({ ok: false, why: 'That isn’t a gift and its transaction.' }, { status: 400 })
  try {
    const seen = await seenTx(tx)
    return NextResponse.json({ ok: true, ...(await takeGift(await db(), ref, tx, seen, Date.now())) })
  } catch (e) {
    if (e instanceof Declined) return NextResponse.json({ ok: false, error: e.error, why: e.message }, { status: 409 })
    return NextResponse.json({ ok: false, error: 'chain', why: 'The club couldn’t read mainnet just now. Your gift went through if your wallet says so; try again to count it.' }, { status: 503 })
  }
}
