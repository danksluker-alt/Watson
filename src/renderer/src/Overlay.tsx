// The island: a black pill at the top of the screen that springs open into
// a live caption while you talk, into an editor when you dictate to review,
// and into a full panel when there's something to see.
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { UIState } from '@shared/types'
import { ArrowUp, Check, Close, Grid, InsertText, Keyboard, Mic, Pencil, Sparkle, Speaker, Trash, Warning, Wave } from './components/Icons'
import { Markdown } from './components/Markdown'
import { Bars, Orb } from './components/Orb'
import { play } from './sounds'
import { Blocks } from './widgets/Blocks'
import { AgentMark } from './widgets/Delegation'
import { RingingCard } from './widgets/Timers'
import { pillWidth, useHoldToMove, useLive } from './pill'

const SPRING = { type: 'spring' as const, stiffness: 420, damping: 34, mass: 0.9 }
// The island's shape: opening has a little life in it, closing settles softly with no bounce.
// Growing goes wide first, then tall; shrinking folds up first, then narrows, like a sheet being put away.
const GROW = { type: 'spring' as const, visualDuration: 0.5, bounce: 0.2 }
const SHRINK = { type: 'spring' as const, visualDuration: 0.52, bounce: 0.04 }
const islandTransition = (growing: boolean) =>
  growing
    ? { default: GROW, left: GROW, width: GROW, height: { ...GROW, delay: 0.05 }, borderRadius: GROW, scale: SPRING }
    : { default: SHRINK, left: { ...SHRINK, delay: 0.07 }, width: { ...SHRINK, delay: 0.07 }, height: SHRINK, borderRadius: SHRINK, scale: SPRING }
// What's inside cross-fades: the old view leaves quickly, the new one arrives once the shape is on its way.
const EASE_OUT = [0.22, 1, 0.36, 1] as const
const contentMotion = {
  initial: { opacity: 0, scale: 0.97, filter: 'blur(6px)' },
  animate: { opacity: 1, scale: 1, filter: 'blur(0px)', transition: { duration: 0.34, delay: 0.07, ease: EASE_OUT } },
  exit: { opacity: 0, scale: 0.98, filter: 'blur(4px)', transition: { duration: 0.14, ease: [0.4, 0, 1, 1] as const } }
}
const WIDTH = { pill: 168, compact: 500, dictate: 560, panel: 680 }
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

// ---------------- Dictation ----------------

/**
 * While you talk: only your words. Click them to take over by typing (the mic stops).
 * When you stop: the text is editable, with Send and Discard. Where it goes and the
 * other ways of talking are one click further, under the destination button.
 */
/** Sends the open draft's newest text right away (Esc must not lose the last keystrokes). */
let flushOpenDraft: (() => void) | null = null

