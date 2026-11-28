// Every shell command Watson runs on macOS (osascript, pmset) goes through here.
// Tests replace it with a bridge to the fake helper (WATSON_FAKE_OS=1).
import { execFile } from 'node:child_process'

type Exec = (cmd: string, args: string[], timeoutMs: number) => Promise<string>

const real: Exec = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      // Never put the script itself in the message (it ends up in logs); say what went wrong.
      if (err) reject(new Error(err.killed ? `${cmd.split('/').pop()} took too long and was stopped.` : (stderr || `${cmd.split('/').pop()} failed (${err.code ?? 'error'}).`).trim()))
      else resolve(stdout.trim())
    })
  })

let exec: Exec = real

export function setExecBridge(bridge: Exec) {
  exec = bridge
}

export const runOs = (cmd: string, args: string[], timeoutMs = 8000) => exec(cmd, args, timeoutMs)

export const osascript = (script: string, timeoutMs = 10_000) => runOs('/usr/bin/osascript', ['-e', script], timeoutMs)

/** Quote a string for AppleScript. */
export const asString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** Field and record separators that can't appear in normal text. */
export { FS, RS } from './appleParse'

/**
 * osascript for one app, with the friendly errors Notes uses: apps hang (rather than fail) while
 * macOS asks whether Watson may control them, and -1743 means the user said no earlier.
 */
export const appScript = (appName: string, verb = 'reading') => (script: string, timeoutMs?: number) =>
  osascript(script, timeoutMs).catch((e: Error) => {
    if (/took too long/.test(e.message)) throw new Error(`${appName} didn’t answer. If macOS is asking whether Watson may control ${appName}, click OK, then try again.`)
    if (/-1743|not allowed/i.test(e.message)) throw new Error(`macOS blocked Watson from ${verb} ${appName}. Allow it in System Settings → Privacy & Security → Automation → Watson → ${appName}.`)
    throw e
  })
