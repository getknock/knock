// What lib/ens.ts asks of ENS, decoded: names as the Wedgie takes them, the order of the transactions, and what
// each one says. That they do what they say is checked on a mainnet fork (scripts/ens-fork.ts).
import { describe, expect, test } from 'bun:test'
import { type Address, type Hex, decodeFunctionData, getAddress, labelhash, namehash, zeroAddress } from 'viem'
import {
  ALL_ROLES,
  ENS,
  FOREVER,
  NAME_ROLES,
  type NameState,
  type Records,
  dnsEncode,
  factoryAbi,
  killTxs,
  nameProblem,
  namingTxs,
  registryAbi,
  resolverAbi,
  resolverSalt,
  userRegistrySalt,
} from './ens'

const WALLET: Address = getAddress('0x00000000000000000000000000000000000000a1')
const records: Records = {
  wallet: WALLET,
  key: `0x02${'ab'.repeat(32)}`,
  nullifier: `0x${'12'.repeat(32)}`,
  poh: `eip155:480:tx:0x${'cd'.repeat(32)}`,
  sc: 'S1',
}
const fresh: NameState = {
  name: 'wedgie.itzraj.eth',
  label: 'wedgie',
  parent: 'itzraj.eth',
  node: namehash('wedgie.itzraj.eth'),
  wallet: WALLET,
  parentRegistry: getAddress('0x00000000000000000000000000000000000000e7'),
  canLink: true,
  subregistry: zeroAddress,
  userRegistry: getAddress('0x00000000000000000000000000000000000000b2'),
  registryExists: false,
  held: 'free',
  nameResolver: zeroAddress,
  resolver: getAddress('0x00000000000000000000000000000000000000c3'),
  resolverExists: true,
  recordId: 0n,
}

describe('names', () => {
  test('DNS wire format: each label after its length, then a zero', () => {
    expect(dnsEncode('wedgie.itzraj.eth')).toBe('0x067765646769650669747a72616a0365746800')
  })

  test("the Wedgie's names: a-z, 0-9 and -, one-word labels, a parent of two labels or more, 64 at most", () => {
    expect(nameProblem('wedgie', 'itzraj.eth')).toBeNull()
    expect(nameProblem('spare-2', 'itzraj.eth')).toBeNull()
    for (const [label, parent] of [
      ['Wedgie', 'itzraj.eth'],
      ['we.dgie', 'itzraj.eth'],
      ['', 'itzraj.eth'],
      ['xn--wdgie', 'itzraj.eth'],
      ['wedgie', 'eth'],
      ['wédgie', 'itzraj.eth'],
      ['w'.repeat(54), 'itzraj.eth'],
    ])
      expect(nameProblem(label, parent)).not.toBeNull()
  })
})

