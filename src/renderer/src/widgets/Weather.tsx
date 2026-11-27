import type { WeatherData } from '@shared/types'
import { skyLabel, skyOf } from '@shared/weather'
import { WeatherIcon } from '../components/Icons'

function background(code: number, isDay: boolean): string {
  const sky = skyOf(code)
  if (!isDay) return 'linear-gradient(180deg, #0B1430 0%, #1C2B5A 60%, #2B3A6B 100%)'
  switch (sky) {
    case 'clear':
      return 'linear-gradient(180deg, #2F80ED 0%, #56A0F5 55%, #8CC4FA 100%)'
    case 'partly':
      return 'linear-gradient(180deg, #3D7CC9 0%, #6E9FD6 60%, #9DBDE0 100%)'
    case 'rain':
    case 'drizzle':
    case 'storm':
      return 'linear-gradient(180deg, #3A4756 0%, #556577 60%, #6D7D8F 100%)'
    case 'snow':
      return 'linear-gradient(180deg, #6F8BA8 0%, #9DB2C7 60%, #C3D1DF 100%)'
    default:
      return 'linear-gradient(180deg, #56677A 0%, #7A8A9C 60%, #9AA8B6 100%)'
  }
}

export function WeatherWidget({ data }: { data: WeatherData }) {
  const weekMin = Math.min(...data.daily.map((d) => d.low))
  const weekMax = Math.max(...data.daily.map((d) => d.high))
  const span = weekMax - weekMin || 1
  return (
    <div className="weather" style={{ background: background(data.now.code, data.now.isDay) }}>
      <div className="weather-head">
        <div>
          <div className="weather-place">{data.place}</div>
          <div className="weather-temp">{data.now.temp}°</div>
        </div>
        <div className="weather-summary">
          <WeatherIcon code={data.now.code} isDay={data.now.isDay} size={44} />
          <div className="weather-cond">{skyLabel(data.now.code, data.now.isDay)}</div>
          <div className="weather-hl">
            H:{data.today.high}° L:{data.today.low}°
          </div>
        </div>
      </div>
      <div className="weather-meta">
        Feels like {data.now.feelsLike}° · Humidity {data.now.humidity}% · Wind {data.now.wind} {data.unit === 'F' ? 'mph' : 'km/h'}
        {data.today.rainChance > 0 && ` · ${data.today.rainChance}% rain`}
      </div>
      <div className="weather-hours">
        {data.hourly.map((h, i) => (
          <div key={i} className="weather-hour">
            <span className="muted-light">{h.time}</span>
            <WeatherIcon code={h.code} isDay={h.isDay} size={22} />
            <span>{h.temp}°</span>
          </div>
        ))}
      </div>
      <div className="weather-days">
        {data.daily.slice(0, 6).map((d, i) => (
          <div key={i} className="weather-day">
            <span className="weather-dayname">{d.day}</span>
            <span className="weather-dayicon">
              <WeatherIcon code={d.code} size={20} />
              {d.rainChance >= 30 && <small>{d.rainChance}%</small>}
            </span>
            <span className="muted-light weather-low">{d.low}°</span>
            <span className="range-track">
              <span
                className="range-fill"
                style={{ left: `${((d.low - weekMin) / span) * 100}%`, right: `${100 - ((d.high - weekMin) / span) * 100}%` }}
              />
            </span>
            <span className="weather-high">{d.high}°</span>
          </div>
        ))}
      </div>
    </div>
  )
}
