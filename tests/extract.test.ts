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
