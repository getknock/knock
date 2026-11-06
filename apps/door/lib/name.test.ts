// Naming and the kill switch with stand-ins: a pretend Wedgie signs BECOME with the vectors' test key, fetch plays
// knockd, the wallet's send is recorded, and ENS answers what it's told. The order of everything is checked, and
// that nothing is sent or told after a no. The real transactions are checked on a mainnet fork (scripts/ens-fork.ts).
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { deviceNode, digest, keyHash, signDigest, uncompressKey } from '@knock-dev/protocol'
import { type Address, type Hex, zeroAddress } from 'viem'
import vectors from '../../../spec/vectors/v1.json'
import type { Device } from './device'
import * as ens from './ens'
import type { Message, Wedgie } from './wedgie'

const KEY = vectors.key.compressed as Hex
const SECRET = (vectors.key as Record<string, string>).secret as Hex
const WALLET: Address = '0x00000000000000000000000000000000000000a1'
const TX = `0x${'cd'.repeat(32)}` as Hex
const NULLIFIER = `0x${'12'.repeat(32)}` as Hex
const device: Device = { app: 'knock', firmware: 'knock-5', key: KEY, name: null, status: null, nullifier: null, poh: null, counter: 0, sc: 'S1' }

// ENS as it stands: a parent with no registry yet, the wallet's resolver ready, the label free
const state = (over: Partial<ens.NameState> = {}): ens.NameState => ({
  name: 'wedgie.itzraj.eth',
  label: 'wedgie',
  parent: 'itzraj.eth',
  node: ens.ENS.root as Hex,
  wallet: WALLET,
  parentRegistry: '0x00000000000000000000000000000000000000e7',
  canLink: true,
  subregistry: zeroAddress,
  userRegistry: '0x00000000000000000000000000000000000000b2',
  registryExists: false,
  held: 'free',
  nameResolver: zeroAddress,
  resolver: '0x00000000000000000000000000000000000000c3',
  resolverExists: true,
  recordId: 0n,
  ...over,
})
let now = state()
let log: string[] = []
let refuse: string | null = null
mock.module('./ens', () => ({ ...ens, readName: async () => now }))
mock.module('./wallet', () => ({
  send: async (_c: unknown, tx: ens.Tx) => {
    if (refuse === tx.id) throw new Error(`ENS would refuse ${tx.id}`)
    log.push(`send ${tx.id}`)
    return { hash: TX, gasUsed: 1n }
  },
}))

let nameWedgie: typeof import('./name').nameWedgie
let killName: typeof import('./name').killName
beforeAll(async () => {
  ;({ nameWedgie, killName } = await import('./name'))
})

/** A pretend Wedgie: BECOME signed as the chip signs it (or red), knock_confirm and knock_forget kept. */
function wedgie(press: 'green' | 'red' = 'green', forgets = true) {
  const w = {
    async ask(m: Message): Promise<Message> {
      log.push(`wedgie ${m.type}${m.status ? ` ${m.status}` : ''}`)
      if (m.type === 'knock_enroll') {
        if (press === 'red') return { type: 'knock_error', error: 'rejected' }
        const d = digest('KnockEnroll', { nonce: m.nonce as Hex, name: m.name as string, key: KEY })
        const { r, s } = signDigest(d, SECRET)
        return { type: 'knock_enrolled', nonce: m.nonce, name: m.name, node: deviceNode(m.name as string), key: KEY, digest: d, r, s }
      }
      if (m.type === 'knock_confirm') return { type: 'knock_confirmed', name: m.name, node: deviceNode(m.name as string) }
      if (m.type === 'knock_forget' && forgets) return { type: 'knock_forgotten', name: 'wedgie.itzraj.eth' }
      return { type: 'knock_error', error: 'bad_request', why: `no such request: ${m.type}` }
    },
  }
  return w as unknown as Wedgie
}

const realFetch = globalThis.fetch
function knockd(environment: 'production' | 'staging' = 'production', key = KEY, node = deviceNode('wedgie.itzraj.eth')) {
  const u = uncompressKey(key)
  globalThis.fetch = (async (url: string) => {
    log.push(`knockd ${new URL(url).pathname}`)
    return new Response(
      JSON.stringify({
        environment,
        chainId: 480,
        contract: '0x00',
        tx: TX,
        block: 1,
        poh: `eip155:480:tx:${TX}`,
        bound: { nullifier: NULLIFIER, keyHash: keyHash(u.x, u.y), node, expiresAtMin: 1 },
      }),
      { status: 200 },
    )
  }) as typeof fetch
}
afterEach(() => {
  globalThis.fetch = realFetch
  log = []
  refuse = null
  now = state()
})

