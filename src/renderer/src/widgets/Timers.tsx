// Timers and alarms, in the style of the Clock app: an orange ring that empties as the
// time runs out. Counts down locally; the main process only sends the end times.
import { useEffect, useState } from 'react'
import type { TimerItem, TimersData } from '@shared/types'
import { Close } from '../components/Icons'

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** 4:05, 1:02:03 */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** 12 sec, 10 min, 1 hr 30 min */
function shortDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return [h && `${h} hr`, m && `${m} min`, !h && s && `${s} sec`].filter(Boolean).join(' ') || '0 sec'
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function inWords(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? `in ${h}h${m ? ` ${m}m` : ''}` : `in ${m} min`
}

function Ring({ fraction, size = 54, color = '#FF9F0A' }: { fraction: number; size?: number; color?: string }) {
  const r = size / 2 - 4
  const c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="timer-ring" aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} stroke="rgba(255,159,10,0.18)" strokeWidth="5" fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth="5"
        fill="none"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(1, fraction)))}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  )
}

function Row({ t, now, onCancel, highlight }: { t: TimerItem; now: number; onCancel: () => void; highlight: boolean }) {
  const left = t.endsAt - now
  const total = Math.max(1, t.endsAt - t.createdAt)
  return (
    <div className={`timer-row${highlight ? ' highlight' : ''}`}>
      {t.kind === 'alarm' ? (
        <span className="alarm-glyph" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#FF9F0A" strokeWidth="1.9" strokeLinecap="round">
            <circle cx="12" cy="13" r="7.5" />
            <path d="M12 9.5V13l2.3 1.6M4.5 5.5 7 3.5M19.5 5.5 17 3.5" />
          </svg>
        </span>
      ) : (
        <Ring fraction={left / total} />
      )}
      <div className="timer-main">
        <div className="timer-value">{t.kind === 'alarm' ? clock(t.endsAt) : countdown(left)}</div>
        <div className="timer-label">
          {t.label || (t.kind === 'alarm' ? 'Alarm' : 'Timer')}
          <span className="timer-meta"> · {t.kind === 'alarm' ? inWords(left) : `ends ${clock(t.endsAt)}`}</span>
        </div>
      </div>
      <button className="timer-cancel" onClick={onCancel} aria-label={`Cancel ${t.label || t.kind}`} title="Cancel">
        <Close size={12} />
      </button>
    </div>
  )
}

export function TimersWidget({ data }: { data: TimersData }) {
  const now = useNow(250)
  const [cancelled, setCancelled] = useState<string[]>([])
  const items = data.items.filter((t) => !cancelled.includes(t.id) && t.endsAt > now - 1000)
  return (
    <div className="aw timers-w">
      <div className="timers-head">
        <span className="timers-title">Timers</span>
        <span className="muted small">{items.length ? `${items.length} running` : 'None running'}</span>
      </div>
      {items.length === 0 && <div className="timers-empty">Say “set a timer for 10 minutes”.</div>}
      {items.map((t) => (
        <Row
          key={t.id}
          t={t}
          now={now}
          highlight={data.highlight === t.id}
          onCancel={() => {
            setCancelled((c) => [...c, t.id])
            window.watson.cancelTimer(t.id)
          }}
        />
      ))}
    </div>
  )
}

/** Shown in the panel while a timer or alarm is going off. */
export function RingingCard({ t }: { t: TimerItem }) {
  return (
    <div className="card ringing">
      <span className="ringing-glyph" aria-hidden>
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#FF9F0A" strokeWidth="1.9" strokeLinecap="round">
          <circle cx="12" cy="13" r="7.5" />
          <path d="M12 9.5V13l2.3 1.6M4.5 5.5 7 3.5M19.5 5.5 17 3.5" />
        </svg>
      </span>
      <div className="ringing-main">
        <div className="ringing-title">{t.label ? t.label.charAt(0).toUpperCase() + t.label.slice(1) : t.kind === 'alarm' ? 'Alarm' : 'Timer'}</div>
        <div className="ringing-sub">{t.kind === 'alarm' ? `It's ${clock(t.endsAt)}` : `${shortDuration(t.durationSec)} timer is done`}</div>
      </div>
      <button className="btn primary ringing-stop" onClick={() => window.watson.stopRinging()}>
        Stop
      </button>
    </div>
  )
}
