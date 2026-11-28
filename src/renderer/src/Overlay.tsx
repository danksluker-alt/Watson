// The island: a black pill at the top of the screen that springs open into
// a live caption while you talk, into an editor when you dictate to review,
// and into a full panel when there's something to see.
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import { ArrowUp, Check, Close, Gear, InsertText, Keyboard, Mic, Pencil, Sparkle, Warning } from './components/Icons'
import { Markdown } from './components/Markdown'
import { Bars, Orb } from './components/Orb'
import { play } from './sounds'
import { Blocks } from './widgets/Blocks'
import { AgentMark } from './widgets/Delegation'
import { RingingCard } from './widgets/Timers'
import { pillWidth, useHoldToMove, useLive } from './pill'

const SPRING = { type: 'spring' as const, stiffness: 420, damping: 34, mass: 0.9 }
const WIDTH = { pill: 168, compact: 500, panel: 680 }
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
      // While quietly waiting for a follow-up, keep the panel's own title.
      if (!s.transcript && s.panel) return s.panel.title ?? 'Watson'
      return s.transcript ? 'Listening' : 'Listening…'
    case 'thinking':
      return running?.text ? `${running.text}…` : 'Thinking…'
    case 'speaking':
      return 'Watson'
    default:
      return s.panel?.title ?? 'Watson'
  }
}

const appName = (s: UIState) => s.insertTargetName || (s.insertTarget ? (s.insertTarget.split('.').pop() ?? 'your app') : 'your app')

/** Plays a sound when the state crosses an interesting edge. */
function useSounds(s: UIState | null) {
  const prev = useRef<UIState | null>(null)
  useEffect(() => {
    const p = prev.current
    prev.current = s
    if (!s || !p || !s.sounds) return
    if (p.phase === 'idle' && s.phase === 'listening') play('listen')
    if (p.phase === 'listening' && s.phase === 'thinking') play('done-listening')
    if (!p.draft && s.draft) play('done-listening')
    if (!p.error && s.error) play('error')
    const was = (id: string) => p.jobs.find((x) => x.jobId === id)?.status
    if (s.jobs.some((j) => j.status === 'waiting' && was(j.jobId) === 'sending')) play('sent')
    if (s.jobs.some((j) => j.status === 'done' && was(j.jobId) !== 'done')) play('arrived')
  }, [s])

  // A timer that went off rings every 2.5 s until it's stopped, even with interface sounds off.
  const ringing = s?.ringing?.id
  useEffect(() => {
    if (!ringing) return
    play('ring')
    const t = setInterval(() => play('ring'), 2500)
    return () => clearInterval(t)
  }, [ringing])
}

// ---------------- Review editor ----------------

