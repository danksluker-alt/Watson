// What the resting pill shows, and holding it to move it around.
import { useEffect, useRef, useState } from 'react'
import type { DelegationData, Glance, TimerItem, UIState } from '@shared/types'
import { countdown } from './widgets/Timers'

// ---------------- Live status ----------------
//
// At rest the pill is a small circle. It grows into a pill only while something is happening:
// an AI working on a hand-off (and how long it has been at it), a comparison, a running timer,
// an event about to start, or an answer that just came in.

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const short = (t: string, n = 20) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

export type LiveTone = 'job' | 'timer' | 'event' | 'done' | 'attention' | 'unsent'
export type LiveItem = { key: string; text: string; tone: LiveTone }

const RECENT_MS = 12_000

function jobItems(jobs: DelegationData[], now: number): LiveItem[] {
  const items: LiveItem[] = []
  const groups = new Map<string, DelegationData[]>()
  for (const j of jobs) {
    const k = j.groupId ?? j.jobId
    groups.set(k, [...(groups.get(k) ?? []), j])
  }
  for (const [key, g] of groups) {
    const active = g.filter((j) => !['done', 'failed'].includes(j.status))
    const recent = g.every((j) => ['done', 'failed'].includes(j.status)) && g.some((j) => j.endedAt && now - j.endedAt < RECENT_MS)
    const names = g.map((j) => j.agent).join(' + ')
    const since = elapsed(now - Math.min(...g.map((j) => j.startedAt ?? now)))
    if (g.length > 1) {
      if (active.some((j) => j.status === 'confirming')) items.push({ key, text: `${names} · needs your OK`, tone: 'attention' })
      else if (active.length) {
        const inCount = g.filter((j) => j.status === 'reading' || j.status === 'done').length
        items.push({ key, text: inCount === g.length ? `Comparing ${names}` : `${names} · ${inCount} of ${g.length} in · ${since}`, tone: 'job' })
      } else if (recent) items.push({ key, text: `${names} compared`, tone: 'done' })
      continue
    }
    const j = g[0]
    if (j.status === 'confirming') items.push({ key, text: `${j.agent} · needs your OK`, tone: 'attention' })
    else if (j.status === 'sending') items.push({ key, text: `Typing into ${j.agent}`, tone: 'job' })
    else if (j.status === 'waiting') items.push({ key, text: `${j.agent} is ${j.reply ? 'writing' : 'thinking'} · ${since}`, tone: 'job' })
    else if (j.status === 'reading') items.push({ key, text: `Reading ${j.agent}’s answer`, tone: 'job' })
    else if (recent) items.push({ key, text: j.status === 'done' ? `${j.agent} answered` : `${j.agent} didn’t answer`, tone: j.status === 'done' ? 'done' : 'attention' })
  }
  return items
}

function timerItems(timers: TimerItem[], now: number): LiveItem[] {
  return timers
    .filter((t) => t.endsAt > now && (t.kind === 'timer' || t.endsAt - now < 30 * 60_000))
    .slice(0, 2)
    .map((t) => ({
      key: t.id,
      text: t.kind === 'timer' ? `${t.label ? short(t.label, 14) : 'Timer'} · ${countdown(t.endsAt - now)}` : `${t.label ? short(t.label, 14) : 'Alarm'} at ${clock(t.endsAt)}`,
      tone: 'timer' as const,
    }))
}

function eventItem(e: NonNullable<Glance['nextEvent']>, now: number): LiveItem | null {
  const min = Math.round((e.start - now) / 60_000)
  if (min > 10 || now - e.start > 5 * 60_000 || e.end < now) return null
  return { key: 'event', text: `${short(e.title, 22)} · ${min < 1 ? 'now' : `in ${min}m`}`, tone: 'event' }
}

/** What the pill should say right now, or null to rest as a circle. Several things take turns. */
export function useLive(s: UIState | null): LiveItem | null {
  const [now, setNow] = useState(() => Date.now())
  const [turn, setTurn] = useState(0)
  const busy = Boolean(s && (s.jobs.some((j) => !['done', 'failed'].includes(j.status) || (j.endedAt && Date.now() - j.endedAt < RECENT_MS)) || s.timers.length))
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), busy ? 1000 : 15_000)
    return () => clearInterval(t)
  }, [busy])
  useEffect(() => {
    const r = setInterval(() => setTurn((n) => n + 1), 4000)
    return () => clearInterval(r)
  }, [])
  if (!s) return null
  const draft = s.draftParked && s.draft?.text.trim() ? [{ key: 'draft', text: short(s.draft.text.trim(), 26), tone: 'unsent' as const }] : []
  const items = [
    ...draft,
    ...jobItems(s.jobs, now),
    ...timerItems(s.timers, now),
    ...(s.glance.nextEvent ? [eventItem(s.glance.nextEvent, now)].filter((x): x is LiveItem => Boolean(x)) : []),
  ]
  if (!items.length) return null
  // Something that needs the user stays put instead of taking turns.
  return items.find((i) => i.tone === 'attention') ?? items[turn % items.length]
}

/** Pill width for a label: roughly the text's width plus the orb and padding. */
export const pillWidth = (text: string) => Math.round(Math.max(118, Math.min(320, 58 + text.length * 7.1)))

// ---------------- Hold to move ----------------

const HOLD_MS = 420

/**
 * Press: a short press is a click (talk). Holding ~0.4 s lifts the pill so it can be dragged;
 * the main process moves the window with the pointer and saves the spot on release.
 */
export function useHoldToMove(onClick: () => void, active: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [holding, setHolding] = useState(false)
  const held = useRef(false)
  const pressed = useRef(false)
  const windowUp = useRef<(() => void) | null>(null)

  const finish = (click: boolean) => {
    if (!pressed.current) return
    pressed.current = false
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (windowUp.current) window.removeEventListener('pointerup', windowUp.current)
    windowUp.current = null
    if (held.current) {
      window.watson.pillDrag('end')
      setHolding(false)
    } else if (click) onClick()
    held.current = false
  }
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    held.current = false
    pressed.current = true
    // The release can land somewhere else if the pill changes under the pointer (an answer
    // opening the panel mid-click): still end the hold, but don't count it as a click.
    windowUp.current = () => cancelRef.current()
    window.addEventListener('pointerup', windowUp.current)
    timer.current = setTimeout(() => {
      if (!pressed.current) return
      held.current = true
      setHolding(true)
      window.watson.setArranging(true)
      window.watson.pillDrag('start')
    }, HOLD_MS)
  }
  const up = (e: React.PointerEvent) => {
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    finish(true)
  }
  const cancel = () => finish(false)

  // The pill turned into something else (the panel opened): drop any hold in progress.
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  useEffect(() => {
    if (!active) cancelRef.current()
  }, [active])
  useEffect(() => () => cancelRef.current(), [])

  return { holding, handlers: { onPointerDown: down, onPointerUp: up, onPointerCancel: cancel } }
}
