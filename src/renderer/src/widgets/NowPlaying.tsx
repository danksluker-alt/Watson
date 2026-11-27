import { useEffect, useState } from 'react'
import type { NowPlayingData } from '@shared/types'
import { Next, Pause, Play, Prev } from '../components/Icons'

const time = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function NowPlayingWidget({ data }: { data: NowPlayingData }) {
  // Advance the progress bar locally between the 5-second refreshes.
  const [pos, setPos] = useState(data.positionSec)
  useEffect(() => {
    setPos(data.positionSec)
    if (data.state !== 'playing') return
    const t = setInterval(() => setPos((p) => Math.min(data.durationSec, p + 1)), 1000)
    return () => clearInterval(t)
  }, [data.positionSec, data.state, data.durationSec, data.title])
  const pct = data.durationSec ? (pos / data.durationSec) * 100 : 0
  return (
    <div className="now-playing">
      {data.artworkUrl && <img className="np-backdrop" src={data.artworkUrl} alt="" />}
      <div className="np-body">
        {data.artworkUrl ? <img className="np-art" src={data.artworkUrl} alt="" /> : <div className="np-art np-art-empty" />}
        <div className="np-info">
          <div className="np-title">{data.title}</div>
          <div className="np-artist">{data.artist}</div>
          <div className="np-progress">
            <span>{time(pos)}</span>
            <div className="np-track">
              <div className="np-fill" style={{ width: `${pct}%` }} />
            </div>
            <span>-{time(Math.max(0, data.durationSec - pos))}</span>
          </div>
        </div>
        <div className="np-controls">
          <button onClick={() => window.watson.spotify('previous')} aria-label="Previous">
            <Prev size={20} />
          </button>
          <button className="np-main" onClick={() => window.watson.spotify('playpause')} aria-label={data.state === 'playing' ? 'Pause' : 'Play'}>
            {data.state === 'playing' ? <Pause size={24} /> : <Play size={24} />}
          </button>
          <button onClick={() => window.watson.spotify('next')} aria-label="Next">
            <Next size={20} />
          </button>
        </div>
      </div>
    </div>
  )
}