function DraftEditor({ s }: { s: UIState }) {
  const [text, setText] = useState(s.draft?.text ?? '')
  const [target, setTarget] = useState<string>(() => {
    try {
      return localStorage.getItem('watson.target') ?? 'watson'
    } catch {
      return 'watson'
    }
  })
  const area = useRef<HTMLTextAreaElement>(null)
  const listening = s.phase === 'listening'
  const draftId = s.draft?.id

  // New dictation arrives as a new draft id; local edits are kept otherwise.
  useEffect(() => {
    if (s.draft) setText(s.draft.text)
    window.watson.focus()
    const t = setTimeout(() => {
      const el = area.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 140)
    return () => clearTimeout(t)
  }, [draftId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(220, Math.max(52, el.scrollHeight))}px`
  }, [text, s.transcript])

  const choose = (t: string) => {
    setTarget(t)
    try {
      localStorage.setItem('watson.target', t)
    } catch {
      /* per-viewer convenience only */
    }
  }
  const valid = target === 'watson' || target === 'insert' || s.agents.some((a) => a.id === target)
  const to = valid ? target : 'watson'
  const send = () => {
    if (!text.trim()) return
    window.watson.submitDraft(text, to)
  }
  const label = to === 'watson' ? 'Ask Watson' : to === 'insert' ? `Type into ${appName(s)}` : `Send to ${s.agents.find((a) => a.id === to)?.name}`

  return (
    <div className="draft">
      <div className={listening ? 'draft-box live' : 'draft-box'}>
        <textarea
          ref={area}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={listening ? '' : 'Your words appear here…'}
          spellCheck
        />
        {listening && <div className={s.transcript ? 'draft-live' : 'draft-live placeholder'}>{s.transcript || 'Listening…'}</div>}
      </div>
      <div className="draft-targets">
        <button className={to === 'watson' ? 'chip on' : 'chip'} onClick={() => choose('watson')}>
          <Sparkle size={12} /> Watson
        </button>
        {s.agents.map((a) => (
          <button key={a.id} className={to === a.id ? 'chip on' : 'chip'} onClick={() => choose(a.id)}>
            <AgentMark name={a.name} small /> {a.name}
          </button>
        ))}
        <button className={to === 'insert' ? 'chip on' : 'chip'} onClick={() => choose('insert')} title="Type it where your cursor was">
          <InsertText size={12} /> Type into {appName(s)}
        </button>
      </div>
      <div className="draft-actions">
        <button className={listening ? 'mic-btn live' : 'mic-btn'} onClick={() => window.watson.dictate(text)} aria-label={listening ? 'Stop dictating' : 'Keep talking'}>
          <Mic size={15} />
          <span>{listening ? 'Done' : 'Keep talking'}</span>
        </button>
        <span className="draft-count">{text.trim() ? `${text.trim().split(/\s+/).length} words` : ''}</span>
        <button className="btn ghost" onClick={() => window.watson.cancelDraft()}>
          Discard
        </button>
        <button className="btn primary send-btn" onClick={send} disabled={!text.trim()}>
          {label} <span className="kbd">↵</span>
        </button>
      </div>
    </div>
  )
}

// ---------------- Island ----------------

const isReviewing = (s: UIState) => Boolean(s.draft) || (s.capture === 'review' && s.phase === 'listening' && Boolean(s.transcript))

/** pill (resting or live status), compact (listening/thinking/speaking) or the full panel. */
function modeOf(s: UIState, typing: boolean): Mode {
  if (s.arranging) return 'pill'
  const hasPanel = isReviewing(s) || Boolean(s.panel || s.confirm || s.error || s.notice || s.ringing || typing || (s.expanded && s.reply))
  return hasPanel ? 'panel' : s.phase !== 'idle' ? 'compact' : 'pill'
}

export function Overlay() {
  const [s, setS] = useState<UIState | null>(null)
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const [hover, setHover] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const [contentRef, contentH] = useMeasuredHeight()

  useEffect(() => {
    const off = window.watson.onState(setS)
    // Ask for the current state too, in case the first push happened before we subscribed.
    void window.watson.getState().then((st) => setS((cur) => cur ?? st))
    return off
  }, [])
  useSounds(s)
  const live = useLive(s)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTyping(false)
        window.watson.setArranging(false)
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

  const mode: Mode = s ? modeOf(s, typing) : 'pill'
  const hold = useHoldToMove(() => window.watson.toggleListen(), mode === 'pill')

  if (!s) return null

  const jobs = s.jobs.filter((j) => !['done', 'failed'].includes(j.status))
  const reviewing = isReviewing(s)
  // At rest it's a circle (unless the user chose the pill); it grows to say what's going on.
  const shown = s.arranging ? null : live
  const circle = mode === 'pill' && s.pillShape === 'circle' && !shown
  const pillText = shown?.text ?? (hover && !s.arranging ? '⌥ Space' : 'Watson')
  const width = mode === 'pill' ? (circle ? 38 : pillWidth(pillText)) : WIDTH[mode]
  // Keep the island inside the window: near a screen edge it shifts instead of being cut off.
  const left = Math.max(8, Math.min(760 - width - 8, s.layout.centerX - width / 2))
  const up = s.layout.dir === 'up'

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
        className={`island${hold.holding ? ' lifted' : ''}${circle ? ' circle' : ''}`}
        data-mode={mode}
        data-phase={s.phase}
        onMouseEnter={enter}
        onMouseLeave={leave}
        initial={false}
        style={up ? { bottom: 4, top: 'auto', transformOrigin: '50% 100%' } : { top: 4, bottom: 'auto', transformOrigin: '50% 0%' }}
        animate={{ left, width, height: circle ? 38 : contentH || 38, borderRadius: mode === 'pill' ? 19 : mode === 'compact' ? 31 : 28, scale: hold.holding ? 1.08 : 1 }}
        whileHover={mode === 'pill' && !hold.holding ? { scale: 1.04 } : undefined}
        transition={SPRING}
      >
        <div ref={contentRef} className="island-content" style={{ width }}>
          <AnimatePresence mode="popLayout" initial={false}>
            {mode === 'pill' && (
              <motion.button
                key="pill"
                className="pill"
                {...hold.handlers}
                onContextMenu={(e) => {
                  e.preventDefault()
                  window.watson.setArranging(true)
                }}
                initial={{ opacity: 0, filter: 'blur(6px)' }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, filter: 'blur(6px)' }}
                transition={{ duration: 0.18 }}
                title="Click to talk · hold to move"
              >
                <Orb phase={shown?.tone === 'job' ? 'thinking' : 'idle'} size={circle ? 22 : 18} />
                {!circle && (
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span
                      key={shown?.key ?? pillText}
                      className={`pill-label${shown ? ` live ${shown.tone}` : ''}`}
                      initial={{ opacity: 0, y: up ? -8 : 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: up ? 8 : -8 }}
                      transition={{ duration: 0.28 }}
                    >
                      {shown?.tone === 'timer' && <span className="pill-timer-dot" />}
                      {shown?.tone === 'done' && <Check size={11} />}
                      {shown?.tone === 'attention' && <Warning size={11} />}
                      {shown?.tone === 'event' && <span className="pill-event-dot" />}
                      {pillText}
                    </motion.span>
                  </AnimatePresence>
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
                    <div className={s.transcript ? 'transcript' : 'transcript placeholder'}>
                      {s.transcript || (s.capture === 'review' ? 'Dictate — you’ll review before sending' : 'Listening…')}
                    </div>
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
                  <div className="mode-switch" onClick={(e) => e.stopPropagation()}>
                    <button className={s.capture === 'live' ? 'on' : ''} onClick={() => window.watson.setCapture('live')} title="Answer as soon as I stop talking">
                      Live
                    </button>
                    <button className={s.capture === 'review' ? 'on' : ''} onClick={() => window.watson.setCapture('review')} title="Show my words so I can edit them first">
                      <Pencil size={11} /> Review
                    </button>
                  </div>
                )}
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
                    <div className={s.phase === 'thinking' ? 'panel-title shimmer' : 'panel-title'}>
                      {reviewing ? (s.phase === 'listening' ? 'Listening…' : 'Review and send') : statusText(s)}
                    </div>
                    {reviewing && <div className="panel-sub">Edit your words, choose where they go, press Return.</div>}
                    {!reviewing && s.panel?.subtitle && s.phase === 'idle' && <div className="panel-sub">{s.panel.subtitle}</div>}
                  </div>
                  <div className="panel-actions">
                    {!reviewing && (
                      <button className="icon-btn" onClick={() => (typing ? setTyping(false) : startTyping())} aria-label="Type">
                        {typing ? <Mic size={16} /> : <Keyboard size={16} />}
                      </button>
                    )}
                    <button className="icon-btn" onClick={() => window.watson.openWindow()} aria-label="Open the Watson window" title="Open the Watson window">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
                      </svg>
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

                {reviewing ? (
                  <>
                    {s.error && (
                      <div className="panel-scroll">
                        <ErrorCard message={s.error} />
                      </div>
                    )}
                    <DraftEditor s={s} />
                  </>
                ) : (
                  <>
                    {s.activity.length > 0 && (
                      <div className="steps">
                        <AnimatePresence initial={false}>
                          {s.activity.map((a) => (
                            <motion.span
                              key={a.id}
                              className={`step ${a.status}`}
                              initial={{ opacity: 0, scale: 0.9, x: -6 }}
                              animate={{ opacity: 1, scale: 1, x: 0 }}
                              exit={{ opacity: 0, scale: 0.9 }}
                              transition={SPRING}
                            >
                              {a.status === 'running' ? <span className="spinner" /> : a.status === 'done' ? <Check size={11} /> : <Warning size={11} />}
                              {a.text}
                            </motion.span>
                          ))}
                        </AnimatePresence>
                      </div>
                    )}

                    <div className="panel-scroll">
                      {s.transcript && s.phase !== 'listening' && <div className="you-bubble">{s.transcript}</div>}
                      {s.phase === 'listening' &&
                        (s.transcript ? (
                          <div className="listening-row">
                            <Bars />
                            <span className="transcript">{s.transcript}</span>
                          </div>
                        ) : (
                          <div className="follow-up">
                            <span className="follow-dot" /> Listening for a follow-up…
                          </div>
                        ))}

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

                      {s.ringing && <RingingCard t={s.ringing} />}
                      {s.error && <ErrorCard message={s.error} />}
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
                  </>
                )}

                <footer className="panel-foot">
                  <span>{reviewing ? 'Return to send · Shift-Return for a new line · Esc to discard' : '⌥ Space to talk · ⌥⇧ Space to dictate · Esc to close'}</span>
                  <span>${s.usageTodayUsd.toFixed(3)} today</span>
                </footer>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
      <AnimatePresence>
        {s.arranging && !hold.holding && (
          <motion.div
            className="arrange-bar"
            style={{ left: Math.max(8, Math.min(760 - 300 - 8, s.layout.centerX - 150)), ...(up ? { bottom: 52 } : { top: 52 }) }}
            initial={{ opacity: 0, y: up ? 6 : -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={SPRING}
            onMouseEnter={enter}
            onMouseLeave={leave}
          >
            <div className="segmented-dark">
              <button className={s.pillShape === 'pill' ? 'on' : ''} onClick={() => window.watson.setPillShape('pill')}>
                Pill
              </button>
              <button className={s.pillShape === 'circle' ? 'on' : ''} onClick={() => window.watson.setPillShape('circle')}>
                Circle
              </button>
            </div>
            <button className="arrange-link" onClick={() => window.watson.resetPillPlace()}>
              Reset
            </button>
            <button className="arrange-done" onClick={() => window.watson.setArranging(false)}>
              Done
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="card error-card">
      <Warning size={16} />
      <span>{message}</span>
      {/key|settings|helper|permission|accessibility/i.test(message) && (
        <button className="btn small" onClick={() => window.watson.openSettings()}>
          Settings
        </button>
      )}
    </div>
  )
}

function tail(text: string, n: number) {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? `…${t.slice(-n)}` : t
}
