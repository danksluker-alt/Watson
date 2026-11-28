// When a scheduled automation runs next. Pure, so it can be tested without Electron.
import type { AutomationRepeat } from './types'

const DAY = 86_400_000

/** The next time "HH:mm" (local) comes round after `from`, on a day the repeat allows. */
export function nextRun(time: string, repeat: AutomationRepeat, from = Date.now(), date?: string): number | null {
  const m = time.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  if (repeat === 'once' && date) {
    const d = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (!d) return null
    const at = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), h, min, 0, 0).getTime()
    return at > from ? at : null
  }
  const start = new Date(from)
  for (let i = 0; i < 8; i++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i, h, min, 0, 0)
    if (day.getTime() <= from) continue
    const wd = day.getDay()
    const weekend = wd === 0 || wd === 6
    if (repeat === 'weekdays' && weekend) continue
    if (repeat === 'weekends' && !weekend) continue
    return day.getTime()
  }
  return from + DAY // not reached
}

/** "Every day at 11:00 PM", "Weekdays at 7:30 AM", "Once, Fri Dec 4 at 9:00 PM". */
export function describeSchedule(_time: string, repeat: AutomationRepeat, nextAt: number): string {
  const at = new Date(nextAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (repeat === 'daily') return `Every day at ${at}`
  if (repeat === 'weekdays') return `Weekdays at ${at}`
  if (repeat === 'weekends') return `Weekends at ${at}`
  const d = new Date(nextAt)
  const today = new Date()
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
  const day =
    d.toDateString() === today.toDateString() ? 'Today' : d.toDateString() === tomorrow.toDateString() ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  return `${day} at ${at}`
}
