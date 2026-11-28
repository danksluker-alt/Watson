// Apple Shortcuts through /usr/bin/shortcuts (no shell). Listing is free; running one goes through
// the user's OK in brain.ts first, because a shortcut can send, delete or change anything.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { matchShortcut, parseShortcuts } from './appleParse'
import { runOs } from './os'

const CLI = '/usr/bin/shortcuts'

export async function listShortcuts(): Promise<string[]> {
  try {
    return parseShortcuts(await runOs(CLI, ['list'], 15_000))
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    if (/took too long/.test(m)) throw new Error('Shortcuts didn’t answer. Try again in a moment.')
    throw new Error(/ENOENT/.test(m) ? 'The Shortcuts command isn’t available on this Mac.' : m)
  }
}

/** The exact name of the shortcut the user meant, or undefined. */
export async function findShortcut(query: string): Promise<{ name?: string; all: string[] }> {
  const all = await listShortcuts()
  return { name: matchShortcut(all, query), all }
}

/** Runs a shortcut by its exact name (call only after the user said yes). Returns its text output, if any. */
export async function runShortcut(name: string): Promise<string> {
  const file = path.join(os.tmpdir(), `watson-shortcut-${process.pid}-${Date.now()}.txt`)
  try {
    const stdout = await runOs(CLI, ['run', name, '--output-path', file], 60_000)
    let text = stdout
    try {
      if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8') || stdout
    } catch {
      /* no output file: the shortcut had no output */
    }
    console.log('[watson] shortcut ran')
    return text.trim().slice(0, 4000)
  } catch (e) {
    console.warn('[watson] shortcut failed')
    const m = e instanceof Error ? e.message : String(e)
    throw new Error(/took too long/.test(m) ? 'The shortcut ran for over a minute and was stopped.' : m)
  } finally {
    fs.rm(file, { force: true }, () => {})
  }
}