/** The wallet's view of ENS: what's been written so far, or what `shows` says. */
function wallet(shows: 'records' | 'nothing' = 'records') {
  const texts = Object.fromEntries(
    ens.recordTexts({ wallet: WALLET, key: KEY, nullifier: NULLIFIER, poh: `eip155:480:tx:${TX}`, sc: 'S1' }),
  )
  return {
    name: 'Test Wallet',
    account: WALLET,
    chain: {
      getEnsAddress: async () => {
        log.push('ens addr')
        return shows === 'records' && log.includes('send name') ? WALLET : null
      },
      getEnsText: async ({ key }: { key: string }) => (shows === 'records' ? texts[key] : null),
    },
    wallet: {},
  } as never
}

describe('nameWedgie', () => {
  test('a World App binding, a green press: BECOME, the records first, the name last, ENS read back, the Wedgie told', async () => {
    knockd()
    const out = await nameWedgie(wedgie(), wallet(), device, 'wedgie', 'itzraj.eth', TX, () => {})
    expect(log).toEqual([
      'knockd /bound',
      'wedgie knock_enroll',
      'send records',
      'send registry',
      'send link',
      'send name',
      'ens addr',
      'wedgie knock_confirm active',
    ])
    expect(out.records).toEqual({ wallet: WALLET, key: KEY, nullifier: NULLIFIER, poh: `eip155:480:tx:${TX}`, sc: 'S1' })
  })

  test("a Simulator binding, another Wedgie's, or one for another name: the Wedgie isn't asked and nothing is sent", async () => {
    knockd('staging')
    await expect(nameWedgie(wedgie(), wallet(), device, 'wedgie', 'itzraj.eth', TX, () => {})).rejects.toThrow('World App')
    expect(log).toEqual(['knockd /bound'])
    log = []
    knockd('production', vectors.key.compressed.replace(/^0x0[23]/, (p) => (p === '0x02' ? '0x03' : '0x02')) as Hex)
    await expect(nameWedgie(wedgie(), wallet(), device, 'wedgie', 'itzraj.eth', TX, () => {})).rejects.toThrow(
      "another Wedgie's",
    )
    expect(log).toEqual(['knockd /bound'])
    log = []
    knockd('production', KEY, deviceNode('spare.itzraj.eth'))
    await expect(nameWedgie(wedgie(), wallet(), device, 'wedgie', 'itzraj.eth', TX, () => {})).rejects.toThrow(
      'another name than wedgie.itzraj.eth',
    )
    expect(log).toEqual(['knockd /bound'])
  })

  test('red on BECOME: nothing sent; a name someone else holds: the Wedgie not even asked', async () => {
    knockd()
    await expect(nameWedgie(wedgie('red'), wallet(), device, 'wedgie', 'itzraj.eth', TX, () => {})).rejects.toThrow(
      'Red on the Wedgie',
    )
    expect(log).toEqual(['knockd /bound', 'wedgie knock_enroll'])
    log = []
    now = state({ held: 'taken', registryExists: true })
    await expect(nameWedgie(wedgie(), wallet(), device, 'wedgie', 'itzraj.eth', TX, () => {})).rejects.toThrow(
      "someone else's",
    )
    expect(log).toEqual(['knockd /bound'])
  })

  test("ENS refuses a step, or doesn't show the records after: the Wedgie isn't told", async () => {
    knockd()
    refuse = 'link'
    await expect(nameWedgie(wedgie(), wallet(), device, 'wedgie', 'itzraj.eth', TX, () => {})).rejects.toThrow('refuse link')
    expect(log.at(-1)).toBe('send registry')
    log = []
    refuse = null
    await expect(nameWedgie(wedgie(), wallet('nothing'), device, 'wedgie', 'itzraj.eth', TX, () => {})).rejects.toThrow(
      "doesn't resolve",
    )
    expect(log.some((l) => l.startsWith('wedgie knock_confirm'))).toBe(false)
  })
})

describe('killName', () => {
  const named = () => state({ held: 'yours', registryExists: true, subregistry: '0x00000000000000000000000000000000000000b2', recordId: 3n })

  test('unregister, unlink, ENS read back, then the Wedgie forgets', async () => {
    now = named()
    const out = await killName(wedgie(), wallet('nothing'), 'wedgie.itzraj.eth', () => {})
    expect(log).toEqual(['send unregister', 'send unlink', 'ens addr', 'wedgie knock_forget'])
    expect(out.forgotten).toBe(true)
  })

  test('a lost Wedgie: ENS alone; Knock 4 keeps its name, revoked, with no binding', async () => {
    now = named()
    expect((await killName(null, wallet('nothing'), 'wedgie.itzraj.eth', () => {})).forgotten).toBe(false)
    expect(log).toEqual(['send unregister', 'send unlink', 'ens addr'])
    log = []
    now = state({ recordId: 0n }) // already killed
    await killName(wedgie('green', false), wallet('nothing'), 'wedgie.itzraj.eth', () => {})
    expect(log).toEqual(['ens addr', 'wedgie knock_forget', 'wedgie knock_confirm revoked'])
  })
})
