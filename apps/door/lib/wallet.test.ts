// The wallet's batches (D25) against a pretend EIP-1193 wallet, through viem as the Console runs it: what a wallet
// says it can do, the one atomic transaction it sends, and each way it can say no. Nothing here reaches a chain.
import { describe, expect, test } from 'bun:test'
import { type Address, type Hex, createWalletClient, custom } from 'viem'
import { mainnet } from 'viem/chains'
import { Stopped } from './stopped'
import { type Connected, canBatch, sendBatch } from './wallet'

const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1'
const HASH = `0x${'ab'.repeat(32)}` as Hex
const TXS = [
  { to: '0x00000000000000000000000000000000000000c3' as Address, data: '0x01' as Hex, what: "Write Knock's records" },
  { to: '0x00000000000000000000000000000000000000b2' as Address, data: '0x02' as Hex, what: 'Register the name' },
]

type Answers = Record<string, (params: unknown) => unknown>
const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code })

/** A wallet that answers only what it's given; anything else is a method it doesn't have (-32601). */
function pretend(answers: Answers, asked: string[] = []) {
  return createWalletClient({
    account: ACCOUNT,
    chain: mainnet,
    pollingInterval: 5,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        asked.push(method)
        const answer = answers[method]
        if (!answer) throw rpcError(-32601, `no ${method}`)
        return answer(params)
      },
    }),
  })
}

/** Connected to the pretend wallet. `simulated`: each call's result when the calls run together in one block. */
function connected(answers: Answers, asked: string[] = [], simulated = ['success', 'success']): Connected {
  return {
    name: 'Test Wallet',
    account: ACCOUNT,
    chain: {
      simulateCalls: async () => ({ results: simulated.map((status) => ({ status, data: '0x' as Hex })) }),
    } as never,
    wallet: pretend(answers, asked),
    batch: true,
  }
}

const ok = (atomic = true) => ({
  wallet_sendCalls: () => ({ id: '0x1234' }),
  wallet_getCallsStatus: () => ({
    version: '2.0.0',
    id: '0x1234',
    chainId: '0x1',
    atomic,
    status: 200,
    receipts: [
      { logs: [], status: '0x1', blockHash: HASH, blockNumber: '0x10', gasUsed: '0x61a80', transactionHash: HASH },
    ],
  }),
})

describe('canBatch', () => {
  const says = (caps: unknown) => canBatch(pretend({ wallet_getCapabilities: () => caps }), ACCOUNT)

  test("atomic ready or supported on mainnet, or on every chain (0x0), or the first draft's atomicBatch: it batches", async () => {
    expect(await says({ '0x1': { atomic: { status: 'ready' } } })).toBe(true)
    expect(await says({ '0x1': { atomic: { status: 'supported' } } })).toBe(true)
    expect(await says({ '0x0': { atomic: { status: 'supported' } } })).toBe(true)
    expect(await says({ '0x1': { atomicBatch: { supported: true } } })).toBe(true)
  })

  test("unsupported, only on another chain, nothing said, or no wallet_getCapabilities: it doesn't", async () => {
    expect(await says({ '0x1': { atomic: { status: 'unsupported' } } })).toBe(false)
    expect(await says({ '0x2105': { atomic: { status: 'ready' } } })).toBe(false)
    expect(await says({})).toBe(false)
    expect(await canBatch(pretend({}), ACCOUNT)).toBe(false)
  })

  test("it asks about mainnet, for the connected account", async () => {
    let params: unknown
    await canBatch(pretend({ wallet_getCapabilities: (p) => ((params = p), {}) }), ACCOUNT)
    expect(params).toEqual([ACCOUNT, ['0x1']])
  })
})

describe('sendBatch', () => {
  test('every call, in order, as one atomic transaction: its hash and gas', async () => {
    let params: unknown
    const out = await sendBatch(connected({ ...ok(), wallet_sendCalls: (p) => ((params = p), { id: '0x1234' }) }), TXS)
    expect(out).toEqual({ hash: HASH, gasUsed: 400_000n, atomic: true })
    const [req] = params as [{ atomicRequired: boolean; chainId: string; from: Address; calls: { to: Address; data: Hex }[] }]
    expect(req.atomicRequired).toBe(true)
    expect(req.chainId).toBe('0x1')
    expect(req.from).toBe(ACCOUNT)
    expect(req.calls.map((c) => [c.to, c.data])).toEqual(TXS.map((t) => [t.to, t.data]))
  })

  test("a wallet that can't batch after all (the user kept a plain account, unsupported, an older draft): null, nothing sent", async () => {
    for (const code of [5750, 5700, 5760, 5710, 5740, 4200, -32601, -32602]) {
      const asked: string[] = []
      const c = connected({ wallet_sendCalls: () => Promise.reject(rpcError(code, 'no batch')) }, asked)
      expect(await sendBatch(c, TXS)).toBeNull()
      expect(asked).toEqual(['wallet_sendCalls'])
    }
  })

  test('no in the wallet, or any other refusal: stopped, said for people', async () => {
    const no = connected({ wallet_sendCalls: () => Promise.reject(rpcError(4001, 'User rejected the request.')) })
    await expect(sendBatch(no, TXS)).rejects.toThrow('You said no in Test Wallet: nothing was sent.')
    const broke = connected({ wallet_sendCalls: () => Promise.reject(rpcError(-32000, 'insufficient funds for gas')) })
    await expect(sendBatch(broke, TXS)).rejects.toThrow("Test Wallet didn't send them")
  })

  test("ENS would refuse a call when they run together: the wallet isn't asked", async () => {
    const asked: string[] = []
    const c = connected(ok(), asked, ['success', 'failure'])
    const e = await sendBatch(c, TXS).catch((x) => x)
    expect(e).toBeInstanceOf(Stopped)
    expect(e.message).toContain('ENS would refuse "Register the name"')
    expect(asked).toEqual([])
  })

  test("a batch that didn't go through: stopped, with its hash", async () => {
    const c = connected({
      ...ok(),
      wallet_getCallsStatus: () => ({
        ...ok().wallet_getCallsStatus(),
        status: 500,
        receipts: [{ logs: [], status: '0x0', blockHash: HASH, blockNumber: '0x10', gasUsed: '0x5208', transactionHash: HASH }],
      }),
    })
    await expect(sendBatch(c, TXS)).rejects.toThrow(`didn't go through (${HASH})`)
  })
})
