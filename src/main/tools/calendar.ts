// Calendar and Reminders through EventKit in the native helper.
import type { CalEvent, CalendarData, RemindersData } from '@shared/types'
import type { Helper } from '../helper'

const DAY = 86_400_000

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/** "2026-11-28T15:00" → local Date. A bare "2026-11-28" means local midnight, not UTC. */
export function parseLocal(s: string): Date {
  const v = /^\d{4}-\d{2}-\d{2}$/.test(s.trim()) ? `${s.trim()}T00:00` : s.trim()
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) throw new Error(`I couldn't understand the time "${s}".`)
  return d
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function dayLabel(d: Date): string {
  const today = startOfDay(new Date()).getTime()
  const t = startOfDay(d).getTime()
  if (t === today) return 'Today'
  if (t === today + DAY) return 'Tomorrow'
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}

type RawEvent = { title: string; start: number; end: number; allDay: boolean; calendar: string; color: string; location?: string }

export async function getCalendar(helper: Helper, range: string, highlight?: string): Promise<CalendarData> {
  let from = startOfDay(new Date())
  let days = 1
  if (range === 'tomorrow') from = new Date(from.getTime() + DAY)
  else if (range === 'week') days = 7
  else if (/^\d{4}-\d{2}-\d{2}$/.test(range)) from = parseLocal(range)
  const to = new Date(from.getTime() + days * DAY)
  const raw = await helper.request<RawEvent[]>('calendar.events', { from: from.getTime() / 1000, to: to.getTime() / 1000 }, 60_000)
  const events: CalEvent[] = raw.map((e) => ({ ...e, start: e.start * 1000, end: e.end * 1000 }))
  const out: CalendarData['days'] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getTime() + i * DAY)
    const next = d.getTime() + DAY
    const list = events.filter((e) => e.start < next && e.end > d.getTime())
    if (list.length || days === 1 || i === 0) out.push({ label: dayLabel(d), date: ymd(d), events: list })
  }
  const title = days === 7 ? 'Next 7 days' : dayLabel(from)
  return { range, title, days: out, highlight }
}

export async function addEvent(
  helper: Helper,
  e: { title: string; start: string; end?: string; allDay?: boolean; location?: string },
): Promise<{ date: string; summary: string }> {
  const start = parseLocal(e.start)
  const end = e.end ? parseLocal(e.end) : new Date(start.getTime() + (e.allDay ? DAY : 3_600_000))
  if (end <= start) throw new Error('The event ends before it starts.')
  await helper.request('calendar.add', {
    title: e.title,
    start: start.getTime() / 1000,
    end: end.getTime() / 1000,
    allDay: Boolean(e.allDay),
    location: e.location,
  }, 60_000)
  const when = e.allDay
    ? start.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
    : `${start.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} at ${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
  return { date: ymd(start), summary: `Added "${e.title}" on ${when}.` }
}

export function calendarForModel(c: CalendarData) {
  const time = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return {
    title: c.title,
    days: c.days.map((d) => ({
      day: d.label,
      events: d.events.length ? d.events.map((e) => `${e.allDay ? 'all day' : `${time(e.start)}–${time(e.end)}`} ${e.title}${e.location ? ` @ ${e.location}` : ''}`) : ['nothing scheduled'],
    })),
    widget: 'shown to the user already',
  }
}

type RawReminder = { id: string; title: string; due?: number; list: string; color: string; priority: number }

export async function getReminders(helper: Helper, list?: string, highlight?: string): Promise<RemindersData> {
  const raw = await helper.request<RawReminder[]>('reminders.list', { list }, 60_000)
  return {
    list,
    title: list ? list : 'Reminders',
    items: raw.map((r) => ({ ...r, due: r.due ? r.due * 1000 : undefined })),
    highlight,
  }
}

export async function addReminder(helper: Helper, r: { title: string; due?: string; list?: string }): Promise<string> {
  const due = r.due ? parseLocal(r.due) : undefined
  const res = await helper.request<{ title: string; list: string }>('reminders.add', { title: r.title, due: due ? due.getTime() / 1000 : undefined, list: r.list }, 60_000)
  const when = due ? ` for ${due.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''
  return `Added "${r.title}" to ${res.list}${when}.`
}

export function remindersForModel(r: RemindersData) {
  return {
    count: r.items.length,
    items: r.items.slice(0, 12).map((i) => `${i.title}${i.due ? ` (due ${new Date(i.due).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })})` : ''}`),
    widget: 'shown to the user already',
  }
}
