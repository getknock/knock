import { describe, expect, test } from 'bun:test'
import { CHECKS, type Knocked, type Mark, marks, outcome } from './checks'

const knocked = { name: 'wedgie.itzraj.eth' } as Knocked

describe('the list', () => {
  test('let in: every check passed, and fresh proof was never asked', () => {
    expect(marks(outcome({ ok: true, knock: knocked }))).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'skip', 'pass'])
  })

  test('bounced at a check: the ones before passed, it failed, none after ran', () => {
    expect(marks(outcome({ ok: false, check: 3, error: 'revoked', why: '' }))).toEqual([
      'pass', 'pass', 'fail', 'todo', 'todo', 'todo', 'todo', 'todo',
    ])
    expect(marks(outcome({ ok: false, check: 8, error: 'already_entered', why: '' }))).toEqual([
      'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'skip', 'fail',
    ])
    expect(marks(outcome({ ok: false, check: 6, error: 'no_binding', why: '' }))[6]).toBe('todo')
  })

  test("no knock, or the verifier's own trouble: nothing checked", () => {
    const none = CHECKS.map((): Mark => 'todo')
    expect(marks({ kind: 'no-knock', code: 'closed', why: '' })).toEqual(none)
    expect(marks(outcome({ ok: false, check: 0, error: 'busy', why: '' }))).toEqual(none)
  })
})
