// Starts the Swift helper and speaks its line-delimited JSON protocol.
import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

export type HelperEvent =
  | { ev: 'ready'; permissions: unknown }
  | { ev: 'listening'; session: number }
  | { ev: 'partial'; text: string; session: number }
  | { ev: 'final'; text: string; session: number }
  | { ev: 'nospeech'; session: number }
  | { ev: 'level'; value: number }
  | { ev: 'bargein' }
  | { ev: 'speak.start'; id: string }
  | { ev: 'speak.idle'; stopped?: boolean }
  | { ev: 'error'; message: string }
  | { ev: 'log'; message: string }

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class Helper extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<string, Pending>()
  private seq = 0
  private buffer = ''
  private restarts = 0
  ready = false

  static binaryPath(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'watson-helper')
      : path.join(app.getAppPath(), 'helper', 'build', 'watson-helper')
  }

  get available(): boolean {
    return process.platform === 'darwin' && fs.existsSync(Helper.binaryPath())
  }

  start() {
    if (!this.available) {
      console.warn(`[watson] helper not found at ${Helper.binaryPath()} — run "npm run helper". Voice is off; typing still works.`)
      return
    }
    const proc = spawn(Helper.binaryPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    proc.stderr.on('data', (d) => console.error('[helper]', String(d).trim()))
    proc.on('exit', (code) => {
      this.ready = false
      this.proc = null
      for (const p of this.pending.values()) p.reject(new Error('helper exited'))
      this.pending.clear()
      this.emit('exit', code)
      if (this.restarts++ < 5) setTimeout(() => this.start(), 1000 * this.restarts)
    })
  }

  stop() {
    this.restarts = 99
    this.proc?.kill()
  }

  private onData(chunk: string) {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.ev === 'result' && typeof msg.id === 'string') {
        const p = this.pending.get(msg.id)
        if (!p) continue
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.data)
        else p.reject(new Error(String(msg.error ?? 'helper error')))
        continue
      }
      if (msg.ev === 'ready') {
        this.ready = true
        this.restarts = 0
      }
      if (msg.ev === 'log') console.log('[helper]', msg.message)
      this.emit('event', msg as HelperEvent)
    }
  }

  /** Fire-and-forget command. */
  send(cmd: string, args: Record<string, unknown> = {}) {
    if (!this.proc) return
    this.proc.stdin.write(JSON.stringify({ cmd, ...args }) + '\n')
  }

  /** Command that waits for its result. */
  request<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (!this.proc) return Promise.reject(new Error('Voice helper is not running.'))
    const id = `r${++this.seq}`
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${cmd} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.proc!.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n')
    })
  }
}
