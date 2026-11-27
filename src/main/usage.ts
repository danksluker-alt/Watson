// Tracks what Watson spends on the API today, so the daily budget can stop it.
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

// $ per million tokens (Claude API list prices).
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
}
const WEB_SEARCH_USD = 0.01

type UsageLike = {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  server_tool_use?: { web_search_requests?: number | null } | null
}

type Day = { date: string; usd: number; calls: number }

const file = () => path.join(app.getPath('userData'), 'usage.json')
const today = () => new Date().toLocaleDateString('en-CA')

function load(): Day {
  try {
    const d = JSON.parse(fs.readFileSync(file(), 'utf8')) as Day
    if (d.date === today()) return d
  } catch {
    /* first run */
  }
  return { date: today(), usd: 0, calls: 0 }
}

let day = load()

export function costOf(model: string, u: UsageLike): number {
  const p = PRICES[model] ?? PRICES['claude-sonnet-5-5']
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.output_tokens ?? 0) * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
      1_000_000 +
    (u.server_tool_use?.web_search_requests ?? 0) * WEB_SEARCH_USD
  )
}

export function record(model: string, u: UsageLike): number {
  if (day.date !== today()) day = { date: today(), usd: 0, calls: 0 }
  day.usd += costOf(model, u)
  day.calls += 1
  try {
    fs.writeFileSync(file(), JSON.stringify(day))
  } catch {
    /* not fatal */
  }
  return day.usd
}

export function spentToday(): number {
  if (day.date !== today()) day = { date: today(), usd: 0, calls: 0 }
  return day.usd
}
