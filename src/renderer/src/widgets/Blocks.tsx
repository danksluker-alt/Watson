import { motion } from 'motion/react'
import type { Block } from '@shared/types'
import { BarChart, LineChart } from '../components/Charts'
import { Markdown } from '../components/Markdown'
import { DelegationCard } from './Delegation'
import { NowPlayingWidget } from './NowPlaying'
import { StockWidget } from './Stock'
import { WeatherWidget } from './Weather'

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'text':
      return (
        <div className="card text-card">
          <Markdown text={block.markdown} />
        </div>
      )
    case 'cards':
      return (
        <div className="card-grid">
          {block.items.map((c, i) => (
            <div key={i} className="card mini" style={c.accent ? { borderTop: `3px solid ${c.accent}` } : undefined}>
              <div className="mini-title">{c.title}</div>
              {c.subtitle && <div className="mini-sub">{c.subtitle}</div>}
              {c.body && <div className="mini-body">{c.body}</div>}
            </div>
          ))}
        </div>
      )
    case 'list': {
      return (
        <div className="card list">
          {block.items.map((it, i) => (
            <div key={i} className="list-row">
              {block.ordered && <span className="list-num">{i + 1}</span>}
              <div className="list-main">
                <div className="list-title">{it.title}</div>
                {it.detail && <div className="list-detail">{it.detail}</div>}
              </div>
              {it.meta && <span className="list-meta">{it.meta}</span>}
            </div>
          ))}
        </div>
      )
    }
    case 'table':
      return (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                {block.columns.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className={typeof v === 'number' ? 'num' : undefined}>
                      {typeof v === 'number' ? v.toLocaleString() : v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'stats':
      return (
        <div className="stats">
          {block.items.map((s, i) => (
            <div key={i} className="card stat">
              <div className="stat-label">{s.label}</div>
              <div className="stat-value">{s.value}</div>
              {s.delta && <div className={`stat-delta ${s.trend ?? 'flat'}`}>{s.trend === 'up' ? '▲' : s.trend === 'down' ? '▼' : '•'} {s.delta}</div>}
            </div>
          ))}
        </div>
      )
    case 'chart': {
      const labels = block.series[0]?.points.map((p) => p.x) ?? []
      const series = block.series.map((s) => ({ name: s.name, values: s.points.map((p) => p.y) }))
      return (
        <div className="card">
          {block.yLabel && <div className="muted small chart-ylabel">{block.yLabel}</div>}
          {block.kind === 'bar' ? <BarChart labels={labels} series={series} /> : <LineChart labels={labels} series={series} />}
        </div>
      )
    }
    case 'weather':
      return <WeatherWidget data={block.data} />
    case 'stock':
      return <StockWidget data={block.data} />
    case 'nowPlaying':
      return <NowPlayingWidget data={block.data} />
    case 'delegation':
      return <DelegationCard data={block.data} />
  }
}

export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="blocks">
      {blocks.map((b, i) => (
        <motion.div
          key={`${b.type}-${i}`}
          initial={{ opacity: 0, y: 10, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30, delay: i * 0.05 }}
        >
          <BlockView block={b} />
        </motion.div>
      ))}
    </div>
  )
}
