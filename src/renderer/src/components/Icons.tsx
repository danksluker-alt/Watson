// Small SF Symbols–style icons, drawn as SVG so nothing needs downloading.
import type { CSSProperties } from 'react'
import { skyOf, type Sky } from '@shared/weather'

type P = { size?: number; style?: CSSProperties; className?: string }

const base = (size = 16) => ({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true })

export const Close = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
    <path d="M7 7l10 10M17 7L7 17" />
  </svg>
)

export const Gear = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
)

export const Keyboard = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
    <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
    <path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8" />
  </svg>
)

export const Mic = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} stroke="currentColor" strokeWidth={1.9} strokeLinecap="round">
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
  </svg>
)

export const ArrowUp = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
)

export const Check = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
)

export const Warning = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} fill="currentColor">
    <path d="M10.3 3.9a2 2 0 0 1 3.4 0l8 13.6A2 2 0 0 1 20 20.5H4a2 2 0 0 1-1.7-3l8-13.6zM12 9a1 1 0 0 0-1 1v4a1 1 0 1 0 2 0v-4a1 1 0 0 0-1-1zm0 7.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z" />
  </svg>
)

export const Play = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} fill="currentColor">
    <path d="M7 4.8v14.4a1 1 0 0 0 1.5.9l11.6-7.2a1 1 0 0 0 0-1.8L8.5 3.9A1 1 0 0 0 7 4.8z" />
  </svg>
)

export const Pause = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} fill="currentColor">
    <rect x="6" y="4" width="4.2" height="16" rx="1.3" />
    <rect x="13.8" y="4" width="4.2" height="16" rx="1.3" />
  </svg>
)

export const Next = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} fill="currentColor">
    <path d="M3 6.2v11.6a.9.9 0 0 0 1.4.7l8.1-5.8a.9.9 0 0 0 0-1.4L4.4 5.5A.9.9 0 0 0 3 6.2zM12 6.2v11.6a.9.9 0 0 0 1.4.7l8.1-5.8a.9.9 0 0 0 0-1.4l-8.1-5.8a.9.9 0 0 0-1.4.7z" />
  </svg>
)

export const Prev = ({ size, style, ...p }: P) => <Next size={size} {...p} style={{ ...style, transform: 'scaleX(-1)' }} />

export const Chevron = ({ size, open, ...p }: P & { open?: boolean }) => (
  <svg {...base(size)} {...p} stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ transition: 'transform .25s', transform: open ? 'rotate(90deg)' : 'none' }}>
    <path d="M9 6l6 6-6 6" />
  </svg>
)

export const Sparkle = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} fill="currentColor">
    <path d="M12 2.5c.4 3.9 1.6 6.2 3.2 7.6 1.5 1.3 3.6 1.9 6.3 1.9-2.7 0-4.8.6-6.3 1.9-1.6 1.4-2.8 3.7-3.2 7.6-.4-3.9-1.6-6.2-3.2-7.6C7.3 12.6 5.2 12 2.5 12c2.7 0 4.8-.6 6.3-1.9C10.4 8.7 11.6 6.4 12 2.5z" />
  </svg>
)

export const Pin = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} fill="currentColor">
    <path d="M14.8 2.6a1.2 1.2 0 0 1 1.7 0l4.9 4.9a1.2 1.2 0 0 1 0 1.7l-1.1 1.1a1.2 1.2 0 0 1-1.1.3l-3.6 3.6.2 3.2a1.2 1.2 0 0 1-.4 1l-.9.8a1.2 1.2 0 0 1-1.7 0l-3.3-3.3-4.4 4.4a1 1 0 0 1-1.4-1.4l4.4-4.4-3.3-3.3a1.2 1.2 0 0 1 0-1.7l.8-.9a1.2 1.2 0 0 1 1-.4l3.2.2 3.6-3.6a1.2 1.2 0 0 1 .3-1.1z" />
  </svg>
)

export const Pencil = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z" />
    <path d="M13.5 6.5l4 4" />
  </svg>
)

export const InsertText = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p} stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 7V5h16v2M12 5v14M9 19h6" />
  </svg>
)

// ---------------- Weather (multicolor, like SF Symbols) ----------------

const SUN = '#FFD60A'
const CLOUD = '#FFFFFF'
const RAIN = '#64D2FF'

function SunShape({ cx = 12, cy = 12, r = 4.5 }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={SUN} />
      {Array.from({ length: 8 }).map((_, i) => {
        const a = (i * Math.PI) / 4
        return (
          <line key={i} x1={cx + Math.cos(a) * (r + 2)} y1={cy + Math.sin(a) * (r + 2)} x2={cx + Math.cos(a) * (r + 4)} y2={cy + Math.sin(a) * (r + 4)} stroke={SUN} strokeWidth={1.8} strokeLinecap="round" />
        )
      })}
    </g>
  )
}

const CloudShape = ({ y = 0, fill = CLOUD }: { y?: number; fill?: string }) => (
  <path transform={`translate(0 ${y})`} d="M7.5 18.5h9.8a4.2 4.2 0 0 0 .6-8.4A5.6 5.6 0 0 0 7.1 9.4a4.6 4.6 0 0 0 .4 9.1z" fill={fill} />
)

export function WeatherIcon({ code, isDay = true, size = 24 }: { code: number; isDay?: boolean; size?: number }) {
  const sky: Sky = skyOf(code)
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {sky === 'clear' && (isDay ? <SunShape /> : <path d="M15.5 3.5A8.5 8.5 0 1 0 20.5 15a7 7 0 0 1-5-11.5z" fill="#FFFFFF" />)}
      {sky === 'partly' && (
        <>
          {isDay ? <SunShape cx={15} cy={8} r={3.4} /> : <path d="M17.5 2.5a5.5 5.5 0 1 0 4 8 4.6 4.6 0 0 1-4-8z" fill="#FFFFFF" opacity={0.9} />}
          <CloudShape y={2} />
        </>
      )}
      {(sky === 'cloudy' || sky === 'fog') && <CloudShape y={-1} fill={sky === 'fog' ? '#D1D1D6' : CLOUD} />}
      {sky === 'fog' && <path d="M5 20.5h14M7 23h10" stroke="#D1D1D6" strokeWidth={1.6} strokeLinecap="round" />}
      {(sky === 'rain' || sky === 'drizzle' || sky === 'storm') && (
        <>
          <CloudShape y={-4} />
          {sky !== 'storm' ? (
            <path d={sky === 'rain' ? 'M8 17l-1 3M12 17l-1 3M16 17l-1 3' : 'M9 17.5l-.6 1.6M13 17.5l-.6 1.6M17 17.5l-.6 1.6'} stroke={RAIN} strokeWidth={1.8} strokeLinecap="round" />
          ) : (
            <path d="M12.5 15l-2.5 4h3l-2 4" stroke={SUN} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          )}
        </>
      )}
      {sky === 'snow' && (
        <>
          <CloudShape y={-4} />
          {[8, 12, 16].map((x) => (
            <circle key={x} cx={x} cy={19} r={1.1} fill="#FFFFFF" />
          ))}
        </>
      )}
    </svg>
  )
}
