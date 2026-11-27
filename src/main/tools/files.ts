// Finding files with Spotlight (mdfind), limited to the user's home folder.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { runOs } from './os'

export type FoundFile = { name: string; path: string; folder: string; modified: number; kind: string }

const SKIP = /\/(Library|node_modules|\.git|\.Trash)\//

export async function findFiles(query: string, limit = 8): Promise<FoundFile[]> {
  const q = query.trim()
  if (!q) throw new Error('What should I look for?')
  const home = os.homedir()
  // Names first (fast, precise), then contents if names found little.
  const byName = await runOs('/usr/bin/mdfind', ['-onlyin', home, '-name', q], 8000).catch(() => '')
  let paths = byName.split('\n').filter(Boolean)
  if (paths.length < limit) {
    const byContent = await runOs('/usr/bin/mdfind', ['-onlyin', home, q], 8000).catch(() => '')
    paths = [...new Set([...paths, ...byContent.split('\n').filter(Boolean)])]
  }
  const out: FoundFile[] = []
  for (const p of paths) {
    if (SKIP.test(p) || /\/\./.test(p.slice(home.length))) continue
    let st: fs.Stats
    try {
      st = fs.statSync(p)
    } catch {
      continue
    }
    const isApp = p.endsWith('.app')
    out.push({
      name: path.basename(p),
      path: p,
      folder: path.dirname(p).replace(home, '~'),
      modified: st.mtimeMs,
      kind: isApp ? 'app' : st.isDirectory() ? 'folder' : path.extname(p).slice(1).toUpperCase() || 'file',
    })
  }
  // Most recently changed first: that's usually the one people mean.
  return out.sort((a, b) => b.modified - a.modified).slice(0, limit)
}
