// One place that turns a widget kind + parameters into a panel block.
// Used by the brain's tools, by pinned widgets on refresh, and by the Pin button.
import type { Block, MusicApp, StockRange, WidgetKind } from '@shared/types'
import type { Helper } from './helper'
import { getSettings } from './settings'
import { battery } from './tools/battery'
import { getCalendar, getReminders } from './tools/calendar'
import { worldClock } from './tools/clock'
import { nowPlaying } from './tools/music'
import { recentNotes, searchNotes } from './tools/notes'
import { getStock } from './tools/stocks'
import { getWeather } from './tools/weather'

export type WidgetParams = Record<string, string>

export async function buildWidget(helper: Helper, kind: WidgetKind, params: WidgetParams): Promise<Block | null> {
  const settings = getSettings()
  switch (kind) {
    case 'weather':
      return { type: 'weather', data: await getWeather(params.location || settings.homeCity, settings.units) }
    case 'stock':
      return { type: 'stock', data: await getStock(params.symbol || 'AAPL', (params.range as StockRange) || '1D') }
    case 'calendar':
      return { type: 'calendar', data: await getCalendar(helper, params.range || 'today') }
    case 'reminders':
      return { type: 'reminders', data: await getReminders(helper, params.list || undefined) }
    case 'notes':
      return { type: 'notes', data: params.query ? await searchNotes(params.query) : await recentNotes(6) }
    case 'clock':
      return { type: 'clock', data: await worldClock((params.cities || '').split(',').map((c) => c.trim()).filter(Boolean)) }
    case 'battery':
      return { type: 'battery', data: await battery() }
    case 'nowPlaying': {
      const np = await nowPlaying((params.app as MusicApp) || settings.musicApp)
      return np ? { type: 'nowPlaying', data: np } : null
    }
  }
}

/** The parameters that rebuild a block later (for pinning it to the screen). */
export function paramsOf(block: Block): { kind: WidgetKind; params: WidgetParams } | null {
  switch (block.type) {
    case 'weather':
      return { kind: 'weather', params: { location: block.data.place } }
    case 'stock':
      return { kind: 'stock', params: { symbol: block.data.symbol, range: block.data.range } }
    case 'calendar':
      return { kind: 'calendar', params: { range: block.data.range === 'tomorrow' ? 'today' : block.data.range } }
    case 'reminders':
      return { kind: 'reminders', params: block.data.list ? { list: block.data.list } : {} }
    case 'notes':
      return { kind: 'notes', params: block.data.query ? { query: block.data.query } : {} }
    case 'clock':
      return { kind: 'clock', params: { cities: block.data.cities.filter((c) => c.name !== 'Local').map((c) => c.name).join(',') } }
    case 'battery':
      return { kind: 'battery', params: {} }
    case 'nowPlaying':
      return { kind: 'nowPlaying', params: { app: block.data.app } }
    default:
      return null
  }
}

/** How often a pinned widget refreshes, in seconds. */
export const REFRESH: Record<WidgetKind, number> = {
  weather: 900,
  stock: 120,
  calendar: 300,
  reminders: 300,
  notes: 600,
  clock: 3600,
  battery: 120,
  nowPlaying: 5,
}
