/**
 * Naming a bound Wedgie in ENS, in the user's order (D21): the binding first, read back from World Chain by
 * knockd, since the name's records point at it; then BECOME on the Wedgie; then the user's wallet writes the
 * records and the name; then ENS is read back as any verifier would; then the Wedgie is told.
 *
 * And the kill switch (D20): the wallet unregisters the name and unlinks its records, ENS is read back, and the
 * Wedgie forgets its name and binding. The Bound log stays in World Chain's history, but nothing points at it.
 */
import { deviceNode, keyHash, uncompressKey } from '@knock-dev/protocol'
import { type Hex, type PublicClient, isAddressEqual } from 'viem'
import type { Device } from './device'
import { become, confirmOn, forgetOn } from './device'
import { type Records, type Tx, killTxs, namingTxs, readName, recordTexts } from './ens'
import { boundTx } from './knockd'
import { Stopped } from './stopped'
import { type Connected, send, sendBatch } from './wallet'
import type { Wedgie } from './wedgie'

/** The wallet's part: every call as one transaction (batch), or one transaction each (tx). */
export type WalletStep = { step: 'batch'; txs: Tx[] } | { step: 'tx'; tx: Tx; i: number; n: number }

export type NameStep =
  | { step: 'binding' }
  | { step: 'plan'; txs: Tx[] }
  | { step: 'device' }
  | WalletStep
  | { step: 'check' }
  | { step: 'confirm' }

/** A transaction the wallet sent, and the calls in it: one, or a batch's every call (D25). */
export type Sent = { txs: Tx[]; hash: Hex; gasUsed: bigint }

/** The calls, as one atomic transaction when the wallet can (D25), else one at a time, in order. */
async function sendAll(c: Connected, txs: Tx[], on: (s: WalletStep) => void): Promise<Sent[]> {
  if (c.batch && txs.length > 1) {
    on({ step: 'batch', txs })
    const b = await sendBatch(c, txs)
    if (b) return [{ txs, hash: b.hash, gasUsed: b.gasUsed }]
  }
  const sent: Sent[] = []
  for (const [i, tx] of txs.entries()) {
    on({ step: 'tx', tx, i, n: txs.length })
    sent.push({ txs: [tx], ...(await send(c, tx)) })
  }
  return sent
}

/** ENS as a verifier reads it, through the Universal Resolver: the name resolves to the wallet, with every record. */
export async function checkName(c: PublicClient, name: string, r: Records) {
  const addr = await c.getEnsAddress({ name })
  if (!addr || !isAddressEqual(addr, r.wallet)) throw new Stopped(`ENS doesn't resolve ${name} to your wallet.`)
  for (const [k, v] of recordTexts(r)) {
    const got = await c.getEnsText({ name, key: k })
    if (got !== v) throw new Stopped(`ENS shows ${k} on ${name} as ${got ?? 'nothing'}.`)
  }
}

export async function nameWedgie(
  w: Wedgie,
  c: Connected,
  device: Device,
  label: string,
  parent: string,
  binding: Hex,
  on: (s: NameStep) => void,
) {
  on({ step: 'binding' })
  const b = await boundTx(binding)
  if (b.environment !== 'production')
    throw new Stopped("That's a Simulator binding: ENS names take a World App one. Bind with World App first.")
  const { x, y } = uncompressKey(device.key)
  if (b.bound.keyHash.toLowerCase() !== keyHash(x, y)) throw new Stopped("That binding is another Wedgie's key.")
  const name = `${label}.${parent}`
  // A binding counts for the name its proof named, and only that one (D22)
  if (b.bound.node?.toLowerCase() !== deviceNode(name))
    throw new Stopped(`That binding is for another name than ${name}. Bind the Wedgie for ${name} first.`)

  const records: Records = { wallet: c.account, key: device.key, nullifier: b.bound.nullifier, poh: b.poh, sc: device.sc }
  const txs = namingTxs(await readName(c.chain, c.account, label, parent), records)
  on({ step: 'plan', txs })

  on({ step: 'device' })
  await become(w, name, device.key)
  const sent = await sendAll(c, txs, on)
  on({ step: 'check' })
  await checkName(c.chain, name, records)
  on({ step: 'confirm' })
  await confirmOn(w, { name, nullifier: records.nullifier, poh: records.poh })
  return { name, records, sent }
}

export type KillStep = WalletStep | { step: 'check' } | { step: 'device' }

/**
 * The kill switch. With no Wedgie connected (a lost one), ENS alone: no verifier takes its key after this. What the
 * Wedgie did: forgot its name and binding (Knock 5), only marked the name revoked (Knock 4, which keeps showing
 * it), or nothing (not connected).
 */
export async function killName(w: Wedgie | null, c: Connected, name: string, on: (s: KillStep) => void) {
  const [label, ...rest] = name.split('.')
  const txs = killTxs(await readName(c.chain, c.account, label, rest.join('.')))
  const sent = await sendAll(c, txs, on)
  on({ step: 'check' })
  if ((await c.chain.getEnsAddress({ name })) !== null) throw new Stopped(`ENS still resolves ${name}.`)
  let wedgie: 'forgot' | 'revoked' | 'away' = 'away'
  if (w) {
    on({ step: 'device' })
    wedgie = await forgetOn(w, name)
  }
  return { sent, wedgie }
}
