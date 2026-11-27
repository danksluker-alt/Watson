// World clock: each city's time zone comes from Open-Meteo's geocoder.
import type { ClockData } from '@shared/types'
import { geocode } from './weather'

export async function worldClock(cities: string[]): Promise<ClockData> {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  const list: ClockData['cities'] = [{ name: 'Local', timeZone: local }]
  for (const city of cities.slice(0, 5)) {
    const g = await geocode(city)
    if (g.timezone) list.push({ name: g.name, timeZone: g.timezone })
  }
  return { cities: list }
}

export function clockForModel(c: ClockData) {
  const now = new Date()
  return {
    times: c.cities.map((x) => `${x.name}: ${now.toLocaleTimeString('en-US', { timeZone: x.timeZone, hour: 'numeric', minute: '2-digit', weekday: 'short' })}`),
    widget: 'shown to the user already',
  }
}
