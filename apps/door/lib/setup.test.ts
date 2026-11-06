import { describe, expect, test } from 'bun:test'
import { deviceNode } from '@knock-dev/protocol'
import type { BindingOnChain } from './knockd'
import { type Known, setup } from './setup'

const TX = `0x${'ab'.repeat(32)}` as const
const NAME = 'wedgie.itzraj.eth'

function bound(name: string, tx: `0x${string}` = TX): Known {
  const on: BindingOnChain = {
    environment: 'production',
    chainId: 480,
    contract: `0x${'11'.repeat(20)}`,
    tx,
    block: 37301500,
    poh: `eip155:480:tx:${tx}`,
    bound: { nullifier: `0x${'1f'.repeat(32)}`, keyHash: `0x${'22'.repeat(32)}`, node: deviceNode(name), expiresAtMin: 0 },
  }
  return { state: 'bound', on, name: null }
}

const fresh = { name: null, status: null, nullifier: null }
const live = { name: NAME, status: 'active', nullifier: `0x${'1f'.repeat(32)}` }
const base = {
  device: fresh,
  name: NAME,
  nameOk: true,
  chosen: NAME,
  known: { state: 'none' } as Known,
  remembered: null,
  killedTx: null,
}

describe('the steps', () => {
  test('no Wedgie: connect it first', () => {
    expect(setup({ ...base, device: null, chosen: null }).steps).toEqual(['now', 'later', 'later', 'later'])
  })

  test('a Wedgie, no name chosen: choose one', () => {
    expect(setup({ ...base, chosen: null }).steps).toEqual(['done', 'now', 'later', 'later'])
  })

  test('a name typed but not chosen yet, or chosen then changed: the name step is open', () => {
    expect(setup({ ...base, chosen: 'other.itzraj.eth' }).steps).toEqual(['done', 'now', 'later', 'later'])
  })

  test('a name chosen and no binding: bind it', () => {
    expect(setup(base).steps).toEqual(['done', 'done', 'now', 'later'])
  })

  test('a set-up Wedgie: every step is done, whatever World Chain says', () => {
    for (const known of [{ state: 'none' }, { state: 'checking' }, bound(NAME)] as Known[]) {
      const s = setup({ ...base, device: live, chosen: null, known })
      expect(s.set).toBe(true)
      expect(s.steps).toEqual(['done', 'done', 'done', 'done'])
    }
  })

  test('a revoked name is not set up', () => {
    expect(setup({ ...base, device: { ...live, status: 'revoked' } }).set).toBe(false)
  })

  test("set up, and ENS says so: nothing's stale", () => {
    for (const inEns of ['live', null, undefined] as const) {
      const s = setup({ ...base, device: live, chosen: null, inEns })
      expect(s.stale).toBe(null)
      expect(s.steps).toEqual(['done', 'done', 'done', 'done'])
    }
  })

  test('killed or revoked from a wallet while it was away: the last step opens again', () => {
    for (const inEns of ['gone', 'revoked'] as const) {
      const s = setup({ ...base, device: live, chosen: null, inEns })
      expect(s.set).toBe(true)
      expect(s.stale).toBe(inEns)
      expect(s.steps).toEqual(['done', 'done', 'done', 'now'])
    }
  })

  test("ENS isn't read for a Wedgie that isn't set up", () => {
    expect(setup({ ...base, inEns: 'gone' }).stale).toBe(null)
  })
})

describe('the guard: never offer to bind a Wedgie that is bound already', () => {
  test('bound for the chosen name: binding is done, naming is next', () => {
    const s = setup({ ...base, known: bound(NAME) })
    expect(s.boundFor).toBe(NAME)
    expect(s.steps).toEqual(['done', 'done', 'done', 'now'])
  })

  test('bound for it in another browser: World Chain says so by its node alone', () => {
    const s = setup({ ...base, known: bound(NAME), remembered: null })
    expect(s.boundFor).toBe(NAME)
    expect(s.steps[2]).toBe('done')
  })

  test('bound for another name: the bind step stays open and says which', () => {
    const s = setup({ ...base, known: bound('old.itzraj.eth'), remembered: 'old.itzraj.eth' })
    expect(s.boundFor).toBe('old.itzraj.eth')
    expect(s.live.state).toBe('bound')
    expect(s.steps).toEqual(['done', 'done', 'now', 'later'])
  })

  test("bound for a name nobody here knows: it's bound, for another name", () => {
    const s = setup({ ...base, known: bound('secret.itzraj.eth') })
    expect(s.boundFor).toBe(null)
    expect(s.live.state).toBe('bound')
    expect(s.steps[2]).toBe('now')
  })

  test('still looking on World Chain: binding is not offered as done', () => {
    expect(setup({ ...base, known: { state: 'checking' } }).steps[2]).toBe('now')
  })

  test('killed here: its old binding no longer counts, so it binds again (D20)', () => {
    const s = setup({ ...base, known: bound(NAME), killedTx: TX.toUpperCase().replace('0X', '0x') })
    expect(s.killed).toBe(true)
    expect(s.live.state).toBe('none')
    expect(s.boundFor).toBe(null)
    expect(s.steps).toEqual(['done', 'done', 'now', 'later'])
  })

  test('killed here, then bound again: the new binding counts', () => {
    const s = setup({ ...base, known: bound(NAME, `0x${'cd'.repeat(32)}`), killedTx: TX })
    expect(s.killed).toBe(false)
    expect(s.steps).toEqual(['done', 'done', 'done', 'now'])
  })
})
