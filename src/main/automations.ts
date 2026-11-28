// Scheduled automations ("turn off my Mac at 11 pm every night"). They live in the main process,
// survive restarts (automations.json in the profile) and emit 'run' when it's time. Local only.
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { AutomationAction, AutomationItem, AutomationRepeat } from '@shared/types'
import { nextRun } from '@shared/schedule'

const MAX = 30
const file = () => path.join(app.getPath('userData'), 'automations.json')
let seq = 0
const newId = () => `a${Date.now().toString(36)}${(++seq).toString(36)}`

export const ACTION_LABEL: Record<AutomationAction, string> = {
  shut_down: 'Shut down',
  restart: 'Restart',
  sleep: 'Sleep',
  sleep_display: 'Turn off the display',
  dark_mode: 'Dark mode',
  light_mode: 'Light mode',
  mute: 'Mute the Mac',
  volume: 'Set the volume',
  open_app: 'Open an app',
  quit_app: 'Quit an app',
  announce: 'Say something',
}

export class Automations extends EventEmitter {
  private items: AutomationItem[] = []
  private handles = new Map<string, NodeJS.Timeout>()

  restore() {
    try {
      const saved = JSON.parse(fs.readFileSync(file(), 'utf8')) as AutomationItem[]
      this.items = Array.isArray(saved) ? saved.filter((a) => a && typeof a.time === 'string') : []
    } catch {
      this.items = []
    }
    // Ones that should have run while Watson was closed don't run late (a 3 a.m. shut-down at noon
    // would be a surprise): repeating ones move to their next time, missed one-offs are turned off.
    this.catchUp()
    this.changed()
  }

  /** Anything whose time passed while Watson was closed or the Mac slept moves on without running. */
  catchUp() {
    for (const a of this.items) {
      if (a.enabled && a.nextAt <= Date.now()) {
        const n = a.repeat === 'once' ? null : nextRun(a.time, a.repeat, Date.now())
        if (n) a.nextAt = n
        else a.enabled = false
      }
      this.schedule(a)
    }
  }

  /** After the Mac wakes: timers paused during sleep are re-armed against the real clock. */
  resume() {
    this.catchUp()
    this.changed()
  }

  list(): AutomationItem[] {
    return [...this.items].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.nextAt - b.nextAt)
  }

  add(a: { action: AutomationAction; value?: string; time: string; date?: string; repeat: AutomationRepeat; label?: string }): AutomationItem {
    if (this.items.length >= MAX) throw new Error(`You already have ${MAX} automations. Delete some in the dashboard first.`)
    const next = nextRun(a.time, a.repeat, Date.now(), a.date)
    if (!next) throw new Error("I couldn't understand that time. Use a time like 23:00, and a date in the future for a one-off.")
    if (['open_app', 'quit_app', 'announce'].includes(a.action) && !a.value?.trim()) throw new Error('That automation needs an app name or the words to say.')
    const item: AutomationItem = {
      id: newId(),
      label: a.label?.trim() || ACTION_LABEL[a.action] + (a.value && a.action !== 'announce' ? ` ${a.value}` : ''),
      action: a.action,
      value: a.value?.trim() || undefined,
      time: a.time,
      // A one-off remembers its day, so a missed one is never moved to the next day.
      date: a.repeat === 'once' ? (a.date ?? localDate(next)) : undefined,
      repeat: a.repeat,
      enabled: true,
      nextAt: next,
      createdAt: Date.now(),
    }
    this.items.push(item)
    this.schedule(item)
    this.changed()
    return item
  }

  /** Which automations a delete would remove: by id, or by words in the label (3+ letters); "all" is every one. */
  match(target: string): AutomationItem[] {
    const t = target.trim().toLowerCase()
    if (t === 'all') return [...this.items]
    const byId = this.items.filter((a) => a.id === target.trim())
    if (byId.length) return byId
    if (t.length < 3) return []
    const exact = this.items.filter((a) => a.label.toLowerCase() === t)
    if (exact.length) return exact
    return this.items.filter((a) => a.label.toLowerCase().includes(t) || a.action.replace(/_/g, ' ').includes(t))
  }

  remove(target: string): AutomationItem[] {
    const ids = new Set(this.match(target).map((a) => a.id))
    const gone = this.items.filter((a) => ids.has(a.id))
    for (const g of gone) {
      const h = this.handles.get(g.id)
      if (h) clearTimeout(h)
      this.handles.delete(g.id)
    }
    this.items = this.items.filter((a) => !gone.includes(a))
    if (gone.length) this.changed()
    return gone
  }

  setEnabled(id: string, enabled: boolean) {
    const a = this.items.find((x) => x.id === id)
    if (!a) return
    a.enabled = enabled
    if (enabled && a.nextAt <= Date.now()) {
      const n = nextRun(a.time, a.repeat, Date.now(), a.date)
      if (!n) a.enabled = false
      else a.nextAt = n
    }
    this.schedule(a)
    this.changed()
  }

  private schedule(a: AutomationItem) {
    const old = this.handles.get(a.id)
    if (old) clearTimeout(old)
    this.handles.delete(a.id)
    if (!a.enabled) return
    const wait = Math.min(Math.max(0, a.nextAt - Date.now()), 2 ** 31 - 1)
    this.handles.set(
      a.id,
      setTimeout(() => {
        if (Date.now() < a.nextAt - 50) return this.schedule(a)
        // Timers pause while the Mac sleeps: a run more than 2 minutes late is skipped, not done late.
        if (Date.now() - a.nextAt > 120_000) {
          console.log(`[watson] automation skipped (late after sleep): ${a.action}`)
          return this.resume()
        }
        a.lastRunAt = Date.now()
        const n = a.repeat === 'once' ? null : nextRun(a.time, a.repeat, Date.now() + 1000)
        if (n) a.nextAt = n
        else a.enabled = false
        this.schedule(a)
        this.changed()
        this.emit('run', a)
      }, wait),
    )
  }

  private changed() {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true })
      fs.writeFileSync(file(), JSON.stringify(this.items))
    } catch (e) {
      console.warn('[watson] could not save automations:', e instanceof Error ? e.message : e)
    }
    this.emit('change', this.list())
  }
}

const localDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const automations = new Automations()
