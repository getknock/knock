import { type NextRequest, NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { generateSiweNonce } from 'viem/siwe'
import { holdStep } from '../../../../lib/club'
import { db, originOf, ours } from '../../../../lib/server'
import { signInMessage } from '../../../../lib/world'

/** A sign-in for a wallet (D35): the message it's to sign, held under its nonce until the World ID request it starts */
export async function POST(req: NextRequest) {
  if (!ours(req)) return NextResponse.json({ ok: false, error: 'origin', why: 'Come in from the club’s own pages.' }, { status: 403 })
  const body = await req.json().catch(() => null)
  const a = body?.address
  if (typeof a !== 'string' || !isAddress(a, { strict: false }))
    return NextResponse.json({ ok: false, error: 'bad_wallet', why: 'That isn’t a wallet’s address.' }, { status: 400 })
  const address = getAddress(a)
  const nonce = generateSiweNonce()
  const now = Date.now()
  const message = signInMessage(originOf(req), address, nonce, now)
  await holdStep(await db(), nonce, { step: 'wallet', address, message }, now)
  return NextResponse.json({ ok: true, message })
}
