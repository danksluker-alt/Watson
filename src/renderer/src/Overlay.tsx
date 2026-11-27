// The island: a black pill at the top of the screen that springs open into
// a live caption while you talk, and into a full panel when there's
// something to see.
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import { ArrowUp, Check, Close, Gear, Keyboard, Mic, Warning } from './components/Icons'
import { Markdown } from './components/Markdown'
import { Bars, Orb } from './components/Orb'
import { Blocks } from './widgets/Blocks'
import { AgentMark } from './widgets/Delegation'

const SPRING = { type: 'spring' as const, stiffness: 420, damping: 34, mass: 0.9 }
const WIDTH = { pill: 168, compact: 480, panel: 680 }
type Mode = keyof typeof WIDTH

function useMeasuredHeight() {
  const [h, setH] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  // A callback ref, so measuring starts whenever the element actually mounts.
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    if (!el) return
    observer.current = new ResizeObserver(([e]) => setH(Math.ceil(e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height)))
    observer.current.observe(el)
  }, [])
  return [ref, h] as const
}

function statusText(s: UIState): string {
  const running = [...s.activity].reverse().find((a) => a.status === 'running')
  switch (s.phase) {
    case 'listening':
      return s.transcript ? 'Listening' : 'Listening…'
    case 'thinking':
      return running?.text ? `${running.text}…` : 'Thinking…'
    case 'speaking':
      return 'Watson'
    default:
      return s.panel?.title ?? 'Watson'
  }
}

