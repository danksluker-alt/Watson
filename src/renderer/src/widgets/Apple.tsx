// Widgets drawn in the style of Apple's own: Calendar, Reminders, Notes, Contacts,
// Mail, Shortcuts, World Clock and Batteries. macOS doesn't let other apps embed its widgets,
// so Watson reads the same data (EventKit, Notes, pmset) and draws its own.
import { useEffect, useState } from 'react'
import type { BatteryData, CalendarData, ClockData, ContactPerson, ContactsData, MailData, NotesData, RemindersData, ShortcutsData } from '@shared/types'

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

// ---------------- Calendar ----------------

export function CalendarWidget({ data }: { data: CalendarData }) {
  const now = useNow(30_000)
  const first = data.days[0]
  const firstDate = first ? new Date(`${first.date}T12:00:00`) : new Date()
  const total = data.days.reduce((n, d) => n + d.events.length, 0)
  return (
    <div className="aw calendar-w">
      <div className="cal-head">
        <div className="cal-date">
          <span className="cal-weekday">{firstDate.toLocaleDateString([], { weekday: 'long' }).toUpperCase()}</span>
          <span className="cal-day">{firstDate.getDate()}</span>
        </div>
        <div className="cal-summary">
          <span className="cal-title">{data.title}</span>
          <span className="muted small">{total === 0 ? 'No events' : `${total} event${total === 1 ? '' : 's'}`}</span>
        </div>
      </div>
      <div className="cal-days">
        {data.days.map((d) => (
          <div key={d.date} className="cal-group">
            {data.days.length > 1 && <div className="cal-group-label">{d.label}</div>}
            {d.events.length === 0 && <div className="cal-empty">Nothing scheduled</div>}
            {d.events
              .slice()
              .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start)
              .map((e, i) => {
                const live = !e.allDay && e.start <= now && e.end > now
                const past = !e.allDay && e.end <= now
                const hi = data.highlight && e.title.toLowerCase() === data.highlight.toLowerCase()
                return (
                  <div key={i} className={`cal-event${past ? ' past' : ''}${hi ? ' highlight' : ''}`} style={{ ['--c' as string]: e.color }}>
                    <span className="cal-bar" />
                    <div className="cal-event-main">
                      <div className="cal-event-title">{e.title}</div>
                      <div className="cal-event-time">
                        {e.allDay ? 'All day' : `${time(e.start)} – ${time(e.end)}`}
                        {e.location && <> · {e.location}</>}
                      </div>
                    </div>
                    {live && <span className="cal-now">Now</span>}
                  </div>
                )
              })}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------- Reminders ----------------

export function RemindersWidget({ data }: { data: RemindersData }) {
  const now = useNow(60_000)
  const color = data.items[0]?.color ?? '#0A84FF'
  return (
    <div className="aw reminders-w">
      <div className="rem-head">
        <span className="rem-icon" style={{ background: color }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round">
            <path d="M9 6h11M9 12h11M9 18h11" />
            <circle cx="4.5" cy="6" r="1.2" fill="#fff" stroke="none" />
            <circle cx="4.5" cy="12" r="1.2" fill="#fff" stroke="none" />
            <circle cx="4.5" cy="18" r="1.2" fill="#fff" stroke="none" />
          </svg>
        </span>
        <span className="rem-title" style={{ color }}>
          {data.title}
        </span>
        <span className="rem-count">{data.items.length}</span>
      </div>
      {data.items.length === 0 && <div className="cal-empty">All done</div>}
      <div className="rem-list">
        {data.items.slice(0, 10).map((r) => {
          const overdue = r.due !== undefined && r.due < now
          const hi = data.highlight && r.title.toLowerCase() === data.highlight.toLowerCase()
          return (
            <div key={r.id} className={hi ? 'rem-row highlight' : 'rem-row'}>
              <span className="rem-check" style={{ borderColor: r.color }} />
              <div className="rem-main">
                <div className="rem-text">
                  {r.priority > 0 && r.priority <= 4 && <span className="rem-flag">!!! </span>}
                  {r.title}
                </div>
                {(r.due || data.list === undefined) && (
                  <div className={overdue ? 'rem-due overdue' : 'rem-due'}>
                    {r.due && new Date(r.due).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    {r.due && data.list === undefined && ' · '}
                    {data.list === undefined && r.list}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------- Notes ----------------

function relativeDay(ms: number) {
  const d = new Date(ms)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return time(ms)
  const y = new Date(today.getTime() - 86_400_000)
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' })
}

export function NotesWidget({ data }: { data: NotesData }) {
  if (data.open) {
    return (
      <div className="aw notes-w">
        <div className="notes-head">
          <NotesGlyph />
          <span>Notes</span>
          <span className="muted small notes-date">{relativeDay(data.open.modified)}</span>
        </div>
        <div className="note-title">{data.open.title}</div>
        <div className="note-body">{data.open.body || <span className="muted">Empty note</span>}</div>
      </div>
    )
  }
  return (
    <div className="aw notes-w">
      <div className="notes-head">
        <NotesGlyph />
        <span>{data.query ? `“${data.query}”` : 'Notes'}</span>
        <span className="muted small notes-date">{data.notes.length}</span>
      </div>
      {data.notes.length === 0 && <div className="cal-empty">No notes found</div>}
      {data.notes.map((n) => (
        <div key={n.id} className="note-row">
          <div className="note-row-title">{n.title}</div>
          <div className="note-row-sub">
            <span className="note-row-date">{relativeDay(n.modified)}</span>
            <span className="note-row-snippet">{n.snippet || 'No additional text'}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

const NotesGlyph = () => (
  <span className="notes-glyph">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <rect x="4" y="3" width="16" height="18" rx="3" fill="#FFD60A" />
      <path d="M8 9h8M8 13h8M8 17h5" stroke="#5c4a00" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  </span>
)

// ---------------- Contacts ----------------

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?'

/** Opens on a click only (an empty new email, or the Mac's own "Call?" prompt); nothing is sent. */
const open = (url: string) => window.watson.openExternal(url)

function ContactCard({ p }: { p: ContactPerson }) {
  return (
    <div className="contact">
      <div className="contact-top">
        <span className="contact-avatar">{initials(p.name)}</span>
        <div className="contact-id">
          <div className="contact-name">{p.name}</div>
          {p.organization && <div className="contact-org">{p.organization}</div>}
        </div>
      </div>
      <div className="contact-rows">
        {p.phones.map((x, i) => (
          <button key={`p${i}`} className="contact-row link" onClick={() => open(`tel:${x.value.replace(/[^\d+]/g, '')}`)} title="Call (macOS asks first)">
            <span className="contact-label">{x.label || 'phone'}</span>
            <span className="contact-value">{x.value}</span>
          </button>
        ))}
        {p.emails.map((x, i) => (
          <button key={`e${i}`} className="contact-row link" onClick={() => open(`mailto:${x.value}`)} title="New email">
            <span className="contact-label">{x.label || 'email'}</span>
            <span className="contact-value">{x.value}</span>
          </button>
        ))}
        {p.birthday && (
          <div className="contact-row">
            <span className="contact-label">birthday</span>
            <span className="contact-value plain">{p.birthday}</span>
          </div>
        )}
        {p.address && (
          <div className="contact-row">
            <span className="contact-label">address</span>
            <span className="contact-value plain">{p.address}</span>
          </div>
        )}
      </div>
    </div>
  )
}

export function ContactsWidget({ data }: { data: ContactsData }) {
  return (
    <div className="aw contacts-w">
      <div className="contacts-head">
        <ContactsGlyph />
        <span>Contacts</span>
        {data.people.length > 1 && <span className="muted small notes-date">{data.people.length}</span>}
      </div>
      {data.people.length === 0 && <div className="cal-empty">No one called “{data.query}”</div>}
      {data.people.map((p) => (
        <ContactCard key={p.id} p={p} />
      ))}
    </div>
  )
}

const ContactsGlyph = () => (
  <span className="notes-glyph">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="2" width="18" height="20" rx="4" fill="#a2845e" />
      <circle cx="12" cy="10" r="3.4" fill="#fff" />
      <path d="M6.5 18.5c1-2.8 3.1-4 5.5-4s4.5 1.2 5.5 4" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  </span>
)

// ---------------- Mail ----------------

const messageLink = (id: string) => `message:%3C${encodeURIComponent(id).replace(/%40/g, '@')}%3E`

export function MailWidget({ data }: { data: MailData }) {
  return (
    <div className="aw mail-w">
      <div className="mail-head">
        <MailGlyph />
        <div className="mail-head-main">
          <span className="mail-title">{data.query ? `“${data.query}”` : 'Inbox'}</span>
          <span className="muted small">{data.query ? `${data.messages.length} found · ${data.unread} unread in all` : data.unread === 0 ? 'No unread mail' : 'Unread'}</span>
        </div>
        {!data.query && <span className="mail-count">{data.unread}</span>}
      </div>
      {data.messages.length === 0 && <div className="cal-empty">{data.query ? 'No messages found' : 'All caught up'}</div>}
      {data.messages.map((m, i) => (
        <button key={m.id || i} className={m.unread ? 'mail-row unread' : 'mail-row'} disabled={!m.id} onClick={() => m.id && open(messageLink(m.id))} title={m.id ? 'Open in Mail' : undefined}>
          <span className="mail-dot" />
          <div className="mail-main">
            <div className="mail-line">
              <span className="mail-sender">{m.sender}</span>
              <span className="mail-date">{relativeDay(m.date)}</span>
            </div>
            <div className="mail-subject">{m.subject}</div>
            {m.snippet && <div className="mail-snippet">{m.snippet}</div>}
            {m.mailbox && <div className="mail-box">{m.mailbox}</div>}
          </div>
        </button>
      ))}
    </div>
  )
}

const MailGlyph = () => (
  <span className="mail-glyph">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect x="2.5" y="5" width="19" height="14" rx="3" fill="#fff" />
      <path d="M3.5 6.5l8.5 6.5 8.5-6.5" stroke="#0a84ff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>
)

// ---------------- Shortcuts ----------------

const TILE_COLORS = ['#ff453a', '#ff9f0a', '#30d158', '#64d2ff', '#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f']
const tileColor = (name: string) => TILE_COLORS[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TILE_COLORS.length]

export function ShortcutsWidget({ data }: { data: ShortcutsData }) {
  if (data.ran) {
    return (
      <div className="aw shortcuts-w">
        <div className="sc-head">
          <ShortcutsGlyph />
          <span>Shortcuts</span>
        </div>
        <div className="sc-ran" style={{ ['--c' as string]: tileColor(data.ran.name) }}>
          <span className="sc-ran-name">{data.ran.name}</span>
          <span className="sc-ran-state">Ran</span>
        </div>
        {data.ran.output ? <div className="sc-output">{data.ran.output}</div> : <div className="cal-empty">No text output</div>}
      </div>
    )
  }
  return (
    <div className="aw shortcuts-w">
      <div className="sc-head">
        <ShortcutsGlyph />
        <span>Shortcuts</span>
        <span className="muted small notes-date">{data.shortcuts.length}</span>
      </div>
      {data.shortcuts.length === 0 && <div className="cal-empty">No shortcuts yet</div>}
      <div className="sc-grid">
        {data.shortcuts.slice(0, 24).map((n) => (
          <div key={n} className="sc-tile" style={{ ['--c' as string]: tileColor(n) }}>
            {n}
          </div>
        ))}
      </div>
      {data.shortcuts.length > 24 && <div className="muted small sc-more">and {data.shortcuts.length - 24} more</div>}
    </div>
  )
}

const ShortcutsGlyph = () => (
  <span className="notes-glyph">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <defs>
        <linearGradient id="scg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff375f" />
          <stop offset="1" stopColor="#5e5ce6" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="20" height="20" rx="5" fill="url(#scg)" />
      <path d="M8 8h5l3 4-3 4H8l3-4z" fill="#fff" />
    </svg>
  </span>
)

// ---------------- World Clock ----------------

function partsIn(tz: string, now: number) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false, weekday: 'short', day: 'numeric' })
  const p = Object.fromEntries(f.formatToParts(new Date(now)).map((x) => [x.type, x.value]))
  return { h: Number(p.hour) % 24, m: Number(p.minute), s: Number(p.second), day: Number(p.day), weekday: p.weekday }
}

function offsetMinutes(tz: string, now: number) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(new Date(now)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/)
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0
}

function offsetLabel(tz: string, now: number) {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  const diff = offsetMinutes(tz, now) - offsetMinutes(local, now)
  const dayThere = new Date(now).toLocaleDateString('en-CA', { timeZone: tz })
  const dayHere = new Date(now).toLocaleDateString('en-CA', { timeZone: local })
  const day = dayThere === dayHere ? 'Today' : dayThere > dayHere ? 'Tomorrow' : 'Yesterday'
  const hrs = diff / 60
  if (hrs === 0) return day
  const n = Number.isInteger(hrs) ? hrs : hrs.toFixed(1)
  return `${day}, ${hrs > 0 ? '+' : ''}${n}HRS`
}

function AnalogClock({ tz, now }: { tz: string; now: number }) {
  const { h, m, s } = partsIn(tz, now)
  const night = h < 6 || h >= 18
  const ms = now % 1000
  const sec = s + ms / 1000
  return (
    <svg className={night ? 'clock night' : 'clock'} viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="48" className="clock-face" />
      {Array.from({ length: 12 }).map((_, i) => (
        <text key={i} x={50 + Math.sin((i + 1) * (Math.PI / 6)) * 36} y={50 - Math.cos((i + 1) * (Math.PI / 6)) * 36 + 4.2} className="clock-num" textAnchor="middle">
          {i + 1}
        </text>
      ))}
      <line x1="50" y1="50" x2="50" y2="27" className="clock-hour" transform={`rotate(${(h % 12) * 30 + m * 0.5} 50 50)`} />
      <line x1="50" y1="50" x2="50" y2="15" className="clock-min" transform={`rotate(${m * 6 + s * 0.1} 50 50)`} />
      <g transform={`rotate(${sec * 6} 50 50)`}>
        <line x1="50" y1="58" x2="50" y2="12" className="clock-sec" />
      </g>
      <circle cx="50" cy="50" r="2.6" className="clock-pin" />
    </svg>
  )
}

export function ClockWidget({ data }: { data: ClockData }) {
  const now = useNow(1000)
  return (
    <div className="aw clock-w">
      {data.cities.slice(0, 4).map((c) => (
        <div key={c.name + c.timeZone} className="clock-cell">
          <AnalogClock tz={c.timeZone} now={now} />
          <div className="clock-city">{c.name === 'Local' ? 'Here' : c.name}</div>
          <div className="clock-off">{c.name === 'Local' ? new Date(now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : offsetLabel(c.timeZone, now)}</div>
        </div>
      ))}
    </div>
  )
}

// ---------------- Batteries ----------------

export function BatteryWidget({ data }: { data: BatteryData }) {
  const pct = data.percent ?? 100
  const low = data.percent !== null && pct <= 20
  const color = data.charging || data.onAC ? '#30D158' : low ? '#FF453A' : '#30D158'
  const r = 34
  const c = 2 * Math.PI * r
  return (
    <div className="aw battery-w">
      <svg width="92" height="92" viewBox="0 0 92 92" className="battery-ring">
        <circle cx="46" cy="46" r={r} stroke="rgba(255,255,255,0.12)" strokeWidth="8" fill="none" />
        <circle
          cx="46"
          cy="46"
          r={r}
          stroke={color}
          strokeWidth="8"
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          transform="rotate(-90 46 46)"
          className="battery-arc"
        />
        <g transform="translate(34 30)">
          <rect x="0" y="6" width="20" height="13" rx="3" fill="none" stroke="#fff" strokeWidth="1.6" />
          <rect x="21" y="10" width="2" height="5" rx="1" fill="#fff" />
          <rect x="2" y="8" width={Math.max(1, 16 * (pct / 100))} height="9" rx="1.5" fill={color} />
          {data.charging && <path d="M11 3l-4 10h4l-2 9 7-12h-4l2-7z" fill="#fff" stroke="#000" strokeWidth="0.8" transform="translate(-1 -1) scale(.9)" />}
        </g>
      </svg>
      <div className="battery-info">
        <div className="battery-device">This Mac</div>
        <div className="battery-pct">{data.percent === null ? 'On power' : `${data.percent}%`}</div>
        <div className="muted small">
          {data.state}
          {data.timeRemaining && ` · ${data.timeRemaining} ${data.charging ? 'until full' : 'left'}`}
        </div>
      </div>
    </div>
  )
}
