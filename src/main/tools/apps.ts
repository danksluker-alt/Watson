// The apps installed on this Mac (name + bundle id), for adding agents without opening them first.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { InstalledApp } from '@shared/aiApps'
import { runOs } from './os'

let cache: { at: number; apps: InstalledApp[] } | null = null

async function bundleId(appPath: string): Promise<string> {
  try {
    return (await runOs('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')], 4000)).trim()
  } catch {
    return ''
  }
}

export async function installedApps(): Promise<InstalledApp[]> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.apps
  const dirs = ['/Applications', path.join(os.homedir(), 'Applications')]
  const paths = dirs.flatMap((d) => {
    try {
      return fs.readdirSync(d).filter((f) => f.endsWith('.app')).map((f) => path.join(d, f))
    } catch {
      return []
    }
  })
  const apps: InstalledApp[] = []
  // A few at a time: each lookup is a small process.
  for (let i = 0; i < paths.length; i += 12) {
    const chunk = await Promise.all(paths.slice(i, i + 12).map(async (p) => ({ name: path.basename(p, '.app'), bundleId: await bundleId(p) })))
    apps.push(...chunk.filter((a) => a.bundleId))
  }
  apps.sort((a, b) => a.name.localeCompare(b.name))
  cache = { at: Date.now(), apps }
  return apps
}
