// Line and bar charts in plain SVG, styled like Apple's Stocks and Health apps.
import { useId, useMemo, useRef, useState } from 'react'

const PALETTE = ['#0A84FF', '#30D158', '#FF9F0A', '#BF5AF2', '#FF375F', '#64D2FF']

type Pt = { x: number; y: number }

function smoothPath(pts: Pt[]): string {
  if (pts.length < 2) return pts.length ? `M${pts[0].x},${pts[0].y}` : ''
  let d = `M${pts[0].x},${pts[0].y}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`
  }
  return d
}

export function niceNumber(v: number): string {
  const a = Math.abs(v)
  if (Number.isInteger(v) && a < 1e4) return v.toLocaleString()
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`
  if (a >= 100) return v.toFixed(0)
  return v.toFixed(a < 10 ? 2 : 1)
}

export type Series = { name: string; values: number[]; color?: string }

export function LineChart({
  labels,
  series,
  height = 150,
  baseline,
  formatValue = niceNumber,
  area = true,
}: {
  labels: string[]
  series: Series[]
  height?: number
  baseline?: number
  formatValue?: (v: number) => string
  area?: boolean
}) {
  const id = useId()
  const box = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const W = 560
  const H = height
  const pad = { t: 10, b: 20, l: 4, r: 44 }
  const all = series.flatMap((s) => s.values).concat(baseline ?? [])
  const min = Math.min(...all)
  const max = Math.max(...all)
  const span = max - min || 1
  const n = Math.max(...series.map((s) => s.values.length))
  const x = (i: number) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b)
  const ticks = useMemo(() => [max, min + span / 2, min], [max, min, span])

  const onMove = (e: React.MouseEvent) => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    const px = ((e.clientX - r.left) / r.width) * W
    const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (n - 1))
    setHover(Math.max(0, Math.min(n - 1, i)))
  }

  return (
    <div className="chart">
      <svg ref={box} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          {series.map((s, si) => (
            <linearGradient key={si} id={`${id}-g${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color ?? PALETTE[si % PALETTE.length]} stopOpacity={0.32} />
              <stop offset="100%" stopColor={s.color ?? PALETTE[si % PALETTE.length]} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={W - pad.r + 6} y={y(t) + 4} className="axis">
              {formatValue(t)}
            </text>
          </g>
        ))}
        {baseline !== undefined && <line x1={pad.l} x2={W - pad.r} y1={y(baseline)} y2={y(baseline)} className="baseline" />}
        {series.map((s, si) => {
          const pts = s.values.map((v, i) => ({ x: x(i), y: y(v) }))
          const d = smoothPath(pts)
          const color = s.color ?? PALETTE[si % PALETTE.length]
          return (
            <g key={si}>
              {area && series.length === 1 && pts.length > 1 && (
                <path d={`${d} L${pts[pts.length - 1].x},${H - pad.b} L${pts[0].x},${H - pad.b} Z`} fill={`url(#${id}-g${si})`} />
              )}
              <path d={d} stroke={color} strokeWidth={2.2} fill="none" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            </g>
          )
        })}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="crosshair" />
            {series.map((s, si) =>
              s.values[hover] !== undefined ? (
                <circle key={si} cx={x(hover)} cy={y(s.values[hover])} r={4} fill={s.color ?? PALETTE[si % PALETTE.length]} stroke="#000" strokeWidth={1.5} />
              ) : null,
            )}
          </g>
        )}
        {[0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i).map((i) => (
          <text key={i} x={x(i)} y={H - 4} className="axis" textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
            {labels[i] ?? ''}
          </text>
        ))}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <div className="chart-tip-label">{labels[hover]}</div>
          {series.map((s, si) => (
            <div key={si} className="chart-tip-row">
              {series.length > 1 && <span className="dot" style={{ background: s.color ?? PALETTE[si % PALETTE.length] }} />}
              {series.length > 1 && <span className="muted">{s.name}</span>}
              <strong>{s.values[hover] !== undefined ? formatValue(s.values[hover]) : '–'}</strong>
            </div>
          ))}
        </div>
      )}
      {series.length > 1 && (
        <div className="legend">
          {series.map((s, si) => (
            <span key={si}>
              <span className="dot" style={{ background: s.color ?? PALETTE[si % PALETTE.length] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function BarChart({ labels, series, height = 160 }: { labels: string[]; series: Series[]; height?: number }) {
  const max = Math.max(...series.flatMap((s) => s.values), 0) || 1
  return (
    <div className="bar-chart" style={{ height }}>
      {labels.map((label, i) => (
        <div className="bar-col" key={i} title={`${label}: ${series.map((s) => `${s.name} ${niceNumber(s.values[i] ?? 0)}`).join(', ')}`}>
          <div className="bar-stack">
            {series.map((s, si) => (
              <div
                key={si}
                className="bar"
                style={{ height: `${((s.values[i] ?? 0) / max) * 100}%`, background: s.color ?? PALETTE[si % PALETTE.length], animationDelay: `${i * 30}ms` }}
              />
            ))}
          </div>
          <div className="bar-value">{niceNumber(series[0]?.values[i] ?? 0)}</div>
          <div className="bar-label">{label}</div>
        </div>
      ))}
    </div>
  )
}
