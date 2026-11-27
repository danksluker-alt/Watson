import type { StockData, StockRange } from '@shared/types'
import { LineChart } from '../components/Charts'

const RANGES: StockRange[] = ['1D', '1W', '1M', '3M', '1Y']

function label(t: number, range: StockRange) {
  const d = new Date(t)
  if (range === '1D') return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (range === '1W') return d.toLocaleDateString([], { weekday: 'short', hour: 'numeric' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function StockWidget({ data }: { data: StockData }) {
  const up = data.change >= 0
  const color = up ? '#30D158' : '#FF453A'
  const sign = up ? '+' : ''
  const money = (v: number) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const base = data.range === '1D' ? data.price - data.change : undefined
  return (
    <div className="card stock">
      <div className="stock-head">
        <div>
          <div className="stock-symbol">{data.symbol}</div>
          <div className="stock-name">{data.name}</div>
        </div>
        <div className="stock-price">
          <div className="stock-value">
            {money(data.price)} <small>{data.currency}</small>
          </div>
          <span className="stock-change" style={{ background: color }}>
            {sign}
            {money(data.change)} ({sign}
            {data.changePct.toFixed(2)}%)
          </span>
        </div>
      </div>
      <div className="segmented">
        {RANGES.map((r) => (
          <button key={r} className={r === data.range ? 'on' : ''} onClick={() => window.watson.stockRange(data.symbol, r)}>
            {r}
          </button>
        ))}
      </div>
      {data.points.length > 1 ? (
        <LineChart
          labels={data.points.map((p) => label(p.t, data.range))}
          series={[{ name: data.symbol, values: data.points.map((p) => p.v), color }]}
          baseline={base}
          formatValue={money}
          height={160}
        />
      ) : (
        <div className="muted small">No chart data for this range.</div>
      )}
      <div className="stock-foot muted small">
        {data.marketState === 'REGULAR' ? 'Market open' : data.marketState ? 'Market closed' : ''} · {data.source}
      </div>
    </div>
  )
}
