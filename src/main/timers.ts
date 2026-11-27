// Timers and alarms. They live in the main process, survive restarts (timers.json in the
// profile) and call back when they go off. Everything is local: no API calls.
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { TimerItem } from '@shared/types'

const MAX = 20
const file = () => path.join(app.getPath('userData'), 'timers.json')

let seq = 0
const newId = () => `t${Date.now().toString(36)}${(++seq).toString(36)}`

export class Timers extends EventEmitter {
  private items: TimerItem[] = []
  private handles = new Map<string, NodeJS.Timeout>()

  /** Load saved timers. Ones that went off while Watson was closed fire right away. */
  restore() {
    try {
      const saved = JSON.parse(fs.readFileSync(file(), 'utf8')) as TimerItem[]
      this.items = Array.isArray(saved) ? saved.filter((t) => t && typeof t.endsAt === 'number') : []
    } catch {
      this.items = []
    }
    for (const t of this.items) this.schedule(t)
  }

  list(): TimerItem[] {
    return [...this.items].sort((a, b) => a.endsAt - b.endsAt)
  }

  start(seconds: number, label?: string): TimerItem {
    if (!(seconds >= 1)) throw new Error('A timer needs a length of at least one second.')
    if (seconds > 7 * 86_400) throw new Error('Timers can run for up to a week. For later than that, add a reminder.')
    return this.add({ kind: 'timer', label: label?.trim() || '', durationSec: Math.round(seconds), endsAt: Date.now() + Math.round(seconds) * 1000 })
  }

  alarm(at: Date, label?: string): TimerItem {
    if (Number.isNaN(at.getTime())) throw new Error("I couldn't understand that time.")
    let when = at.getTime()
    // "7:00" that has already passed today means tomorrow.
    while (when <= Date.now()) when += 86_400_000
    return this.add({ kind: 'alarm', label: label?.trim() || '', durationSec: Math.round((when - Date.now()) / 1000), endsAt: when })
  }

  /** Cancels by id, by label (case-insensitive), "all", or the only/soonest one when no target is given. */
  cancel(target?: string): TimerItem[] {
    const t = target?.trim().toLowerCase()
    let gone: TimerItem[]
    if (t === 'all') gone = [...this.items]
    else if (t) gone = this.items.filter((x) => x.id === target || x.label.toLowerCase() === t || x.label.toLowerCase().includes(t))
    else gone = this.list().slice(0, 1)
    for (const g of gone) this.remove(g.id)
    return gone
  }

  private add(t: Omit<TimerItem, 'id' | 'createdAt'>): TimerItem {
    if (this.items.length >= MAX) throw new Error(`You already have ${MAX} timers. Cancel some first.`)
    const item: TimerItem = { ...t, id: newId(), createdAt: Date.now() }
    this.items.push(item)
    this.schedule(item)
    this.changed()
    return item
  }

  private remove(id: string) {
    const h = this.handles.get(id)
    if (h) clearTimeout(h)
    this.handles.delete(id)
    this.items = this.items.filter((x) => x.id !== id)
    this.changed()
  }

  private schedule(t: TimerItem) {
    const old = this.handles.get(t.id)
    if (old) clearTimeout(old)
    // setTimeout can't wait longer than ~24.8 days; re-arm in steps.
    const wait = Math.min(Math.max(0, t.endsAt - Date.now()), 2 ** 31 - 1)
    this.handles.set(
      t.id,
      setTimeout(() => {
        if (Date.now() < t.endsAt - 50) return this.schedule(t)
        this.remove(t.id)
        this.emit('fire', t)
      }, wait),
    )
  }

  private changed() {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true })
      fs.writeFileSync(file(), JSON.stringify(this.items))
    } catch (e) {
      console.warn('[watson] could not save timers:', e instanceof Error ? e.message : e)
    }
    this.emit('change', this.list())
  }

  stop() {
    for (const h of this.handles.values()) clearTimeout(h)
    this.handles.clear()
  }
}

export const timers = new Timers()

/** "5 minutes", "1 hour 30 minutes", "90 seconds": how a timer is said out loud. */
export function spokenDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const part = (n: number, w: string) => (n ? `${n} ${w}${n === 1 ? '' : 's'}` : '')
  return [part(h, 'hour'), part(m, 'minute'), h ? '' : part(s, 'second')].filter(Boolean).join(' ') || '0 seconds'
}

export function timerName(t: TimerItem): string {
  if (t.kind === 'alarm') return t.label ? `${t.label} alarm` : 'alarm'
  return t.label ? `${t.label} timer` : `timer for ${spokenDuration(t.durationSec)}`
}
