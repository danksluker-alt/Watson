// Apple Notes through AppleScript. Watson can list, search, read and create notes,
// never edit or delete them.
import type { NotesData } from '@shared/types'
import { asString, FS, osascript, RS } from './os'

type Note = NotesData['notes'][number]

const LIST_FIELDS = `(id of x) & fs & (name of x) & fs & ((modification date of x) as «class isot» as string) & fs & (name of container of x) & fs & p`

function listScript(filter: string, limit: number) {
  return `
    set fs to character id 31
    set rs to character id 30
    tell application "Notes"
      set found to ${filter}
      set out to ""
      set n to count of found
      if n > ${limit} then set n to ${limit}
      repeat with i from 1 to n
        set x to item i of found
        set p to plaintext of x
        if length of p > 160 then set p to text 1 thru 160 of p
        set out to out & ${LIST_FIELDS} & rs
      end repeat
      return out
    end tell`
}

function parse(out: string): Note[] {
  return out
    .split(RS)
    .filter((r) => r.includes(FS))
    .map((r) => {
      const [id, title, modified, folder, snippet] = r.split(FS)
      const body = (snippet ?? '').replace(/\s+/g, ' ').trim()
      // Notes repeats the title as the first line of the text.
      const clean = body.startsWith(title) ? body.slice(title.length).trim() : body
      return { id, title, modified: Date.parse(modified) || 0, folder, snippet: clean }
    })
    .sort((a, b) => b.modified - a.modified)
}

export async function recentNotes(limit = 8): Promise<NotesData> {
  const out = await osascript(listScript('notes', 30), 20_000)
  return { notes: parse(out).slice(0, limit) }
}

export async function searchNotes(query: string): Promise<NotesData> {
  const q = asString(query)
  const out = await osascript(listScript(`(notes whose name contains ${q} or plaintext contains ${q})`, 12), 20_000)
  return { query, notes: parse(out) }
}

export async function readNote(query: string): Promise<NotesData> {
  const q = asString(query)
  const out = await osascript(`
    set fs to character id 31
    tell application "Notes"
      set found to (notes whose name contains ${q})
      if found is {} then set found to (notes whose plaintext contains ${q})
      if found is {} then return ""
      set x to item 1 of found
      return (name of x) & fs & ((modification date of x) as «class isot» as string) & fs & (plaintext of x)
    end tell`, 20_000)
  if (!out.includes(FS)) throw new Error(`I couldn't find a note about "${query}".`)
  const [title, modified, body] = out.split(FS)
  const text = body.startsWith(title) ? body.slice(title.length).trim() : body
  return { query, notes: [], open: { title, body: text.slice(0, 6000), modified: Date.parse(modified) || 0 } }
}

const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export async function createNote(title: string, body: string): Promise<NotesData> {
  const content = `<div><h1>${html(title)}</h1></div>${body
    .split('\n')
    .map((l) => `<div>${html(l) || '<br>'}</div>`)
    .join('')}`
  await osascript(`tell application "Notes" to make new note with properties {body:${asString(content)}}`, 20_000)
  return { notes: [], open: { title, body, modified: Date.now() } }
}

export function notesForModel(n: NotesData) {
  if (n.open) return { title: n.open.title, text: n.open.body.slice(0, 2500), widget: 'shown to the user already' }
  return { count: n.notes.length, notes: n.notes.map((x) => `${x.title} — ${x.snippet.slice(0, 80)}`), widget: 'shown to the user already' }
}
