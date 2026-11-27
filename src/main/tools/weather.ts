// Weather from Open-Meteo: free, no API key.
import type { WeatherData } from '@shared/types'
import { skyLabel } from '@shared/weather'

// WATSON_MOCK_DATA points every data source at a local mock server (tests only).
const GEO = process.env.WATSON_MOCK_DATA ?? 'https://geocoding-api.open-meteo.com'
const METEO = process.env.WATSON_MOCK_DATA ?? 'https://api.open-meteo.com'

type Geo = { name: string; admin1?: string; country_code?: string; latitude: number; longitude: number; timezone?: string }

export async function geocode(place: string): Promise<Geo> {
  const url = `${GEO}/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(place)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Couldn't look up "${place}".`)
  const json = (await res.json()) as { results?: Geo[] }
  const hit = json.results?.[0]
  if (!hit) throw new Error(`I couldn't find a place called "${place}".`)
  return hit
}

export async function getWeather(place: string, unit: 'C' | 'F'): Promise<WeatherData> {
  // "Lisbon, Portugal" geocodes badly; the first part is usually enough.
  let geo: Geo
  try {
    geo = await geocode(place)
  } catch (e) {
    const head = place.split(',')[0].trim()
    if (head === place) throw e
    geo = await geocode(head)
  }
  const params = new URLSearchParams({
    latitude: String(geo.latitude),
    longitude: String(geo.longitude),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,is_day',
    hourly: 'temperature_2m,weather_code,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '7',
    temperature_unit: unit === 'F' ? 'fahrenheit' : 'celsius',
    wind_speed_unit: unit === 'F' ? 'mph' : 'kmh',
  })
  const res = await fetch(`${METEO}/v1/forecast?${params}`)
  if (!res.ok) throw new Error('The weather service is not answering right now.')
  const j = (await res.json()) as {
    current: { time: string; temperature_2m: number; apparent_temperature: number; weather_code: number; wind_speed_10m: number; relative_humidity_2m: number; is_day: number }
    hourly: { time: string[]; temperature_2m: number[]; weather_code: number[]; is_day: number[] }
    daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[] }
  }
  const nowIdx = Math.max(0, j.hourly.time.findIndex((t) => t >= j.current.time.slice(0, 13)))
  const hourly = j.hourly.time.slice(nowIdx, nowIdx + 12).map((t, i) => ({
    time: i === 0 ? 'Now' : formatHour(t),
    temp: Math.round(j.hourly.temperature_2m[nowIdx + i]),
    code: j.hourly.weather_code[nowIdx + i],
    isDay: j.hourly.is_day[nowIdx + i] === 1,
  }))
  const daily = j.daily.time.map((d, i) => ({
    day: i === 0 ? 'Today' : new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' }),
    high: Math.round(j.daily.temperature_2m_max[i]),
    low: Math.round(j.daily.temperature_2m_min[i]),
    code: j.daily.weather_code[i],
    rainChance: j.daily.precipitation_probability_max[i] ?? 0,
  }))
  return {
    place: geo.name,
    unit,
    now: {
      temp: Math.round(j.current.temperature_2m),
      feelsLike: Math.round(j.current.apparent_temperature),
      code: j.current.weather_code,
      isDay: j.current.is_day === 1,
      humidity: j.current.relative_humidity_2m,
      wind: Math.round(j.current.wind_speed_10m),
    },
    today: { high: daily[0].high, low: daily[0].low, rainChance: daily[0].rainChance },
    hourly,
    daily,
  }
}

function formatHour(iso: string): string {
  const h = Number(iso.slice(11, 13))
  const suffix = h < 12 ? 'AM' : 'PM'
  return `${h % 12 === 0 ? 12 : h % 12}${suffix}`
}

/** Compact version for the model, so it can speak one sentence about it. */
export function weatherForModel(w: WeatherData) {
  return {
    place: w.place,
    now: `${w.now.temp}°${w.unit}, ${skyLabel(w.now.code, w.now.isDay)}, feels like ${w.now.feelsLike}°`,
    today: `high ${w.today.high}°, low ${w.today.low}°, ${w.today.rainChance}% chance of rain`,
    next_days: w.daily.slice(1, 4).map((d) => `${d.day} ${d.high}/${d.low} ${skyLabel(d.code)} ${d.rainChance}% rain`),
    widget: 'shown to the user already',
  }
}
