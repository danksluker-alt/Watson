// The Watson window: everything in one place. Your recent requests as a simple chat, every
// hand-off to your other AIs with its full answer, and anything waiting for your OK on top.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AutomationItem, Block, CompareData, DelegationData, HistoryData, HistoryTurn, UIState } from '@shared/types'
import { describeSchedule } from '@shared/schedule'
import { ArrowUp, Bolt, Bubble, Check, Clock, Close, Gear, Grid, Mic, Moon, Power, Sparkle, Speaker, Trash, Warning } from './components/Icons'
import { Markdown } from './components/Markdown'
import { Orb } from './components/Orb'
import { Blocks } from './widgets/Blocks'
import { CompareCard } from './widgets/Compare'
import { AgentMark } from './widgets/Delegation'

type Tab = 'chat' | 'handoffs' | 'widgets' | 'automations'
type Job = DelegationData & { at: number }
type Entry = { kind: 'job'; job: Job } | { kind: 'group'; key: string; jobs: Job[]; compare?: CompareData; at: number }

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function dayLabel(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
}

/** One card per thing you looked at: the newest weather per place, stock per symbol, and so on. */
function widgetKey(b: Block, title?: string): string {
  if (b.type === 'weather') return `weather:${b.data.place}`
  if (b.type === 'stock') return `stock:${b.data.symbol}`
  if (b.type === 'compare') return `compare:${b.data.groupId}`
  return `${b.type}:${title ?? ''}`
}

type WidgetEntry = { key: string; at: number; title?: string; you: string; block: Block }

function recentWidgets(turns: HistoryTurn[]): WidgetEntry[] {
  const seen = new Set<string>()
  const out: WidgetEntry[] = []
  for (const t of [...turns].reverse()) {
    for (const b of t.blocks ?? []) {
      if (b.type === 'text' || b.type === 'delegation') continue
      const key = widgetKey(b, t.title)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, at: t.at, title: t.title, you: t.you, block: b })
    }
  }
  return out
}

function AutomationIcon({ a }: { a: AutomationItem }) {
  switch (a.action) {
    case 'shut_down':
    case 'restart':
    case 'sleep':
      return <Power size={16} />
    case 'sleep_display':
    case 'dark_mode':
      return <Moon size={16} />
    case 'mute':
    case 'volume':
      return <Speaker size={16} off={a.action === 'mute'} />
    case 'announce':
      return <Mic size={16} />
    default:
      return <Bolt size={16} />
  }
}

