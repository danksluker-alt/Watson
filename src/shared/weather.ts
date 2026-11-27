// WMO weather codes used by Open-Meteo.
export type Sky = 'clear' | 'partly' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm'

export function skyOf(code: number): Sky {
  if (code === 0) return 'clear'
  if (code <= 2) return 'partly'
  if (code === 3) return 'cloudy'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'drizzle'
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain'
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow'
  if (code >= 95) return 'storm'
  return 'cloudy'
}

const LABELS: Record<Sky, string> = {
  clear: 'Clear',
  partly: 'Partly Cloudy',
  cloudy: 'Cloudy',
  fog: 'Foggy',
  drizzle: 'Drizzle',
  rain: 'Rain',
  snow: 'Snow',
  storm: 'Thunderstorms',
}

export function skyLabel(code: number, isDay = true): string {
  const sky = skyOf(code)
  if (sky === 'clear') return isDay ? 'Sunny' : 'Clear'
  return LABELS[sky]
}