export function Overlay() {
  const [s, setS] = useState<UIState | null>(null)
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const [hover, setHover] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [contentRef, contentH] = useMeasuredHeight()

  useEffect(() => window.watson.onState(setS), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTyping(false)
        window.watson.dismiss()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (!typing) return
    window.watson.focus()
    setTimeout(() => inputRef.current?.focus(), 120)
  }, [typing])

  if (!s) return null

  const jobs = s.jobs.filter((j) => !['done', 'failed'].includes(j.status))
  const hasPanel = Boolean(s.panel || s.confirm || s.error || s.notice || typing || (s.expanded && s.reply))
  const mode: Mode = hasPanel ? 'panel' : s.phase !== 'idle' ? 'compact' : 'pill'

  const enter = () => {
    setHover(true)
    window.watson.setInteractive(true)
  }
  const leave = () => {
    setHover(false)
    window.watson.setInteractive(false)
  }

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    window.watson.ask(text)
    setDraft('')
  }

  const startTyping = () => {
    window.watson.cancel()
    setTyping(true)
  }

  return (
    <div className="stage">
      <motion.div
        className="island"
        data-mode={mode}
        data-phase={s.phase}
        onMouseEnter={enter}
        onMouseLeave={leave}
        initial={false}
        animate={{ width: WIDTH[mode], height: contentH || 38, borderRadius: mode === 'pill' ? 19 : mode === 'compact' ? 30 : 28 }}
        transition={SPRING}
      >
        <div ref={contentRef} className="island-content" style={{ width: WIDTH[mode] }}>
          <AnimatePresence mode="popLayout" initial={false}>
            {mode === 'pill' && (
              <motion.button
                key="pill"
                className="pill"
                onClick={() => window.watson.toggleListen()}
                initial={{ opacity: 0, filter: 'blur(6px)' }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, filter: 'blur(6px)' }}
                transition={{ duration: 0.18 }}
                title="Talk to Watson (⌥ Space)"
              >
                <Orb phase="idle" size={18} />
                {jobs.length > 0 ? (
                  <span className="pill-job">
                    <span className="spinner" />
                    {jobs[0].agent}
                    {jobs.length > 1 && ` +${jobs.length - 1}`}
                  </span>
                ) : (
                  <span className="pill-label">{hover ? '⌥ Space' : 'Watson'}</span>
                )}
              </motion.button>
            )}

            {mode === 'compact' && (
              <motion.div
                key="compact"
                className="compact"
                onClick={() => window.watson.toggleListen()}
                initial={{ opacity: 0, filter: 'blur(8px)' }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, filter: 'blur(8px)' }}
                transition={{ duration: 0.2 }}
              >
                <Orb phase={s.phase} size={34} />
                <div className="compact-text">
                  {s.phase === 'listening' && (
                    <div className={s.transcript ? 'transcript' : 'transcript placeholder'}>{s.transcript || 'Listening…'}</div>
                  )}
                  {s.phase === 'thinking' && (
                    <>
                      {s.transcript && <div className="you">{s.transcript}</div>}
                      <div className="shimmer">{statusText(s)}</div>
                    </>
                  )}
                  {s.phase === 'speaking' && <div className="caption">{tail(s.reply, 160)}</div>}
                </div>
                {s.phase === 'listening' && <Bars />}
                {s.phase === 'listening' && (
                  <button
                    className="icon-btn subtle"
                    onClick={(e) => {
                      e.stopPropagation()
                      startTyping()
                    }}
                    aria-label="Type instead"
                  >
                    <Keyboard size={16} />
                  </button>
                )}
              </motion.div>
            )}

            {mode === 'panel' && (
              <motion.div
                key="panel"
                className="panel"
                initial={{ opacity: 0, y: -8, filter: 'blur(8px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, filter: 'blur(8px)' }}
                transition={{ duration: 0.22 }}
              >
                <header className="panel-head">
                  <button className="orb-btn" onClick={() => window.watson.toggleListen()} aria-label="Talk">
                    <Orb phase={s.phase} size={30} />
                  </button>
                  <div className="panel-titles">
                    <div className={s.phase === 'thinking' ? 'panel-title shimmer' : 'panel-title'}>{statusText(s)}</div>
                    {s.panel?.subtitle && s.phase === 'idle' && <div className="panel-sub">{s.panel.subtitle}</div>}
                  </div>
                  <div className="panel-actions">
                    <button className="icon-btn" onClick={() => (typing ? setTyping(false) : startTyping())} aria-label="Type">
                      {typing ? <Mic size={16} /> : <Keyboard size={16} />}
                    </button>
                    <button className="icon-btn" onClick={() => window.watson.openSettings()} aria-label="Settings">
                      <Gear size={16} />
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => {
                        setTyping(false)
                        window.watson.dismiss()
                      }}
                      aria-label="Close"
                    >
                      <Close size={15} />
                    </button>
                  </div>
                </header>

                {s.activity.length > 0 && (
                  <div className="steps">
                    {s.activity.map((a) => (
                      <span key={a.id} className={`step ${a.status}`}>
                        {a.status === 'running' ? <span className="spinner" /> : a.status === 'done' ? <Check size={11} /> : <Warning size={11} />}
                        {a.text}
                      </span>
                    ))}
                  </div>
                )}

                <div className="panel-scroll">
                  {s.transcript && s.phase !== 'listening' && <div className="you-bubble">{s.transcript}</div>}
                  {s.phase === 'listening' && (
                    <div className="listening-row">
                      <Bars />
                      <span className={s.transcript ? 'transcript' : 'transcript placeholder'}>{s.transcript || 'Listening…'}</span>
                    </div>
                  )}

                  {s.reply && (
                    <div className="reply">
                      <Markdown text={s.reply} />
                    </div>
                  )}

                  {s.confirm && (
                    <motion.div className="card confirm" initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={SPRING}>
                      <div className="confirm-title">{s.confirm.title}</div>
                      <div className="confirm-body">{s.confirm.body}</div>
                      <div className="confirm-actions">
                        <button className="btn" onClick={() => window.watson.answerConfirm(s.confirm!.id, false)}>
                          Cancel
                        </button>
                        <button className="btn primary" onClick={() => window.watson.answerConfirm(s.confirm!.id, true)}>
                          {s.confirm.actionLabel}
                        </button>
                      </div>
                      <div className="muted small">Or say “send” or “cancel”.</div>
                    </motion.div>
                  )}

                  {s.error && (
                    <div className="card error-card">
                      <Warning size={16} />
                      <span>{s.error}</span>
                      {/key|settings|helper|permission/i.test(s.error) && (
                        <button className="btn small" onClick={() => window.watson.openSettings()}>
                          Settings
                        </button>
                      )}
                    </div>
                  )}

                  {s.notice && <div className="card notice">{s.notice}</div>}

                  {s.panel && <Blocks blocks={s.panel.blocks} />}

                  {jobs.length > 0 && !s.panel?.blocks.some((b) => b.type === 'delegation') && (
                    <div className="jobs">
                      {jobs.map((j) => (
                        <div key={j.jobId} className="job-row">
                          <AgentMark name={j.agent} />
                          <span className="job-text">{j.prompt}</span>
                          <span className="spinner" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {typing && (
                  <form
                    className="ask"
                    onSubmit={(e) => {
                      e.preventDefault()
                      submit()
                    }}
                  >
                    <input ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask Watson…" spellCheck={false} />
                    <button type="submit" className="send" disabled={!draft.trim()} aria-label="Send">
                      <ArrowUp size={15} />
                    </button>
                  </form>
                )}

                <footer className="panel-foot">
                  <span>⌥ Space to talk · Esc to close</span>
                  <span>${s.usageTodayUsd.toFixed(3)} today</span>
                </footer>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  )
}

function tail(text: string, n: number) {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? `…${t.slice(-n)}` : t
}
