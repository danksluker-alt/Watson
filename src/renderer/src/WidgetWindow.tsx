// A pinned widget in its own floating window. Drag it anywhere, on any screen.
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Block } from '@shared/types'
import { Close } from './components/Icons'
import { BlockView } from './widgets/Blocks'

export function WidgetWindow({ id }: { id: string }) {
  const [block, setBlock] = useState<Block | null>(null)
  const [loaded, setLoaded] = useState(false)
  const observer = useRef<ResizeObserver | null>(null)

  useEffect(() => {
    const off = window.watson.onWidget((m) => {
      if (m.id !== id) return
      setBlock(m.block)
      setLoaded(true)
    })
    window.watson.widgetReady(id)
    return off
  }, [id])

  const measure = useCallback(
    (el: HTMLDivElement | null) => {
      observer.current?.disconnect()
      if (!el) return
      observer.current = new ResizeObserver(([e]) => window.watson.widgetSize(id, Math.ceil(e.contentRect.width), Math.ceil(e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height)))
      observer.current.observe(el)
    },
    [id],
  )

  return (
    <div ref={measure} className="widget-shell">
      <AnimatePresence mode="wait">
        <motion.div
          key={block ? 'data' : 'loading'}
          className="widget-frame"
          initial={{ opacity: 0, scale: 0.94, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        >
          {block ? <BlockView block={block} /> : <div className="widget-loading">{loaded ? 'Nothing to show right now' : <span className="spinner" />}</div>}
        </motion.div>
      </AnimatePresence>
      <button className="widget-close" onClick={() => window.watson.closeWidget(id)} aria-label="Remove widget">
        <Close size={10} />
      </button>
    </div>
  )
}
