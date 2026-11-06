import { describe, expect, test } from 'bun:test'
import { type Mark, checksFor, marks, numbers } from './checks'

const done = { act: 'sign' as const, petition: 1, count: 2 }

describe('the list', () => {
  test('signed: every check passed, and a fresh proof was never asked', () => {
    expect(marks({ kind: 'in', name: 'a.eth', done }, 'sign')).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'skip', 'pass'])
  })

  test('knocked in, or closing: once per human is not asked', () => {
    expect(marks({ kind: 'in', name: 'a.eth', done: { act: 'in' } }, 'in')).toEqual([
      'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'skip', 'skip',
    ])
    expect(checksFor('close')[7]).toBe('Once per human (not asked here)')
  })

  test('bounced at a check: the ones before passed, it failed, none after ran', () => {
    expect(marks({ kind: 'bounced', check: 3, error: 'revoked', why: '' }, 'sign')).toEqual([
      'pass', 'pass', 'fail', 'todo', 'todo', 'todo', 'todo', 'todo',
    ])
    expect(marks({ kind: 'bounced', check: 8, error: 'already_entered', why: '' }, 'sign')).toEqual([
      'pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'skip', 'fail',
    ])
  })

  test('the club said no after the checks: they all passed', () => {
    expect(marks({ kind: 'declined', name: 'a.eth', error: 'closed', why: '' }, 'sign').every((m) => m !== 'fail')).toBe(true)
  })

  test('no knock, or none yet: nothing checked', () => {
    const none: Mark[] = ['todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo', 'todo']
    expect(marks({ kind: 'no-knock', code: 'closed', why: '' }, 'sign')).toEqual(none)
    expect(marks(null, 'start')).toEqual(none)
  })

  test("check 8, in each act's words", () => {
    expect(checksFor('sign')[7]).toBe('Their first signature on this petition')
    expect(checksFor('start')[7]).toBe('Their first new petition today')
    expect(checksFor('raise')[7]).toBe('Their first new fundraiser today')
    expect(marks({ kind: 'bounced', check: 8, error: 'already_entered', why: '' }, 'raise')[7]).toBe('fail')
  })

  test('the World ID way: checks 1 to 5, then 8, with no knock or fresh proof among them', () => {
    expect(numbers('world')).toEqual([1, 2, 3, 4, 5, 8])
    expect(checksFor('sign', 'world')).toHaveLength(6)
    expect(checksFor('sign', 'world')[5]).toBe('Their first signature on this petition')
    expect(marks({ kind: 'in', name: 'a.eth', done }, 'sign', 'world')).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass'])
    expect(marks({ kind: 'bounced', check: 4, error: 'not_proved', why: '' }, 'in', 'world')).toEqual([
      'pass', 'pass', 'pass', 'fail', 'todo', 'todo',
    ])
    expect(marks({ kind: 'bounced', check: 8, error: 'already_entered', why: '' }, 'sign', 'world')[5]).toBe('fail')
    expect(marks({ kind: 'in', name: 'a.eth', done: { act: 'in' } }, 'in', 'world')[5]).toBe('skip')
  })
})
