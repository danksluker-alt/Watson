import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractReply } from '../src/main/extract.ts'

const prompt = 'Improve the hero section on bloom-tracking.com so the headline is shorter and the button says Start free.'

test('reply after a single-line prompt', () => {
  const before = ['New chat', 'How can I help you today?']
  const after = ['New chat', prompt, 'Here is a shorter headline:', 'Track your cycle, simply.', 'Copy', 'Retry', 'Claude can make mistakes. Please double-check responses.']
  assert.equal(extractReply(before, after, prompt), 'Here is a shorter headline:\nTrack your cycle, simply.')
})

test('prompt split over several lines', () => {
  const after = ['Earlier chat', 'Improve the hero section on bloom-tracking.com so the headline', 'is shorter and the button says Start free.', 'Done. I changed two files.']
  assert.equal(extractReply([], after, prompt), 'Done. I changed two files.')
})

test('uses the last occurrence when the prompt was sent twice', () => {
  const after = [prompt, 'First answer', prompt, 'Second answer']
  assert.equal(extractReply([], after, prompt), 'Second answer')
})

test('falls back to new lines when the prompt is not visible', () => {
  const before = ['Old message', 'Old reply']
  const after = ['Old message', 'Old reply', 'Brand new reply line']
  assert.equal(extractReply(before, after, 'something not rendered at all in the window'), 'Brand new reply line')
})

test('nothing yet', () => {
  assert.equal(extractReply([], [prompt], prompt), '')
})

import { replyFromWindows } from '../src/main/extract.ts'

test('picks the browser window that holds the conversation', () => {
  const before = [{ title: 'Inbox', lines: ['Inbox', 'Mail from Sam'], busy: false }]
  const after = [
    { title: 'Inbox', lines: ['Inbox', 'Mail from Sam', 'Mail from Ana'], busy: false },
    { title: 'Grok', lines: ['Grok', 'What is 2+2 in binary?', '2 + 2 = 4, which is 100 in binary.', 'Stop'], busy: true },
  ]
  const r = replyFromWindows(before, after, 'What is 2+2 in binary?')
  assert.equal(r.found, true)
  assert.equal(r.busy, true)
  assert.equal(r.reply, '2 + 2 = 4, which is 100 in binary.')
})

// ---------- Built from real Claude desktop app snapshots (see tests/fixtures) ----------

import fs from 'node:fs'
import { joinInline } from '../src/main/extract.ts'

const real = JSON.parse(fs.readFileSync(new URL('./fixtures/claude-chat-ready.json', import.meta.url), 'utf8'))

test('real Claude chat: reads just the reply, without screen-reader copies or the footer', () => {
  const r = replyFromWindows([real.before], [real.after], real.prompt)
  assert.equal(r.found, true)
  assert.equal(r.reply, 'ready')
  assert.equal(r.busy, false)
})

test('real Claude chat: an answer still being written', () => {
  // Mid-answer, Claude shows "Claude is responding" (the helper turns that into busy) and part of the text.
  const upToPrompt = real.after.lines.slice(0, real.after.lines.lastIndexOf(real.prompt) + 1)
  const partial = { ...real.after, busy: true, lines: [...upToPrompt, 'rea'] }
  const r = replyFromWindows([real.before], [partial], real.prompt)
  assert.equal(r.reply, 'rea')
  assert.equal(r.busy, true)
})

test('rejoins paragraphs that the app split at bold words and links', () => {
  const lines = ['What you should see:', 'A dialog asks for access. Click', 'Open System Settings', '.', 'Under Accessibility there should now be a single', 'Watson', 'entry, switched off. Turn it', 'on', 'and confirm with Touch ID.', '1. Save your work.']
  assert.deepEqual(joinInline(lines), [
    'What you should see:',
    'A dialog asks for access. Click Open System Settings.',
    'Under Accessibility there should now be a single Watson entry, switched off. Turn it on and confirm with Touch ID.',
    '1. Save your work.',
  ])
})
