// The one unsent message (dictated or typed), kept on disk so clicking away, quitting or a
// restart never loses it. Only one is kept, so nothing piles up. A short one (under 20 words,
// easy to say again) is dropped after 12 hours; a longer one is kept until you send or discard it.
import fs from 'node:fs'

export const DRAFT_TTL_MS = 12 * 60 * 60 * 1000

/** Drafts this long are never dropped on their own. */
export const KEEP_WORDS = 20

export const draftExpired = (text: string, at: number, now = Date.now()) =>
  text.trim().split(/\s+/).filter(Boolean).length < KEEP_WORDS && now - at > DRAFT_TTL_MS

export type SavedDraft = { text: string; at: number }

export function readSavedDraft(file: string, now = Date.now()): SavedDraft | null {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SavedDraft>
    if (typeof d.text !== 'string' || !d.text.trim() || typeof d.at !== 'number') return null
    if (draftExpired(d.text, d.at, now)) {
      fs.rmSync(file, { force: true })
      return null
    }
    return { text: d.text, at: d.at }
  } catch {
    return null
  }
}

export function writeSavedDraft(file: string, text: string, now = Date.now()) {
  try {
    if (text.trim()) fs.writeFileSync(file, JSON.stringify({ text, at: now }), { mode: 0o600 })
    else fs.rmSync(file, { force: true })
  } catch (e) {
    console.warn('[watson] could not save the draft:', e instanceof Error ? e.message : e)
  }
}
