// Opening apps, websites and files. Nothing here deletes, sends or buys.
import { shell } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RUNNABLE = /\.(command|sh|zsh|bash|tool|terminal|workflow|scpt|applescript|scptd|pkg|mpkg|app)$/i

export function openApp(name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/open', ['-a', name], (err) => {
      if (err) reject(new Error(`I couldn't find an app called "${name}".`))
      else resolve(`Opened ${name}.`)
    })
  })
}

export async function openUrl(raw: string): Promise<string> {
  let url = raw.trim()
  if (!/^[a-z]+:/i.test(url)) url = `https://${url}`
  const u = new URL(url)
  if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Watson only opens web links (http or https).')
  await shell.openExternal(u.toString())
  return `Opened ${u.hostname}.`
}

export async function openFile(raw: string): Promise<string> {
  const p = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()))
  if (!fs.existsSync(p)) throw new Error(`There's no file at ${p}.`)
  if (RUNNABLE.test(p)) throw new Error("Watson won't open scripts or installers. Open that one yourself if you're sure.")
  const err = await shell.openPath(p)
  if (err) throw new Error(err)
  return `Opened ${path.basename(p)}.`
}
