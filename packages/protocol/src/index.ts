import { p256 } from '@noble/curves/nist.js'
import {
  type Address,
  type Hex,
  bytesToHex,
  concat,
  domainSeparator,
  hashStruct,
  hashTypedData,
  hexToBytes,
  keccak256,
  namehash,
  pad,
  size,
  stringToBytes,
  toHex,
} from 'viem'
import { normalize } from 'viem/ens'

/** EIP-712 domain shared by every Knock structure: no chain, no contract. */
export const DOMAIN = { name: 'Knock', version: '1' } as const

export const TYPES = {
  KnockHello: [{ name: 'challenge', type: 'bytes32' }],
  KnockEnroll: [
    { name: 'nonce', type: 'bytes32' },
    { name: 'name', type: 'string' },
    { name: 'key', type: 'bytes' },
  ],
  KnockBind: [
    { name: 'chainId', type: 'uint256' },
    { name: 'registry', type: 'address' },
    { name: 'nullifier', type: 'uint256' },
    { name: 'expiresAtMin', type: 'uint64' },
    { name: 'key', type: 'bytes' },
  ],
  KnockPass: [
    { name: 'challenge', type: 'bytes32' },
    { name: 'origin', type: 'string' },
    { name: 'deviceNode', type: 'bytes32' },
    { name: 'counter', type: 'uint64' },
    { name: 'mode', type: 'uint8' },
    { name: 'nullifier', type: 'uint256' },
    { name: 'humanRef', type: 'bytes32' },
  ],
} as const

export type KnockHello = { challenge: Hex }
export type KnockEnroll = { nonce: Hex; name: string; key: Hex }
export type KnockBind = { chainId: bigint; registry: Address; nullifier: bigint; expiresAtMin: bigint; key: Hex }
export type KnockPass = {
  challenge: Hex
  origin: string
  deviceNode: Hex
  counter: bigint
  mode: 1 | 2
  nullifier: bigint
  humanRef: Hex
}
export type Messages = { KnockHello: KnockHello; KnockEnroll: KnockEnroll; KnockBind: KnockBind; KnockPass: KnockPass }
export type Kind = keyof Messages
export const KINDS = Object.keys(TYPES) as Kind[]

/** Modes of a knock: humanity from the device's binding, or from a fresh World ID proof. */
export const MODE = { bound: 1, fresh: 2 } as const

/** The World ID action every binding proves. */
export const ACTION = 'knock-bind'

/** P-256's group order. Device signatures must have s <= N / 2. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

const ZERO32 = pad('0x', { size: 32 })

/** The 32-byte digest a device signs: keccak256(0x1901 || domainSeparator || hashStruct(message)). */
export function digest<K extends Kind>(kind: K, message: Messages[K]): Hex {
  return hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: kind, message } as Parameters<typeof hashTypedData>[0])
}

export function structHash<K extends Kind>(kind: K, message: Messages[K]): Hex {
  return hashStruct({ data: message, primaryType: kind, types: TYPES } as Parameters<typeof hashStruct>[0])
}

export function typeString(kind: Kind): string {
  return `${kind}(${TYPES[kind].map((f) => `${f.type} ${f.name}`).join(',')})`
}

export const DOMAIN_SEPARATOR = domainSeparator({ domain: DOMAIN })

/** World ID's hash_to_field: uint256(keccak256(bytes)) >> 8, as 32 bytes. */
export function hashToField(bytes: Hex | Uint8Array): Hex {
  return toHex(BigInt(keccak256(bytes)) >> 8n, { size: 32 })
}

/** IDKit's signal hashing: "0x" + a non-empty, even number of hex digits hashes as those bytes; anything else as UTF-8. */
export function signalHash(signal: string): Hex {
  return hashToField(/^0x(?:[0-9a-fA-F]{2})+$/.test(signal) ? hexToBytes(signal as Hex) : stringToBytes(signal))
}

export const ACTION_HASH = hashToField(stringToBytes(ACTION))

/** A binding's signal: the device's compressed key, then the node of the ENS name it binds for (D22), in lowercase
 *  hex, so its signal hash is hash_to_field(key ‖ node): the human's proof binds the key for that name only. */
export function bindSignal(key: Hex, node: Hex): string {
  if (size(key) !== 33 || size(node) !== 32 || BigInt(node) === 0n) throw new Error('bindSignal: a compressed key and a node')
  return concat([key, node]).toLowerCase()
}

/** namehash of the device name after ENSIP-15 normalisation. */
export function deviceNode(name: string): Hex {
  return namehash(normalize(name))
}

/** The 33-byte compressed key from the 32-byte coordinates. */
export function compressKey(x: Hex, y: Hex): Hex {
  return concat([BigInt(y) & 1n ? '0x03' : '0x02', pad(x, { size: 32 })])
}

export function uncompressKey(key: Hex): { x: Hex; y: Hex } {
  const raw = p256.Point.fromBytes(hexToBytes(key)).toBytes(false)
  return { x: bytesToHex(raw.slice(1, 33)), y: bytesToHex(raw.slice(33)) }
}

/** keccak256(X || Y): how a Bound event indexes a device key. */
export function keyHash(x: Hex, y: Hex): Hex {
  return keccak256(concat([pad(x, { size: 32 }), pad(y, { size: 32 })]))
}

/** Verifies a device signature over a digest as given (no re-hash). High s is rejected. */
export function verifySignature(d: Hex, r: Hex, s: Hex, key: Hex): boolean {
  if (BigInt(s) > P256_N / 2n) return false
  const sig = hexToBytes(concat([pad(r, { size: 32 }), pad(s, { size: 32 })]))
  try {
    return p256.verify(sig, hexToBytes(d), hexToBytes(key), { prehash: false, lowS: true })
  } catch {
    return false
  }
}

/** Deterministic low-s signature (RFC 6979), for tests and vectors. Real devices sign in their chip. */
export function signDigest(d: Hex, secretKey: Hex): { r: Hex; s: Hex } {
  const sig = p256.sign(hexToBytes(d), hexToBytes(secretKey), { prehash: false, lowS: true })
  return { r: bytesToHex(sig.slice(0, 32)), s: bytesToHex(sig.slice(32)) }
}

export function publicKeyOf(secretKey: Hex): { x: Hex; y: Hex; key: Hex } {
  const raw = p256.getPublicKey(hexToBytes(secretKey), false)
  const x = bytesToHex(raw.slice(1, 33))
  const y = bytesToHex(raw.slice(33))
  return { x, y, key: compressKey(x, y) }
}

/** humanRef for a Bound knock. */
export const NO_HUMAN_REF = ZERO32
