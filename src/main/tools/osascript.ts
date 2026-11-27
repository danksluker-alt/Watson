import { execFile } from 'node:child_process'

export function osascript(script: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve(stdout.trim())
    })
  })
}

/** Quote a string for AppleScript. */
export const asString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
