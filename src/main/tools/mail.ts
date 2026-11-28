// Apple Mail through AppleScript. Read-only: Watson lists and searches the inbox, never sends,
// moves, deletes or marks anything as read.
import type { MailData } from '@shared/types'
import { parseMail } from './appleParse'
import { appScript, asString } from './os'

const osascript = appScript('Mail')

const SHOWN = 8
/** Dates are read from this many messages at each end of the list (Mail's order isn't guaranteed). */
const EDGE = 30

/**
 * One request to Mail. The filter only collects references (cheap); dates are read for at most
 * 2 × EDGE of them, and the slow parts (sender, subject, text) only for the newest few shown.
 */
function script(filter: string) {
  return `
    set fs to character id 31
    set rs to character id 30
    tell application "Mail"
      set total to unread count of inbox
      set found to (${filter})
      set n to count of found
      set cands to {}
      if n is not greater than ${EDGE * 2} then
        repeat with i from 1 to n
          set end of cands to i
        end repeat
      else
        repeat with i from 1 to ${EDGE}
          set end of cands to i
        end repeat
        repeat with i from (n - ${EDGE - 1}) to n
          set end of cands to i
        end repeat
      end if
      set ds to {}
      repeat with j from 1 to count of cands
        set d to missing value
        try
          set d to date received of item (item j of cands) of found
        end try
        set end of ds to d
      end repeat
      set out to (total as string) & rs
      set picked to 0
      repeat while picked < ${SHOWN}
        set best to 0
        repeat with j from 1 to count of ds
          set d to item j of ds
          if d is not missing value then
            if best is 0 then
              set best to j
            else if d > item best of ds then
              set best to j
            end if
          end if
        end repeat
        if best is 0 then exit repeat
        set m to item (item best of cands) of found
        set item best of ds to missing value
        set picked to picked + 1
        set mid to ""
        try
          set mid to message id of m
        end try
        set snd to ""
        try
          set snd to sender of m
        end try
        set subj to subject of m
        if subj is missing value then set subj to ""
        set dt to (date received of m) as «class isot» as string
        set mbn to ""
        set acc to ""
        try
          set mbx to mailbox of m
          set mbn to name of mbx
          set acc to name of account of mbx
        end try
        set c to ""
        try
          set c to content of m
          if length of c > 400 then set c to text 1 thru 400 of c
        end try
        set out to out & mid & fs & snd & fs & subj & fs & dt & fs & mbn & fs & acc & fs & ((read status of m) as string) & fs & c & rs
      end repeat
      return out
    end tell`
}

export async function unreadMail(): Promise<MailData> {
  const out = await osascript(script('messages of inbox whose read status is false'), 20_000)
  return parseMail(out, SHOWN)
}

export async function searchMail(query: string): Promise<MailData> {
  const q = query.trim()
  if (!q) return unreadMail()
  const s = asString(q)
  const out = await osascript(script(`messages of inbox whose subject contains ${s} or sender contains ${s}`), 20_000)
  return { query: q, ...parseMail(out, SHOWN) }
}

export function mailForModel(m: MailData) {
  return {
    unread: m.unread,
    ...(m.query ? { search: m.query, found: m.messages.length } : {}),
    messages: m.messages.map((x) => `${x.unread ? '• ' : ''}${x.sender}: ${x.subject} — ${x.snippet.slice(0, 70)}`),
    widget: 'shown to the user already',
  }
}