function Automations({ s }: { s: UIState | null }) {
  const list = s?.automations ?? []
  const timers = s?.timers ?? []
  const left = (ms: number) => {
    const m = Math.max(0, Math.round((ms - Date.now()) / 60_000))
    return m < 60 ? `in ${m} min` : `at ${new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  }
  if (!list.length && !timers.length)
    return (
      <div className="home-empty">
        <div className="empty-icon">
          <Bolt size={22} />
        </div>
        <p>Nothing scheduled.</p>
        <p className="muted">Try “turn off my Mac at 11 every night”.</p>
      </div>
    )
  return (
    <div className="auto-page">
      {list.length > 0 && (
        <section>
          <h3 className="section-title">Scheduled</h3>
          <div className="auto-list">
            {list.map((a) => (
              <div key={a.id} className={a.enabled ? 'auto-row' : 'auto-row off'}>
                <div className={`auto-icon ${a.action}`}>
                  <AutomationIcon a={a} />
                </div>
                <div className="auto-main">
                  <div className="auto-title">{a.label}</div>
                  <div className="auto-when">
                    {a.enabled ? describeSchedule(a.time, a.repeat, a.nextAt) : a.repeat === 'once' && a.lastRunAt ? 'Done' : 'Off'}
                    {a.action === 'announce' && a.value ? ` · “${a.value}”` : ''}
                  </div>
                </div>
                <button role="switch" aria-checked={a.enabled} aria-label={a.enabled ? 'Turn off' : 'Turn on'} className={a.enabled ? 'toggle on' : 'toggle'} onClick={() => window.watson.setAutomationEnabled(a.id, !a.enabled)} />
                <button className="row-icon" aria-label="Delete" title="Delete" onClick={() => window.watson.removeAutomation(a.id)}>
                  <Trash size={15} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {timers.length > 0 && (
        <section>
          <h3 className="section-title">Timers and alarms</h3>
          <div className="auto-list">
            {timers.map((t) => (
              <div key={t.id} className="auto-row">
                <div className="auto-icon timer">
                  <Clock size={16} />
                </div>
                <div className="auto-main">
                  <div className="auto-title">{t.label || (t.kind === 'alarm' ? 'Alarm' : 'Timer')}</div>
                  <div className="auto-when">Goes off {left(t.endsAt)}</div>
                </div>
                <button className="row-icon" aria-label="Cancel" title="Cancel" onClick={() => window.watson.cancelTimer(t.id)}>
                  <Close size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

const TITLES: Record<Tab, string> = { chat: 'Conversation', handoffs: 'AI agents', widgets: 'Widgets', automations: 'Automations' }

const STATUS: Record<string, string> = {
  confirming: 'Waiting for your OK',
  sending: 'Sending',
  waiting: 'Working',
  reading: 'Reading the answer',
  done: 'Answered',
  failed: 'Didn’t go through',
}

export function HomePage() {
  const [h, setH] = useState<HistoryData>({ turns: [], jobs: [] })
  const [s, setS] = useState<UIState | null>(null)
  const [tab, setTab] = useState<Tab>('chat')
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.watson.getHistory().then(setH)
    void window.watson.getState().then(setS)
    const a = window.watson.onHistory(setH)
    const b = window.watson.onState(setS)
    return () => {
      a()
      b()
    }
  }, [])

  const turns = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? h.turns.filter((t) => `${t.you} ${t.watson} ${t.title ?? ''}`.toLowerCase().includes(q)) : h.turns
  }, [h.turns, query])
  const jobs = useMemo(() => [...h.jobs].reverse().filter((j) => !query || `${j.agent} ${j.prompt} ${j.summary ?? ''}`.toLowerCase().includes(query.toLowerCase())), [h.jobs, query])
  const activeJobs = (s?.jobs ?? []).filter((j) => !['done', 'failed'].includes(j.status))
  const widgets = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = recentWidgets(h.turns)
    return q ? all.filter((w) => `${w.title ?? ''} ${w.you} ${w.block.type}`.toLowerCase().includes(q)) : all
  }, [h.turns, query])
  // Questions asked to several AIs at once show as one comparison.
  const entries = useMemo(() => {
    const out: Entry[] = []
    const seen = new Set<string>()
    for (const j of jobs) {
      if (!j.groupId) {
        out.push({ kind: 'job', job: j })
        continue
      }
      if (seen.has(j.groupId)) continue
      seen.add(j.groupId)
      const members = h.jobs.filter((x) => x.groupId === j.groupId)
      out.push({ kind: 'group', key: j.groupId, jobs: members, compare: h.compares?.find((c) => c.groupId === j.groupId), at: j.at })
    }
    return out
  }, [jobs, h.jobs, h.compares])

  useEffect(() => {
    if (tab === 'chat') bottom.current?.scrollIntoView({ block: 'end' })
  }, [turns.length, tab])

  const send = () => {
    const t = text.trim()
    if (!t) return
    window.watson.ask(t)
    setText('')
    setTab('chat')
  }

  // Hand-off cards saved with a turn show the job as it is now, not as it was when asked.
  const live = (blocks: Block[]): Block[] =>
    blocks.map((b) => {
      if (b.type !== 'delegation') return b
      const now = (s?.jobs ?? []).find((j) => j.jobId === b.data.jobId) ?? h.jobs.find((j) => j.jobId === b.data.jobId)
      return now ? { type: 'delegation', data: now } : b
    })

  // Group the chat by day.
  const groups: { day: string; turns: HistoryTurn[] }[] = []
  for (const t of turns) {
    const day = dayLabel(t.at)
    if (groups[groups.length - 1]?.day !== day) groups.push({ day, turns: [] })
    groups[groups.length - 1].turns.push(t)
  }

  return (
    <div className="home">
      <aside className="home-side">
        <div className="home-brand">
          <Orb phase={s?.phase ?? 'idle'} size={26} />
          <span>Watson</span>
        </div>
        <input className="home-search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <nav>
          <button className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
            <Bubble size={16} /> <span className="nav-label">Conversation</span>
          </button>
          <button className={tab === 'handoffs' ? 'on' : ''} onClick={() => setTab('handoffs')}>
            <Sparkle size={15} /> <span className="nav-label">AI agents</span>
            {activeJobs.length > 0 && <span className="count live">{activeJobs.length}</span>}
          </button>
          <button className={tab === 'widgets' ? 'on' : ''} onClick={() => setTab('widgets')}>
            <Grid size={15} /> <span className="nav-label">Widgets</span>
          </button>
          <button className={tab === 'automations' ? 'on' : ''} onClick={() => setTab('automations')}>
            <Bolt size={15} /> <span className="nav-label">Automations</span>
            {(s?.automations.filter((a) => a.enabled).length ?? 0) + (s?.timers.length ?? 0) > 0 && (
              <span className="count">{(s?.automations.filter((a) => a.enabled).length ?? 0) + (s?.timers.length ?? 0)}</span>
            )}
          </button>
        </nav>
        <div className="home-side-foot">
          <button className="side-link" onClick={() => window.watson.openSettings()}>
            <Gear size={14} /> Settings
          </button>
          <button
            className="side-link"
            onClick={() => {
              if (confirm('Clear Watson’s history on this Mac? This can’t be undone.')) window.watson.clearHistory()
            }}
          >
            <Trash size={14} /> Clear history
          </button>
        </div>
      </aside>

      <main className="home-main">
        {s?.confirm && (
          <div className="needs-you">
            <div className="needs-title">
              <Warning size={14} /> Needs your OK · {s.confirm.title}
            </div>
            <div className="needs-body">{s.confirm.body}</div>
            <div className="needs-actions">
              <button className="btn" onClick={() => window.watson.answerConfirm(s.confirm!.id, false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => window.watson.answerConfirm(s.confirm!.id, true)}>
                {s.confirm.actionLabel}
              </button>
            </div>
          </div>
        )}

        <header className="home-head">
          <h2>{TITLES[tab]}</h2>
        </header>

        {tab === 'automations' ? (
          <div className="home-scroll">
            <Automations s={s} />
          </div>
        ) : tab === 'chat' ? (
          <div className="home-scroll">
            {groups.length === 0 && (
              <div className="home-empty">
                <Orb phase="idle" size={44} />
                <p>{query ? 'Nothing matches that search.' : 'Your requests and Watson’s answers will appear here.'}</p>
                {!query && <p className="muted">Press ⌥ Space and talk, or type below.</p>}
              </div>
            )}
            {groups.map((g) => (
              <section key={g.day}>
                <div className="day">{g.day}</div>
                {g.turns.map((t) => (
                  <div key={t.id} className="turn">
                    {t.you && (
                      <div className="bubble you">
                        {t.you}
                        <span className="stamp">
                          {time(t.at)}
                          {t.mode === 'voice' ? ' · spoken' : ''}
                        </span>
                      </div>
                    )}
                    {t.watson && (
                      <div className={t.watson.startsWith('⚠︎') ? 'bubble watson err' : 'bubble watson'}>
                        <Markdown text={t.watson} />
                      </div>
                    )}
                    {t.blocks && t.blocks.length > 0 && (
                      <div className="turn-blocks">
                        {t.title && <div className="turn-title">{t.title}</div>}
                        <Blocks blocks={live(t.blocks)} />
                      </div>
                    )}
                  </div>
                ))}
              </section>
            ))}
            {s && s.phase !== 'idle' && (
              <div className="turn">
                {s.transcript && <div className="bubble you pending">{s.transcript}</div>}
                <div className="bubble watson pending">{s.reply ? <Markdown text={s.reply} /> : <span className="shimmer">{s.phase === 'listening' ? 'Listening…' : 'Thinking…'}</span>}</div>
              </div>
            )}
            <div ref={bottom} />
          </div>
        ) : tab === 'widgets' ? (
          <div className="home-scroll">
            {widgets.length === 0 && (
              <div className="home-empty">
                <p>{query ? 'Nothing matches that search.' : 'Weather, stocks, your calendar, comparisons and other things you ask to see collect here.'}</p>
              </div>
            )}
            <div className="widget-grid">
              {widgets.map((w) => (
                <div key={w.key} className="widget-tile">
                  <div className="widget-tile-head">
                    <span className="widget-tile-title">{w.title ?? w.you}</span>
                    <span className="stamp">
                      {dayLabel(w.at)} · {time(w.at)}
                    </span>
                  </div>
                  <Blocks blocks={[w.block]} />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="home-scroll">
            {jobs.length === 0 && (
              <div className="home-empty">
                <p>{query ? 'Nothing matches that search.' : 'When Watson hands something to Claude, Grok or another app, it shows up here with the full answer.'}</p>
              </div>
            )}
            {entries.map((e) => {
              if (e.kind === 'group') {
                const live = e.jobs.some((j) => !['done', 'failed'].includes(j.status))
                const names = e.jobs.map((j) => j.agent).join(' · ')
                return (
                  <div key={e.key} className="job-card group">
                    <div className="job-head">
                      <div className="group-marks">
                        {e.jobs.map((j) => (
                          <AgentMark key={j.jobId} name={j.agent} small />
                        ))}
                      </div>
                      <div className="job-main">
                        <div className="job-agent">
                          {names}
                          <span className={`job-status ${live ? 'waiting' : 'done'}`}>
                            {live ? <span className="spinner" /> : <Check size={11} />}
                            {live ? `${e.jobs.filter((j) => j.status === 'done' || j.status === 'reading').length} of ${e.jobs.length} answered` : 'Compared'}
                          </span>
                          <span className="stamp">
                            {dayLabel(e.at)} · {time(e.at)}
                          </span>
                        </div>
                        <div className="job-prompt">“{e.jobs[0]?.prompt}”</div>
                      </div>
                    </div>
                    <CompareCard
                      verdict
                      data={e.compare ? { ...e.compare, jobs: e.jobs } : { groupId: e.key, prompt: e.jobs[0]?.prompt ?? '', jobs: e.jobs }}
                      answers={Object.fromEntries(e.jobs.map((j) => [j.jobId, j.reply]))}
                    />
                  </div>
                )
              }
              const j = e.job
              const key = `${j.jobId}-${j.at}`
              const live = !['done', 'failed'].includes(j.status)
              return (
                <div key={key} className={`job-card ${j.status}`}>
                  <div className="job-head" onClick={() => setOpen(open === key ? null : key)}>
                    <AgentMark name={j.agent} />
                    <div className="job-main">
                      <div className="job-agent">
                        {j.agent}
                        <span className={`job-status ${j.status}`}>
                          {live ? <span className="spinner" /> : j.status === 'done' ? <Check size={11} /> : <Warning size={11} />}
                          {STATUS[j.status] ?? j.status}
                        </span>
                        <span className="stamp">
                          {dayLabel(j.at)} · {time(j.at)}
                        </span>
                      </div>
                      <div className="job-prompt">
                        “{j.prompt}”{j.attachedFrom && <span className="delegation-attached"> + {j.attachedFrom}’s answer</span>}
                      </div>
                      {j.summary && <div className="job-summary">{j.summary}</div>}
                      {j.error && <div className="job-error">{j.error}</div>}
                    </div>
                  </div>
                  {open === key && j.reply && (
                    <div className="job-reply">
                      <Markdown text={j.reply} />
                    </div>
                  )}
                  {j.reply && (
                    <button className="link job-toggle" onClick={() => setOpen(open === key ? null : key)}>
                      {open === key ? 'Hide the full answer' : 'Show the full answer'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <form
          className="home-ask"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask Watson, or “ask Claude to…”" spellCheck={false} />
          <button type="submit" className="send" disabled={!text.trim()} aria-label="Send">
            <ArrowUp size={15} />
          </button>
        </form>
      </main>
    </div>
  )
}