function DraftEditor({ s }: { s: UIState }) {
  const [text, setText] = useState(s.draft?.text ?? '')
  const [more, setMore] = useState(false)
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
  }, [draftId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the text whenever it becomes editable.
  useEffect(() => {
    if (listening) return
    window.watson.focus()
    const t = setTimeout(() => {
      const el = area.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }, 140)
    return () => clearTimeout(t)
  }, [draftId, listening])

  // Edits are kept by the main process (and on disk), so clicking away never loses them.
  // A short pause batches keystrokes; anything not yet sent goes when the box closes or listens.
  const latest = useRef({ text, sent: text })
  latest.current.text = text
  const flush = () => {
    if (latest.current.text === latest.current.sent) return
    latest.current.sent = latest.current.text
    window.watson.draftText(latest.current.text)
  }
  useEffect(() => {
    if (listening) return flush()
    const t = setTimeout(flush, 300)
    return () => clearTimeout(t)
  }, [text, listening]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    flushOpenDraft = flush
    return () => {
      flush()
      flushOpenDraft = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    latest.current.sent = s.draft?.text ?? ''
  }, [draftId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(220, Math.max(52, el.scrollHeight))}px`
  }, [text, listening])

  const choose = (t: string) => {
    setTarget(t)
    setMore(false)
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
  const agent = s.agents.find((a) => a.id === to)
  const label = to === 'watson' ? 'Send' : to === 'insert' ? 'Type it' : `Send to ${agent?.name}`

  if (listening) {
    return (
      <div className="dictation" onMouseDown={(e) => { e.preventDefault(); window.watson.takeOver(text) }} title="Click to type">
        <Orb phase="listening" size={26} />
        <div className="dictation-text">
          {text.trim() && <span className="prior">{text.trim()} </span>}
          <span className={s.transcript ? '' : 'placeholder'}>{s.transcript || (text.trim() ? '' : 'Listening…')}</span>
          <span className="caret" />
        </div>
        <Bars />
        <LiveSwitch s={s} text={text} />
      </div>
    )
  }

  const destIcon = (id: string, size = 13) => {
    if (id === 'watson') return <Sparkle size={size} />
    if (id === 'insert') return <InsertText size={size} />
    return <AgentMark name={s.agents.find((a) => a.id === id)?.name ?? ''} small />
  }
  const destName = (id: string) => (id === 'watson' ? 'Auto' : id === 'insert' ? appName(s) : (s.agents.find((a) => a.id === id)?.name ?? ''))
  const dests = ['watson', ...s.agents.map((a) => a.id), 'insert']

  return (
    <div className="draft">
      <div className="composer">
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
          placeholder="Ask anything…"
          spellCheck
        />
        <div className="composer-bar">
          <motion.div layout className={more ? 'dest open' : 'dest'} transition={{ type: 'spring', stiffness: 520, damping: 38 }}>
            {more ? (
              dests.map((id) => (
                <motion.button
                  key={id}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className={to === id ? 'dest-opt on' : 'dest-opt'}
                  onClick={() => choose(id)}
                  title={id === 'watson' ? 'Auto: Watson answers or picks the best AI' : id === 'insert' ? `Type into ${appName(s)}` : `Send to ${destName(id)}`}
                >
                  {destIcon(id)}
                  <span>{destName(id)}</span>
                </motion.button>
              ))
            ) : (
              <motion.button layout className="dest-opt current" onClick={() => setMore(true)} aria-label="Where it goes" title="Where it goes">
                {destIcon(to)}
                <span>{destName(to)}</span>
                <svg className="route-chev" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </motion.button>
            )}
          </motion.div>
          <span className="flex" />
          <AnimatePresence initial={false}>
            {!more && (
              <motion.div
                key="tools"
                className="tools"
                initial={{ opacity: 0, x: 8, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 8, scale: 0.96 }}
                transition={{ type: 'spring', visualDuration: 0.3, bounce: 0.15 }}
              >
                <button className="tool" onClick={() => window.watson.dictate(text)} aria-label="Keep talking" title="Keep talking">
                  <Mic size={15} />
                </button>
                <button className="tool live" onClick={() => window.watson.talkLive(to === 'watson' ? text : '')} aria-label="Talk live" title="Talk live">
                  <Wave size={15} />
                </button>
                <span className="tool-sep" />
                <button className="tool danger" onClick={() => window.watson.cancelDraft()} aria-label="Discard" title="Discard">
                  <Trash size={15} />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          <button
            className={text.trim() ? 'send-round send-btn ready' : 'send-round send-btn'}
            onClick={send}
            disabled={!text.trim()}
            aria-label={label}
            title={`${label} (Return)`}
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------- Island ----------------

const isReviewing = (s: UIState) => Boolean(s.draft) || (s.capture === 'review' && s.phase === 'listening' && Boolean(s.transcript))

/** pill (resting or live status), compact (listening/thinking/speaking), dictation, or the full panel. */
function modeOf(s: UIState): Mode {
  if (s.arranging) return 'pill'
  if (isReviewing(s) && !s.confirm && !s.ringing) return 'dictate'
  // The dashboard is in front and shows the same things: stay a pill instead of covering it.
  if (s.tucked && s.phase === 'idle' && !s.ringing) return 'pill'
  const hasPanel = Boolean(s.panel || s.confirm || s.error || s.notice || s.ringing || (s.expanded && s.reply))
  return hasPanel ? 'panel' : s.phase !== 'idle' ? 'compact' : 'pill'
}

/** While Watson listens: switch between dictating (Send when done) and a live conversation. */
function LiveSwitch({ s, text = '' }: { s: UIState; text?: string }) {
  const live = s.capture === 'live'
  return (
    <button
      className={live ? 'live-switch on' : 'live-switch'}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        if (live) return window.watson.setCapture('review')
        // Earlier words waiting in the box go along; otherwise this sentence just continues live.
        if (text.trim()) window.watson.talkLive(`${text.trim()} ${s.transcript}`.trim())
        else window.watson.setCapture('live')
      }}
      aria-label={live ? 'Switch to dictation' : 'Switch to live talk'}
      title={live ? 'Live talk · click to dictate instead' : 'Talk live'}
    >
      <Wave size={14} />
    </button>
  )
}

function MuteButton({ s }: { s: UIState }) {
  return (
    <button
      className={s.muted ? 'icon-btn muted' : 'icon-btn'}
      onClick={(e) => {
        e.stopPropagation()
        window.watson.setMuted(!s.muted)
      }}
      aria-label={s.muted ? 'Unmute Watson' : 'Mute Watson'}
      title={s.muted ? 'Unmute Watson' : 'Mute Watson'}
    >
      <Speaker size={16} off={s.muted} />
    </button>
  )
}

export function Overlay() {
  const [s, setS] = useState<UIState | null>(null)
  const [hover, setHover] = useState(false)
  const [hoverLong, setHoverLong] = useState(false)
  useEffect(() => {
    if (!hover) return setHoverLong(false)
    const t = setTimeout(() => setHoverLong(true), 220)
    return () => clearTimeout(t)
  }, [hover])
  const [contentRef, contentH] = useMeasuredHeight()
  const prevArea = useRef(0)
  const growDir = useRef(true)

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
        flushOpenDraft?.()
        window.watson.setArranging(false)
        window.watson.dismiss()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const mode: Mode = s ? modeOf(s) : 'pill'
  const hold = useHoldToMove(() => window.watson.toggleListen(), mode === 'pill')

  if (!s) return null

  const jobs = s.jobs.filter((j) => !['done', 'failed'].includes(j.status))
  // At rest it's a circle (unless the user chose the pill); it grows to say what's going on.
  const shown = s.arranging ? null : live
  // Hovering the pill shows two small shortcuts beside it: the dashboard and live talk.
  const quick = mode === 'pill' && hoverLong && !s.arranging && !hold.holding
  const circle = mode === 'pill' && s.pillShape === 'circle' && !shown
  const pillText = shown?.text ?? 'Watson'
  const width = mode === 'pill' ? (circle ? 38 : pillWidth(pillText)) + (quick ? 64 : 0) : WIDTH[mode]
  // Keep the island inside the window: near a screen edge it shifts instead of being cut off.
  const left = Math.max(8, Math.min(760 - width - 8, s.layout.centerX - width / 2))
  const up = s.layout.dir === 'up'
  const height = circle ? 38 : contentH || 38
  const area = width * height
  // Re-renders at the same size keep the direction the island is already moving in.
  if (area !== prevArea.current) growDir.current = area > prevArea.current
  prevArea.current = area
  const growing = growDir.current

  const enter = () => {
    setHover(true)
    window.watson.setInteractive(true)
  }
  const leave = () => {
    setHover(false)
    window.watson.setInteractive(false)
  }

  // Typing goes into the same editor as dictation: one place for unsent words.
  const startTyping = () => window.watson.takeOver('')

  return (
    <div className="stage">
      <motion.div
        className={`island${hold.holding ? ' lifted' : ''}${circle ? ' circle' : ''}`}
        data-mode={mode}
        data-phase={s.phase}
        data-capture={s.capture}
        onMouseEnter={enter}
        onMouseLeave={leave}
        initial={false}
        style={up ? { bottom: 4, top: 'auto', transformOrigin: '50% 100%' } : { top: 4, bottom: 'auto', transformOrigin: '50% 0%' }}
        animate={{ left, width, height, borderRadius: mode === 'pill' ? 19 : mode === 'compact' ? 31 : mode === 'dictate' ? 26 : 28, scale: hold.holding ? 1.08 : 1 }}
        whileHover={mode === 'pill' && !hold.holding ? { scale: 1.04 } : undefined}
        transition={islandTransition(growing)}
      >
        <div ref={contentRef} className="island-content" style={{ width }}>
          <AnimatePresence mode="popLayout" initial={false}>
            {mode === 'pill' && (
              <motion.div
                key="pill"
                role="button"
                tabIndex={0}
                aria-label="Talk to Watson"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') window.watson.toggleListen()
                }}
                className={quick ? 'pill quick' : 'pill'}
                {...hold.handlers}
                onContextMenu={(e) => {
                  e.preventDefault()
                  window.watson.pillMenu()
                }}
                {...contentMotion}
                title="Click to talk · right-click for more · hold to move"
              >
                <AnimatePresence initial={false}>
                  {quick && (
                    <motion.button
                      key="dash"
                      className="pill-quick"
                      initial={{ opacity: 0, scale: 0.6 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.6 }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        window.watson.openWindow()
                      }}
                      aria-label="Open the dashboard"
                      title="Dashboard"
                    >
                      <Grid size={13} />
                    </motion.button>
                  )}
                </AnimatePresence>
                <span className="pill-core">
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
                        {shown?.tone === 'unsent' && <Pencil size={11} />}
                        <span className="pill-text">{pillText}</span>
                      </motion.span>
                    </AnimatePresence>
                  )}
                </span>
                <AnimatePresence initial={false}>
                  {quick && (
                    <motion.button
                      key="live"
                      className="pill-quick live"
                      initial={{ opacity: 0, scale: 0.6 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.6 }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        window.watson.talkLive('')
                      }}
                      aria-label="Talk live"
                      title="Talk live"
                    >
                      <Wave size={13} />
                    </motion.button>
                  )}
                </AnimatePresence>
              </motion.div>
            )}

            {mode === 'compact' && (
              <motion.div
                key="compact"
                className="compact"
                onClick={() => window.watson.toggleListen()}
                {...contentMotion}
              >
                <Orb phase={s.phase} size={34} />
                <div
                  className={s.phase === 'listening' ? 'compact-text typeable' : 'compact-text'}
                  onClick={(e) => {
                    // Click your words to finish by typing.
                    if (s.phase !== 'listening') return
                    e.stopPropagation()
                    startTyping()
                  }}
                >
                  {s.phase === 'listening' && (
                    <div className={s.transcript ? 'transcript' : 'transcript placeholder'}>
                      {s.transcript || 'Listening…'}
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
                {s.phase === 'listening' && <LiveSwitch s={s} />}
                {s.phase === 'speaking' && <MuteButton s={s} />}
              </motion.div>
            )}

            {mode === 'dictate' && (
              <motion.div
                key="dictate"
                className="dictate"
                {...contentMotion}
              >
                {s.error && <ErrorCard message={s.error} />}
                {s.notice && <div className="card notice">{s.notice}</div>}
                <DraftEditor s={s} />
              </motion.div>
            )}

            {mode === 'panel' && (
              <motion.div
                key="panel"
                className="panel"
                {...contentMotion}
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
                    <MuteButton s={s} />
                    <button className="icon-btn" onClick={() => window.watson.openWindow()} aria-label="Open the dashboard" title="Dashboard">
                      <Grid size={15} />
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => window.watson.dismiss()}
                      aria-label="Close"
                    >
                      <Close size={15} />
                    </button>
                  </div>
                </header>

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

                </>

                <footer className="panel-foot">
                  <button className="reply-bar" onClick={startTyping} aria-label="Type a reply">
                    <Keyboard size={14} />
                    <span>Reply…</span>
                  </button>
                  <span className="cost" title="Spent on the Claude API today">${s.usageTodayUsd.toFixed(3)}</span>
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
