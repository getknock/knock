import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'bun:test'
import { type Hex, concat, hexToBytes, keccak256, pad, stringToBytes, toHex } from 'viem'
import {
  ACTION_HASH,
  KINDS,
  type Kind,
  P256_N,
  TYPES,
  bindSignal,
  compressKey,
  deviceNode,
  digest,
  hashToField,
  signalHash,
  structHash,
  typeString,
  uncompressKey,
  verifySignature,
} from '../src/index.ts'
import { VECTORS_PATH, buildVectors, fromWire } from '../src/vectors.ts'

const vectors = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'))

// A second EIP-712 encoder written by hand, so the vectors don't rest on viem alone.
function encodeValue(type: string, value: unknown): Hex {
  if (type === 'bytes32') return value as Hex
  if (type === 'string') return keccak256(stringToBytes(value as string))
  if (type === 'bytes') return keccak256(value as Hex)
  if (type === 'address') return pad((value as Hex).toLowerCase() as Hex, { size: 32 })
  return toHex(BigInt(value as bigint), { size: 32 })
}

function manualDigest(kind: Kind, message: Record<string, unknown>): Hex {
  const h = (s: string) => keccak256(stringToBytes(s))
  const separator = keccak256(concat([h('EIP712Domain(string name,string version)'), h('Knock'), h('1')]))
  const struct = keccak256(concat([h(typeString(kind)), ...TYPES[kind].map((f) => encodeValue(f.type, message[f.name]))]))
  return keccak256(concat(['0x1901', separator, struct]))
}

describe('vectors', () => {
  it('match a fresh build', () => {
    expect(vectors).toEqual(JSON.parse(JSON.stringify(buildVectors())))
  })

  for (const kind of KINDS) {
    it(`${kind}: viem, the hand-rolled encoder and the file agree`, () => {
      const v = vectors.structs[kind]
      const m = fromWire(kind, v.message)
      expect(keccak256(stringToBytes(typeString(kind)))).toBe(v.typeHash)
      expect(structHash(kind, m)).toBe(v.structHash)
      expect(digest(kind, m)).toBe(v.digest)
      expect(manualDigest(kind, m as Record<string, unknown>)).toBe(v.digest)
    })

    it(`${kind}: its signature verifies; high s and a changed digest don't`, () => {
      const v = vectors.structs[kind]
      const { compressed, x, y } = vectors.key
      expect(verifySignature(v.digest, v.r, v.s, compressed)).toBe(true)
      expect(verifySignature(v.digest, v.r, v.s, concat(['0x04', x, y] as Hex[]))).toBe(true)
      expect(verifySignature(v.digest, v.r, toHex(P256_N - BigInt(v.s), { size: 32 }), compressed)).toBe(false)
      expect(verifySignature(keccak256(v.digest), v.r, v.s, compressed)).toBe(false)
    })
  }
})

describe('helpers', () => {
  const { compressed, x, y } = vectors.key

  it('hash a binding signal as the key bytes, not as UTF-8 text', () => {
    expect(signalHash(bindSignal(compressed))).toBe(hashToField(hexToBytes(compressed)))
    expect(signalHash(bindSignal(compressed))).not.toBe(hashToField(stringToBytes(compressed)))
    expect(signalHash('hello')).toBe(hashToField(stringToBytes('hello')))
  })

  it('compute the action hash as keccak256 >> 8', () => {
    expect(BigInt(ACTION_HASH)).toBe(BigInt(keccak256(stringToBytes('knock-bind'))) >> 8n)
  })

  it('compress and uncompress keys', () => {
    expect(compressKey(x, y)).toBe(compressed)
    expect(uncompressKey(compressed)).toEqual({ x, y })
  })

  it('normalise device names before hashing', () => {
    expect(deviceNode('Wedgie.ItzRaj.eth')).toBe(deviceNode('wedgie.itzraj.eth'))
    expect(deviceNode('wedgie.itzraj.eth')).toBe(vectors.device.node)
  })
})
