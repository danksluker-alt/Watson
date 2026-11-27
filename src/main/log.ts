// Copies console output to ~/Library/Logs/Watson/watson.log so problems on a real Mac can be
// diagnosed after the fact. Never log keys, transcripts of other apps, or API payloads.
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'

const MAX_BYTES = 1_000_000

export function logFile(): string {
  // Tests run against a throwaway profile; keep their logs out of the real one.
  const dir = process.env.WATSON_USER_DATA ? path.join(process.env.WATSON_USER_DATA, 'logs') : app.getPath('logs')
  return path.join(dir, 'watson.log')
}

export function installFileLog() {
  const file = logFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // Keep one previous log; start fresh when it grows too big.
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1')
  } catch {
    return
  }
  const write = (level: string, args: unknown[]) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${format(...args)}\n`)
    } catch {
      /* logging must never break the app */
    }
  }
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      write(level, args)
    }
  }
  console.log(`[watson] started v${app.getVersion()} (${app.isPackaged ? 'app' : 'dev'}) on macOS ${process.getSystemVersion()}`)
}
