// Stock quotes and price history. Uses Yahoo Finance's public chart endpoint
// (no key, unofficial, for personal use) and falls back to Stooq's daily CSV.
import type { StockData, StockRange } from '@shared/types'

const RANGES: Record<StockRange, { range: string; interval: string }> = {
  '1D': { range: '1d', interval: '5m' },
  '1W': { range: '5d', interval: '30m' },
  '1M': { range: '1mo', interval: '1d' },
  '3M': { range: '3mo', interval: '1d' },
  '1Y': { range: '1y', interval: '1wk' },
}

const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15' }

async function fromYahoo(symbol: string, range: StockRange): Promise<StockData> {
  const r = RANGES[range]
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${r.range}&interval=${r.interval}&includePrePost=false`
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`Yahoo ${res.status}`)
  const j = (await res.json()) as {
    chart: {
      result?: {
        meta: { symbol: string; currency: string; regularMarketPrice: number; chartPreviousClose?: number; previousClose?: number; longName?: string; shortName?: string; marketState?: string }
        timestamp?: number[]
        indicators: { quote: { close: (number | null)[] }[] }
      }[]
      error?: { description?: string } | null
    }
  }
  const result = j.chart.result?.[0]
  if (!result) throw new Error(j.chart.error?.description ?? 'No data')
  const closes = result.indicators.quote[0]?.close ?? []
  const points = (result.timestamp ?? [])
    .map((t, i) => ({ t: t * 1000, v: closes[i] }))
    .filter((p): p is { t: number; v: number } => typeof p.v === 'number')
  const price = result.meta.regularMarketPrice
  const base = range === '1D' ? (result.meta.previousClose ?? result.meta.chartPreviousClose ?? points[0]?.v) : points[0]?.v
  const change = base ? price - base : 0
  return {
    symbol: result.meta.symbol,
    name: result.meta.longName ?? result.meta.shortName ?? result.meta.symbol,
    currency: result.meta.currency,
    price,
    change,
    changePct: base ? (change / base) * 100 : 0,
    range,
    points,
    marketState: result.meta.marketState,
    source: 'Yahoo Finance',
  }
}

async function fromStooq(symbol: string, range: StockRange): Promise<StockData> {
  const s = symbol.includes('.') ? symbol.toLowerCase() : `${symbol.toLowerCase()}.us`
  const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`)
  const csv = await res.text()
  const rows = csv.trim().split('\n').slice(1).map((l) => l.split(','))
  if (!rows.length || rows[0].length < 5) throw new Error(`I couldn't find a stock called ${symbol}.`)
  const days = { '1D': 2, '1W': 6, '1M': 23, '3M': 66, '1Y': 252 }[range]
  const points = rows.slice(-days).map((r) => ({ t: Date.parse(r[0]), v: Number(r[4]) }))
  const price = points[points.length - 1].v
  const base = points[0].v
  return {
    symbol: symbol.toUpperCase(),
    name: symbol.toUpperCase(),
    currency: 'USD',
    price,
    change: price - base,
    changePct: ((price - base) / base) * 100,
    range,
    points,
    source: 'Stooq (daily close)',
  }
}

export async function getStock(symbol: string, range: StockRange = '1D'): Promise<StockData> {
  const clean = symbol.trim().toUpperCase().replace(/^\$/, '')
  try {
    return await fromYahoo(clean, range)
  } catch {
    return await fromStooq(clean, range)
  }
}

export function stockForModel(s: StockData) {
  const sign = s.change >= 0 ? '+' : ''
  return {
    symbol: s.symbol,
    name: s.name,
    price: `${s.price.toFixed(2)} ${s.currency}`,
    change: `${sign}${s.change.toFixed(2)} (${sign}${s.changePct.toFixed(2)}%) over ${s.range}`,
    market: s.marketState ?? 'unknown',
    widget: 'shown to the user already',
  }
}
