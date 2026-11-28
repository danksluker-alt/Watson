// Pure parsing for what Contacts, Mail and Shortcuts print, kept free of runtime imports so
// the unit tests can load it directly (tests/appleParse.test.ts).
import type { ContactPerson, MailData, MailMessage } from '@shared/types'

/** Field, record, group and unit separators that can't appear in normal text (os.ts re-exports FS/RS). */
export const FS = '\u001f'
export const RS = '\u001e'
export const GS = '\u001d'
export const US = '\u001c'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Contacts stores built-in labels as "_$!<Mobile>!$_"; custom ones as typed. */
export function cleanLabel(label: string): string {
  const m = /^_\$!<(.+)>!\$_$/.exec(label.trim())
  const l = (m ? m[1] : label).trim()
  if (!l) return ''
  if (/^iphone$/i.test(l)) return 'iPhone'
  return m ? l.toLowerCase() : l
}

/** "1990-04-12T00:00:00" → "April 12, 1990". Contacts uses the year 1604 for birthdays without a year. */
export function formatBirthday(iso: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim())
  if (!m) return undefined
  const month = MONTHS[Number(m[2]) - 1]
  if (!month) return undefined
  const day = `${month} ${Number(m[3])}`
  return m[1] === '1604' ? day : `${day}, ${Number(m[1])}`
}

function pairs(s: string) {
  return (s ?? '')
    .split(GS)
    .filter((p) => p.includes(US))
    .map((p) => {
      const [label, value] = p.split(US)
      return { label: cleanLabel(label), value: value.trim() }
    })
    .filter((p) => p.value)
}

/** Best match first: the whole name, then a first or last name, then the rest. */
function rank(name: string, query: string) {
  const n = name.toLowerCase()
  const q = query.trim().toLowerCase()
  if (n === q) return 0
  if (n.split(/\s+/).includes(q)) return 1
  if (n.startsWith(q)) return 2
  return 3
}

export function parseContacts(out: string, query: string, limit = 5): ContactPerson[] {
  return out
    .split(RS)
    .filter((r) => r.includes(FS))
    .map((r) => {
      const [id, name, org, phones, emails, birthday, address] = r.split(FS)
      const person: ContactPerson = {
        id: id.trim(),
        name: (name ?? '').trim() || (org ?? '').trim() || 'No name',
        phones: pairs(phones).slice(0, 4),
        emails: pairs(emails).slice(0, 3),
      }
      if (org?.trim()) person.organization = org.trim()
      const b = birthday ? formatBirthday(birthday) : undefined
      if (b) person.birthday = b
      const a = (address ?? '').split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean).join(', ')
      if (a) person.address = a
      return person
    })
    .map((p, i) => ({ p, i, r: rank(p.name, query) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p)
    .slice(0, limit)
}

/** "Ana Lima <ana@example.com>" → name and address. */
export function splitSender(sender: string): { name: string; address?: string } {
  const s = sender.trim()
  const m = /^(.*?)\s*<([^>]+)>$/.exec(s)
  if (m) {
    const name = m[1].replace(/^"|"$/g, '').trim()
    return { name: name || m[2], address: m[2] }
  }
  return /@/.test(s) ? { name: s, address: s } : { name: s }
}

export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/**
 * First record: the unread count. Then one per message:
 * message id, sender, subject, date received (ISO, local), mailbox, account, read ("true"/"false"), start of the text.
 */
export function parseMail(out: string, limit = 8): Pick<MailData, 'unread' | 'messages'> {
  const records = out.split(RS)
  const unread = Number.parseInt((records[0] ?? '').trim(), 10)
  const messages: MailMessage[] = records
    .slice(1)
    .filter((r) => r.includes(FS))
    .map((r) => {
      const [id, sender, subject, date, mailbox, account, read, content] = r.split(FS)
      const from = splitSender(sender ?? '')
      const msg: MailMessage = {
        id: (id ?? '').trim().replace(/^<|>$/g, ''),
        sender: from.name || 'Unknown sender',
        subject: (subject ?? '').trim() || '(No subject)',
        date: Date.parse((date ?? '').trim()) || 0,
        snippet: clip(content ?? '', 140),
        mailbox: [account, mailbox].map((x) => (x ?? '').trim()).filter(Boolean).join(' · '),
        unread: (read ?? '').trim() !== 'true',
      }
      if (from.address) msg.address = from.address
      return msg
    })
    .sort((a, b) => b.date - a.date)
    .slice(0, limit)
  return { unread: Number.isFinite(unread) ? unread : messages.filter((m) => m.unread).length, messages }
}

/** `shortcuts list` prints one name per line. */
export function parseShortcuts(out: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const line of out.split(/\r?\n/)) {
    const n = line.trim()
    if (!n || seen.has(n)) continue
    seen.add(n)
    names.push(n)
  }
  return names
}

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** The shortcut the user meant: exact name, then ignoring case and punctuation, then a single partial match. */
export function matchShortcut(names: string[], query: string): string | undefined {
  const q = norm(query)
  if (!q) return undefined
  const exact = names.find((n) => n === query.trim())
  if (exact) return exact
  const same = names.find((n) => norm(n) === q)
  if (same) return same
  const starts = names.filter((n) => norm(n).startsWith(q))
  if (starts.length === 1) return starts[0]
  const contains = names.filter((n) => norm(n).includes(q))
  return contains.length === 1 ? contains[0] : undefined
}

/**
 * Links a contact or mail widget may open on a click: an empty new email (no subject or body, so
 * nothing is pre-written), a phone number (macOS asks before calling) or a Mail message (read-only).
 */
export function isAppLink(url: string): boolean {
  return (
    /^mailto:[^\s?&#/:,;]+@[^\s?&#/:,;]+$/.test(url) ||
    /^tel:\+?[0-9 ().-]{3,24}$/.test(url) ||
    /^message:%3C[A-Za-z0-9._~!$*'+=@%-]{1,400}%3E$/.test(url)
  )
}