describe('naming', () => {
  test('a parent with no registry: records, registry, link, then the name, last', () => {
    const txs = namingTxs(fresh, records)
    expect(txs.map((t) => t.id)).toEqual(['records', 'registry', 'link', 'name'])

    const multicall = decodeFunctionData({ abi: resolverAbi, data: txs[0].data })
    expect(txs[0].to).toBe(fresh.resolver)
    const calls = (multicall.args as [Hex[]])[0].map((d) => decodeFunctionData({ abi: resolverAbi, data: d }))
    const dns = dnsEncode('wedgie.itzraj.eth')
    expect(calls[0]).toMatchObject({ functionName: 'setAddress', args: [dns, 60n, WALLET.toLowerCase()] })
    expect(calls.slice(1).map((c) => c.args)).toEqual([
      [dns, 'knock.v', '1'],
      [dns, 'knock.key', records.key],
      [dns, 'knock.status', 'active'],
      [dns, 'knock.nullifier', records.nullifier],
      [dns, 'knock.poh', records.poh],
      [dns, 'knock.sc', 'S1'],
    ])

    const registry = decodeFunctionData({ abi: factoryAbi, data: txs[1].data })
    expect(txs[1].to).toBe(ENS.factory)
    expect(registry.args?.slice(0, 2)).toEqual([ENS.userRegistryImpl, userRegistrySalt(namehash('itzraj.eth'))])

    expect(txs[2].to).toBe(fresh.parentRegistry)
    expect(decodeFunctionData({ abi: registryAbi, data: txs[2].data }).args).toEqual([
      BigInt(labelhash('itzraj')),
      fresh.userRegistry,
    ])

    expect(txs[3].to).toBe(fresh.userRegistry)
    expect(decodeFunctionData({ abi: registryAbi, data: txs[3].data })).toMatchObject({
      functionName: 'register',
      args: ['wedgie', WALLET, zeroAddress, fresh.resolver, NAME_ROLES, FOREVER],
    })
  })

  test('no resolver of its own yet: one is made with the records in it, the wallet holding every role', () => {
    const txs = namingTxs({ ...fresh, resolverExists: false }, records)
    const d = decodeFunctionData({ abi: factoryAbi, data: txs[0].data })
    expect(d.args?.slice(0, 2)).toEqual([ENS.resolverImpl, resolverSalt(WALLET)])
    const init = decodeFunctionData({ abi: resolverAbi, data: d.args?.[2] as Hex })
    expect(init.functionName).toBe('initialize')
    expect((init.args as [unknown[], Hex[]])[0]).toEqual([{ account: WALLET, roleBitmap: ALL_ROLES }])
    expect((init.args as [unknown[], Hex[]])[1]).toHaveLength(7)
  })

  test('half done before: only what is left, and the records again; a name held by another: nothing', () => {
    const linked = { ...fresh, registryExists: true, subregistry: fresh.userRegistry }
    expect(namingTxs(linked, records).map((t) => t.id)).toEqual(['records', 'name'])
    const named = { ...linked, held: 'yours' as const, nameResolver: fresh.resolver }
    expect(namingTxs(named, records).map((t) => t.id)).toEqual(['records'])
    expect(namingTxs({ ...named, nameResolver: zeroAddress }, records).map((t) => t.id)).toEqual(['records', 'name'])
    expect(() => namingTxs({ ...linked, held: 'taken' }, records)).toThrow("someone else's")
  })

  test('the name keeps unregister and renew on its own token; every role and admin is one nybble bit', () => {
    expect(NAME_ROLES & (1n << 12n)).toBe(1n << 12n)
    expect(NAME_ROLES & (1n << 16n)).toBe(1n << 16n)
    expect(ALL_ROLES.toString(16)).toBe('1'.repeat(64))
    expect(FOREVER).toBe(2n ** 64n - 1n)
  })
})

describe('the kill switch', () => {
  const named: NameState = { ...fresh, registryExists: true, subregistry: fresh.userRegistry, held: 'yours', recordId: 4n }

  test('unregister first (it stops resolving), then unlink its records', () => {
    const txs = killTxs(named)
    expect(txs.map((t) => t.id)).toEqual(['unregister', 'unlink'])
    expect(txs[0].to).toBe(fresh.userRegistry)
    expect(decodeFunctionData({ abi: registryAbi, data: txs[0].data }).args).toEqual([BigInt(labelhash('wedgie'))])
    expect(txs[1].to).toBe(fresh.resolver)
    expect(decodeFunctionData({ abi: resolverAbi, data: txs[1].data })).toMatchObject({
      functionName: 'linkToRecord',
      args: [dnsEncode('wedgie.itzraj.eth'), 0n],
    })
  })

  test('half killed: only the unlink; all done: nothing; a name held by another: refused', () => {
    expect(killTxs({ ...named, held: 'free' }).map((t) => t.id)).toEqual(['unlink'])
    expect(killTxs({ ...named, held: 'free', recordId: 0n })).toEqual([])
    expect(() => killTxs({ ...named, held: 'taken' })).toThrow("can't kill it")
  })
})
