import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DRAFT_TTL_MS, readSavedDraft, writeSavedDraft } from '../src/main/savedDraft.ts'

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watson-draft-')), 'draft.json')

test('a saved draft comes back as written', () => {
  const f = file()
  writeSavedDraft(f, 'a long prompt', 1000)
  assert.deepEqual(readSavedDraft(f, 2000), { text: 'a long prompt', at: 1000 })
})

test('an empty draft removes the file', () => {
  const f = file()
  writeSavedDraft(f, 'x', 1000)
  writeSavedDraft(f, '  ', 1000)
  assert.equal(fs.existsSync(f), false)
})

test('a draft older than 12 hours is let go', () => {
  const f = file()
  writeSavedDraft(f, 'old', 0)
  assert.equal(readSavedDraft(f, DRAFT_TTL_MS + 1), null)
  assert.equal(fs.existsSync(f), false)
})

test('a draft of 20 words or more is never let go', () => {
  const f = file()
  const long = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')
  writeSavedDraft(f, long, 0)
  assert.equal(readSavedDraft(f, DRAFT_TTL_MS * 100)?.text, long)
})

test('a missing or broken file is ignored', () => {
  const f = file()
  assert.equal(readSavedDraft(f), null)
  fs.writeFileSync(f, '{nope')
  assert.equal(readSavedDraft(f), null)
})
