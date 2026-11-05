import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type Hex, keccak256, sha256, stringToBytes, toHex } from 'viem'
import {
  ACTION,
  ACTION_HASH,
  DOMAIN,
  DOMAIN_SEPARATOR,
  KINDS,
  type Kind,
  type Messages,
  NO_HUMAN_REF,
  TYPES,
  bindSignal,
  deviceNode,
  digest,
  keyHash,
  publicKeyOf,
  signDigest,
  signalHash,
  structHash,
  typeString,
} from './index.ts'

export const VECTORS_PATH = fileURLToPath(new URL('../../../spec/vectors/v1.json', import.meta.url))

/** Fields sent as JSON numbers; every other integer travels as 0x + 32 bytes. */
const SMALL = new Set(['chainId', 'counter', 'mode'])

export function toWire<K extends Kind>(kind: K, message: Messages[K]): Record<string, string | number> {
  const m = message as Record<string, unknown>
  return Object.fromEntries(
    TYPES[kind].map((f) => {
      const v = m[f.name]
      if (typeof v !== 'bigint' && typeof v !== 'number') return [f.name, v as string]
      return [f.name, SMALL.has(f.name) ? Number(v) : toHex(BigInt(v), { size: 32 })]
    }),
  )
}

export function fromWire<K extends Kind>(kind: K, wire: Record<string, string | number>): Messages[K] {
  return Object.fromEntries(
    TYPES[kind].map((f) => {
      const v = wire[f.name]
      if (f.type === 'uint8') return [f.name, Number(v)]
      return [f.name, f.type.startsWith('uint') ? BigInt(v) : v]
    }),
  ) as Messages[K]
}

const seed = (label: string): Hex => keccak256(stringToBytes(`knock vector ${label}`))

export function buildVectors() {
  const secret = sha256(stringToBytes('knock test key 1'))
  const { x, y, key } = publicKeyOf(secret)
  const name = 'wedgie.itzraj.eth'
  const nullifier = BigInt(seed('nullifier')) >> 8n
  const messages: Messages = {
    KnockHello: { challenge: seed('hello challenge') },
    KnockEnroll: { nonce: seed('enroll nonce'), name, key },
    KnockBind: {
      chainId: 480n,
      registry: '0x1234567890123456789012345678901234567890',
      nullifier,
      expiresAtMin: 1798761600n,
      key,
    },
    KnockPass: {
      challenge: seed('pass challenge'),
      origin: 'https://bouncer.example',
      deviceNode: deviceNode(name),
      counter: 42n,
      mode: 1,
      nullifier,
      humanRef: NO_HUMAN_REF,
    },
  }
  const structs = Object.fromEntries(
    KINDS.map((kind) => {
      const d = digest(kind, messages[kind])
      return [
        kind,
        {
          type: typeString(kind),
          typeHash: keccak256(stringToBytes(typeString(kind))),
          message: toWire(kind, messages[kind]),
          structHash: structHash(kind, messages[kind]),
          digest: d,
          ...signDigest(d, secret),
        },
      ]
    }),
  )
  return {
    version: 1,
    note: 'Knock v1 test vectors. The key is a published test key: never use it for anything real.',
    domain: {
      ...DOMAIN,
      typeHash: keccak256(stringToBytes('EIP712Domain(string name,string version)')),
      separator: DOMAIN_SEPARATOR,
    },
    key: {
      secret,
      x,
      y,
      compressed: key,
      keyHash: keyHash(x, y),
      signal: bindSignal(key),
      signalHash: signalHash(bindSignal(key)),
    },
    action: { name: ACTION, hash: ACTION_HASH },
    device: { name, node: deviceNode(name) },
    structs,
  }
}

if (process.argv.includes('--write')) {
  writeFileSync(VECTORS_PATH, `${JSON.stringify(buildVectors(), null, 2)}\n`)
  console.log(`wrote ${VECTORS_PATH}`)
}
