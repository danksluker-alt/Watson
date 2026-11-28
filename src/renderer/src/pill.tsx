// What the resting pill shows, and holding it to move it around.
import { useEffect, useRef, useState } from 'react'
import type { Glance } from '@shared/types'

// ---------------- Glance ----------------

const WEATHER_ICON = (code: number, isDay: boolean) =>
  code === 0 ? (isDay ? '☀︎' : '☾') : code <= 3 ? (isDay ? '⛅︎' : '☁︎') : code <= 48 ? '☁︎' : code <= 67 || (code >= 80 && code <= 82) ? '☂︎' : code <= 77 || code === 85 || code === 86 ? '❄︎' : '⚡︎'

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

function eventText(e: NonNullable<Glance['nextEvent']>, now: number): string {
  const title = e.title.length > 22 ? `${e.title.slice(0, 21)}…` : e.title
  if (e.start <= now) return `${title} · until ${clock(e.end)}`
  const min = Math.round((e.start - now) / 60_000)
  return `${title} · ${min < 1 ? 'now' : min < 60 ? `in ${min}m` : clock(e.start)}`
}

export type GlanceItem = { key: string; text: string; tone?: 'event' | 'weather' }

/** The facts the pill rotates through, freshest first. Empty means "show the name". */
export function useGlance(glance: Glance): GlanceItem | null {
  const [now, setNow] = useState(() => Date.now())
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    const r = setInterval(() => setI((n) => n + 1), 7000)
    return () => {
      clearInterval(t)
      clearInterval(r)
    }
  }, [])
  const items: GlanceItem[] = []
  if (glance.nextEvent && glance.nextEvent.end > now) items.push({ key: 'event', text: eventText(glance.nextEvent, now), tone: 'event' })
  if (glance.weather) items.push({ key: 'weather', text: `${WEATHER_ICON(glance.weather.code, glance.weather.isDay)} ${glance.weather.temp}°`, tone: 'weather' })
  if (!items.length) return null
  // An event starting within 15 minutes stays put instead of rotating.
  const soon = glance.nextEvent && glance.nextEvent.start - now < 15 * 60_000
  return soon ? items[0] : items[i % items.length]
}

/** Pill width for a label: roughly the text's width plus the orb and padding. */
export const pillWidth = (text: string) => Math.round(Math.max(118, Math.min(300, 52 + text.length * 7.1)))

// ---------------- Hold to move ----------------

const HOLD_MS = 420

/**
 * Press: a short press is a click (talk). Holding ~0.4 s lifts the pill so it can be dragged;
 * the main process moves the window with the pointer and saves the spot on release.
 */
export function useHoldToMove(onClick: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [holding, setHolding] = useState(false)
  const held = useRef(false)

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    held.current = false
    timer.current = setTimeout(() => {
      held.current = true
      setHolding(true)
      window.watson.setArranging(true)
      window.watson.pillDrag('start')
    }, HOLD_MS)
  }
  const up = (e: React.PointerEvent) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
    if (held.current) {
      window.watson.pillDrag('end')
      setHolding(false)
    } else onClick()
    held.current = false
  }
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (held.current) window.watson.pillDrag('end')
    held.current = false
    setHolding(false)
  }
  return { holding, handlers: { onPointerDown: down, onPointerUp: up, onPointerCancel: cancel } }
}
