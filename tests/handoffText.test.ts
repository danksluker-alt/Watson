import assert from 'node:assert/strict'
import { test } from 'node:test'
import { joinNames, parseComparison, withAttachment } from '../src/main/handoffText.ts'

test('joinNames reads naturally', () => {
  assert.equal(joinNames(['Claude']), 'Claude')
  assert.equal(joinNames(['Claude', 'Grok']), 'Claude and Grok')
  assert.equal(joinNames(['Claude', 'Grok', 'Codex']), 'Claude, Grok and Codex')
})

test('an earlier answer goes after the request, clipped when huge', () => {
  assert.equal(withAttachment('Make it shorter'), 'Make it shorter')
  const t = withAttachment('Make it shorter', { from: 'Grok', text: 'Long answer' })
  assert.ok(t.startsWith('Make it shorter\n\n---\nHere is the earlier answer from Grok:'))
  assert.ok(t.endsWith('Long answer'))
  assert.ok(withAttachment('x', { from: 'Grok', text: 'a'.repeat(20_000) }).endsWith('[…cut for length]'))
})

test('comparison JSON is read, with agent names matched', () => {
  const r = parseComparison('Here: {"spoken":"They agree.","takeaways":[{"agent":"grok","text":"Adds the price."}]}', ['Claude', 'Grok'])
  assert.equal(r.spoken, 'They agree.')
  assert.deepEqual(r.takeaways, [{ agent: 'Grok', text: 'Adds the price.' }])
})

test('a comparison that is not JSON is still spoken', () => {
  assert.equal(parseComparison('Both say yes.', ['Claude', 'Grok']).spoken, 'Both say yes.')
  assert.match(parseComparison('', ['Claude', 'Grok']).spoken, /Claude and Grok both answered/)
})
