/**
 * The Human Club's bot: it tries to get in without a Wedgie, the ways a bot would, against the club's verifier,
 * and says where each try bounced. It exits 1 if any try got in, since that would be a hole.
 *
 *   bun run bot [name] [verifier]     (defaults: wedgie.itzraj.eth, http://localhost:8788)
 */
import { NO_HUMAN_REF, P256_N, deviceNode, digest, signDigest } from '@knock-dev/protocol'
import { type Hex, toHex } from 'viem'

const name = process.argv[2] ?? 'wedgie.itzraj.eth'
const verifier = process.argv[3] ?? process.env.NEXT_PUBLIC_VERIFIER ?? 'http://localhost:8788'
const club = 'http://localhost:3001'

const random = (): Hex => toHex(crypto.getRandomValues(new Uint8Array(32)))
const botKey = random() // a key of its own: P-256, made a moment ago, in no ENS record

async function challenge(): Promise<Hex> {
  const r = await fetch(`${verifier}/challenge`, { method: 'POST', headers: { origin: club } })
  if (!r.ok) throw new Error(`the verifier gave no challenge (${r.status})`)
  return (await r.json()).challenge
}

/** A knock signed by the bot's own key, as `name`, for `origin`. */
function forged(c: Hex, origin = club, counter = 1) {
  const message = {
    challenge: c,
    origin,
    deviceNode: deviceNode(name),
    counter: BigInt(counter),
    mode: 1 as const,
    nullifier: BigInt(random()),
    humanRef: NO_HUMAN_REF,
  }
  const { r, s } = signDigest(digest('KnockPass', message), botKey)
  return { v: 1, name, ...message, counter, nullifier: toHex(message.nullifier, { size: 32 }), r, s }
}

async function attempt(what: string, assertion: unknown) {
  const r = await fetch(`${verifier}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: club },
    body: JSON.stringify({ assertion, action: 'enter' }),
  })
  const v = await r.json()
  const said = v.ok ? 'GOT IN' : `bounced at check ${v.check}: ${v.why}`
  console.log(`  ${what.padEnd(40)} ${said}`)
  return Boolean(v.ok)
}

console.log(`The Human Club's bot tries to get in as ${name}, without its Wedgie (verifier ${verifier}):`)
const tries: [string, () => Promise<unknown>][] = [
  ['its own key, a fresh challenge', async () => forged(await challenge())],
  ['a knock signed for another site', async () => forged(await challenge(), 'https://evil.example')],
  ['a challenge it made up', async () => forged(random())],
  [
    'the high-s twin of its signature',
    async () => {
      const k = forged(await challenge())
      return { ...k, s: toHex(P256_N - BigInt(k.s), { size: 32 }) }
    },
  ],
  ['a knock with a field added', async () => ({ ...forged(await challenge()), human: true })],
]
let inside = 0
for (const [what, make] of tries) if (await attempt(what, await make())) inside++
console.log(inside ? `${inside} got in: that's a hole.` : 'Nothing got in.')
process.exit(inside ? 1 : 0)
