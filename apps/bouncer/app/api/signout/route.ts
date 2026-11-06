import { type NextRequest, NextResponse } from 'next/server'
import { endSession } from '../../../lib/club'
import { COOKIE, db, ours } from '../../../lib/server'

export async function POST(req: NextRequest) {
  if (!ours(req)) return NextResponse.json({ ok: false }, { status: 403 })
  await endSession(await db(), req.cookies.get(COOKIE)?.value)
  const res = NextResponse.json({ ok: true })
  res.cookies.delete(COOKIE)
  return res
}
