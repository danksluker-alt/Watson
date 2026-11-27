// Watson's orb: a living gradient that breathes when idle, swells with your
// voice while listening, swirls while thinking and pulses while speaking.
import { useEffect, useRef } from 'react'
import type { Phase } from '@shared/types'

export function Orb({ phase, size = 28 }: { phase: Phase; size?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let target = 0
    let current = 0
    let raf = 0
    const off = window.watson.onLevel((v) => {
      target = v
    })
    const tick = () => {
      current += (target - current) * 0.25
      target *= 0.92
      ref.current?.style.setProperty('--level', current.toFixed(3))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      off()
      cancelAnimationFrame(raf)
    }
  }, [])
  return (
    <div ref={ref} className="orb" data-phase={phase} style={{ width: size, height: size }}>
      <span className="orb-layer a" />
      <span className="orb-layer b" />
      <span className="orb-layer c" />
      <span className="orb-core" />
    </div>
  )
}

/** Five bars that move with the microphone level. */
export function Bars() {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let level = 0
    let raf = 0
    const off = window.watson.onLevel((v) => {
      level = Math.max(level, v)
    })
    const tick = (t: number) => {
      level *= 0.9
      const bars = ref.current?.children
      if (bars) {
        for (let i = 0; i < bars.length; i++) {
          const wobble = 0.35 + 0.65 * Math.abs(Math.sin(t / 180 + i * 1.3))
          ;(bars[i] as HTMLElement).style.transform = `scaleY(${Math.max(0.18, Math.min(1, level * wobble * 1.6))})`
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      off()
      cancelAnimationFrame(raf)
    }
  }, [])
  return (
    <div ref={ref} className="bars" aria-hidden>
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} />
      ))}
    </div>
  )
}
