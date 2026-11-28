// Apple Contacts through AppleScript. Read-only: Watson finds people, never edits, calls or messages them.
import type { ContactsData } from '@shared/types'
import { parseContacts } from './appleParse'
import { appScript, asString } from './os'

const osascript = appScript('Contacts')

/** Up to 5 people whose name contains the query (12 are read so the best matches can be put first). */
export async function findContacts(query: string): Promise<ContactsData> {
  const q = query.trim()
  if (!q) throw new Error('Say whose contact card to look up.')
  const out = await osascript(
    `
    set fs to character id 31
    set rs to character id 30
    set gs to character id 29
    set us to character id 28
    tell application "Contacts"
      set found to (people whose name contains ${asString(q)})
      set n to count of found
      if n > 12 then set n to 12
      set out to ""
      repeat with i from 1 to n
        set p to item i of found
        set nm to name of p
        if nm is missing value then set nm to ""
        set org to organization of p
        if org is missing value then set org to ""
        set ph to ""
        repeat with x in (phones of p)
          set l to label of x
          if l is missing value then set l to ""
          set ph to ph & l & us & (value of x) & gs
        end repeat
        set em to ""
        repeat with x in (emails of p)
          set l to label of x
          if l is missing value then set l to ""
          set em to em & l & us & (value of x) & gs
        end repeat
        set bd to ""
        try
          set b to birth date of p
          if b is not missing value then set bd to (b as «class isot» as string)
        end try
        set ad to ""
        try
          if (count of addresses of p) > 0 then
            set a to formatted address of item 1 of addresses of p
            if a is not missing value then set ad to a
          end if
        end try
        set out to out & (id of p) & fs & nm & fs & org & fs & ph & fs & em & fs & bd & fs & ad & rs
      end repeat
      return out
    end tell`,
    20_000,
  )
  return { query: q, people: parseContacts(out, q) }
}

export function contactsForModel(c: ContactsData) {
  if (!c.people.length) return { found: 0, note: `No contact matches "${c.query}".` }
  return {
    found: c.people.length,
    people: c.people.map((p) => ({
      name: p.name,
      ...(p.organization ? { org: p.organization } : {}),
      phones: p.phones.slice(0, 3).map((x) => `${x.label || 'phone'} ${x.value}`),
      emails: p.emails.slice(0, 2).map((x) => x.value),
      ...(p.birthday ? { birthday: p.birthday } : {}),
      ...(p.address ? { address: p.address } : {}),
    })),
    widget: 'shown to the user already',
  }
}
