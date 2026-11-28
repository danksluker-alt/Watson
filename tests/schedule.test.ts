import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextRun } from '../src/shared/schedule.ts'

// Wednesday, December 2 2026, 10:00 local.
const wed10 = new Date(2026, 11, 2, 10, 0).getTime()

test('later today', () => {
  assert.equal(nextRun('23:00', 'daily', wed10), new Date(2026, 11, 2, 23, 0).getTime())
})

test('already passed today means tomorrow', () => {
  assert.equal(nextRun('09:00', 'once', wed10), new Date(2026, 11, 3, 9, 0).getTime())
})

test('weekdays skip the weekend', () => {
  const fri20 = new Date(2026, 11, 4, 20, 0).getTime()
  assert.equal(nextRun('07:30', 'weekdays', fri20), new Date(2026, 11, 7, 7, 30).getTime())
})

test('weekends skip weekdays', () => {
  assert.equal(nextRun('10:00', 'weekends', wed10), new Date(2026, 11, 5, 10, 0).getTime())
})

test('a one-off on a date, and a past date is refused', () => {
  assert.equal(nextRun('21:00', 'once', wed10, '2026-12-10'), new Date(2026, 11, 10, 21, 0).getTime())
  assert.equal(nextRun('21:00', 'once', wed10, '2026-11-01'), null)
})

test('nonsense times are refused', () => {
  assert.equal(nextRun('25:00', 'daily', wed10), null)
  assert.equal(nextRun('soon', 'daily', wed10), null)
})
