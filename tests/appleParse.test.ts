import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanLabel, clip, formatBirthday, FS, GS, isAppLink, matchShortcut, parseContacts, parseMail, parseShortcuts, RS, splitSender, US } from '../src/main/tools/appleParse.ts'

test('Contacts labels read like the app shows them', () => {
  assert.equal(cleanLabel('_$!<Mobile>!$_'), 'mobile')
  assert.equal(cleanLabel('_$!<HomePage>!$_'), 'homepage')
  assert.equal(cleanLabel('iPhone'), 'iPhone')
  assert.equal(cleanLabel('Studio line'), 'Studio line')
  assert.equal(cleanLabel(''), '')
})

test('birthdays, with and without a year', () => {
  assert.equal(formatBirthday('1991-04-12T00:00:00'), 'April 12, 1991')
  assert.equal(formatBirthday('1604-09-03T00:00:00'), 'September 3')
  assert.equal(formatBirthday('missing value'), undefined)
})

const person = (id: string, name: string, org = '', phones: [string, string][] = [], emails: [string, string][] = [], bd = '', addr = '') =>
  [id, name, org, phones.map((p) => p.join(US) + GS).join(''), emails.map((p) => p.join(US) + GS).join(''), bd, addr].join(FS)

test('contacts are parsed and the best name match comes first', () => {
  const out = [
    person('1', 'Diana Prince'),
    person('2', 'Anabel Costa', '', [['iPhone', '+351 912 345 678']]),
    person('3', 'Ana Lima', 'Studio Norte', [['_$!<Mobile>!$_', '+1 (415) 555-0134']], [['_$!<Work>!$_', 'ana@studionorte.com']], '1991-04-12T00:00:00', '12 Rua Augusta\nLisbon\nPortugal'),
  ].join(RS) + RS
  const people = parseContacts(out, 'ana')
  assert.deepEqual(people.map((p) => p.name), ['Ana Lima', 'Anabel Costa', 'Diana Prince'])
  assert.deepEqual(people[0], {
    id: '3',
    name: 'Ana Lima',
    organization: 'Studio Norte',
    phones: [{ label: 'mobile', value: '+1 (415) 555-0134' }],
    emails: [{ label: 'work', value: 'ana@studionorte.com' }],
    birthday: 'April 12, 1991',
    address: '12 Rua Augusta, Lisbon, Portugal',
  })
  assert.equal(people[1].organization, undefined)
  assert.equal(parseContacts(out, 'ana', 1).length, 1)
  assert.deepEqual(parseContacts('', 'x'), [])
})

test('a company card without a person name uses the company', () => {
  assert.equal(parseContacts(person('9', '', 'Acme') + RS, 'acme')[0].name, 'Acme')
})

test('senders are split into a name and an address', () => {
  assert.deepEqual(splitSender('Ana Lima <ana@x.com>'), { name: 'Ana Lima', address: 'ana@x.com' })
  assert.deepEqual(splitSender('"Product Weekly" <hello@x.com>'), { name: 'Product Weekly', address: 'hello@x.com' })
  assert.deepEqual(splitSender('<bare@x.com>'), { name: 'bare@x.com', address: 'bare@x.com' })
  assert.deepEqual(splitSender('bare@x.com'), { name: 'bare@x.com', address: 'bare@x.com' })
})

test('snippets are one line and clipped', () => {
  assert.equal(clip('  a\n\n b  ', 140), 'a b')
  const c = clip('x'.repeat(300), 140)
  assert.equal(c.length, 140)
  assert.ok(c.endsWith('…'))
})

test('mail: unread count first, messages newest first', () => {
  const row = (id: string, sender: string, subject: string, date: string, read: string, text: string) => [id, sender, subject, date, 'INBOX', 'iCloud', read, text].join(FS)
  const out = `5${RS}${row('<old@x>', 'Sam <sam@x.com>', 'Old', '2026-11-20T08:00:00', 'false', 'old')}${RS}${row('new@x', 'Ana Lima <ana@x.com>', '', '2026-11-28T09:00:00', 'true', 'Hi\nthere')}${RS}`
  const m = parseMail(out)
  assert.equal(m.unread, 5)
  assert.deepEqual(m.messages.map((x) => x.id), ['new@x', 'old@x'])
  assert.equal(m.messages[0].subject, '(No subject)')
  assert.equal(m.messages[0].snippet, 'Hi there')
  assert.equal(m.messages[0].mailbox, 'iCloud · INBOX')
  assert.equal(m.messages[0].unread, false)
  assert.equal(m.messages[1].unread, true)
  assert.equal(m.messages[1].sender, 'Sam')
  assert.equal(parseMail(`0${RS}`).messages.length, 0)
})

test('shortcut names are listed once and matched forgivingly', () => {
  const names = parseShortcuts('Morning\nLog Water\n\nText Mom I’m on my way\nMorning\r\nMorning Run\n')
  assert.deepEqual(names, ['Morning', 'Log Water', 'Text Mom I’m on my way', 'Morning Run'])
  assert.equal(matchShortcut(names, 'Morning'), 'Morning')
  assert.equal(matchShortcut(names, 'morning'), 'Morning')
  assert.equal(matchShortcut(names, 'log water.'), 'Log Water')
  assert.equal(matchShortcut(names, 'text mom im on my way'), 'Text Mom I’m on my way')
  assert.equal(matchShortcut(names, 'water'), 'Log Water')
  assert.equal(matchShortcut(names, 'morn'), undefined, 'two shortcuts start with "morn": ask, never guess')
  assert.equal(matchShortcut(names, ''), undefined)
  assert.equal(matchShortcut(names, 'Lunch'), undefined)
})

test('widgets may open only an empty email, a phone number or a Mail message', () => {
  assert.ok(isAppLink('mailto:ana@studionorte.com'))
  assert.ok(isAppLink('tel:+14155550134'))
  assert.ok(isAppLink('message:%3Cm1@studionorte.com%3E'))
  assert.ok(isAppLink(`message:%3C${encodeURIComponent('CA+x=y_z@mail.gmail.com').replace(/%40/g, '@')}%3E`))
  assert.ok(!isAppLink('mailto:ana@x.com?subject=hi&body=send'))
  assert.ok(!isAppLink('mailto:a@x.com,b@y.com?cc=c'))
  assert.ok(!isAppLink('tel:+1;phone-context=evil'))
  assert.ok(!isAppLink('file:///etc/passwd'))
  assert.ok(!isAppLink('message:%3Cx y%3E'))
  assert.ok(!isAppLink('javascript:alert(1)'))
})
