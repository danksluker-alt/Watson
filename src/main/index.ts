import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron'
import path from 'node:path'
import type { Block, InputMode, MusicApp, Panel, PermissionStatus, RunningApp, SecretName, Settings, StockRange, UIState, VoiceInfo } from '@shared/types'
import { Brain, BudgetError, type ToolHost } from './brain'
import { Delegations, joinNames } from './delegate'
import { Helper, type HelperEvent } from './helper'
import { PinnedWidgets } from './pinned'
import { installFileLog } from './log'
import { getSettings, secretStatus, setSecret, updateSettings } from './settings'
import { Speaker } from './speaker'
import { Store } from './store'
import * as music from './tools/music'
import { setExecBridge } from './tools/os'
import { installedApps } from './tools/apps'
import { history } from './history'
import { getStock } from './tools/stocks'
import { getCalendar } from './tools/calendar'
import { spentToday } from './usage'
import { timerName, timers as timerStore } from './timers'
import type { TimerItem } from '@shared/types'
import { paramsOf } from './widgets'

// Tests run against a throwaway profile.
if (process.env.WATSON_USER_DATA) app.setPath('userData', process.env.WATSON_USER_DATA)
if (!app.requestSingleInstanceLock()) app.quit()

const store = new Store()
const helper = new Helper()
const brain = new Brain()

let overlay: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let homeWin: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

/** The overlay, if it still exists. During quit its window is destroyed before the helper exits. */
function liveOverlay(): BrowserWindow | null {
  return overlay && !overlay.isDestroyed() && !overlay.webContents.isDestroyed() ? overlay : null
}

// An uncaught error in the main process makes Electron show a modal dialog that freezes Watson
// (and, for a menu-bar app, is often hidden behind other windows). Log it and show it in the pill.
process.on('uncaughtException', (err) => {
  console.error('[watson] uncaught exception:', err?.stack ?? err)
  if (!quitting) store.set({ error: `Something went wrong inside Watson: ${err?.message ?? err}`, expanded: true })
})
process.on('unhandledRejection', (reason) => {
  console.error('[watson] unhandled rejection:', reason instanceof Error ? reason.stack : reason)
})

const OVERLAY_W = 760
const OVERLAY_H = 720
const PRELOAD = () => path.join(__dirname, '../preload/index.js')

// Tests: send macOS shell commands (osascript, pmset) to the fake helper instead.
if (process.env.WATSON_FAKE_OS) setExecBridge((cmd, args, timeoutMs) => helper.request<string>('exec', { program: cmd, args }, timeoutMs))

// ---------------- Windows ----------------

function load(win: BrowserWindow, hash = '') {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) void win.loadURL(`${dev}#${hash}`)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash })
}

/** Tests run the real app; WATSON_INVISIBLE keeps its windows off the user's screen (still rendered for screenshots). */
const INVISIBLE = Boolean(process.env.WATSON_INVISIBLE)

function makeWindow(hash: string, opts: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  const win = new BrowserWindow({
    ...opts,
    ...(INVISIBLE ? { focusable: false } : {}),
    webPreferences: { preload: PRELOAD(), sandbox: true, contextIsolation: true, backgroundThrottling: !INVISIBLE },
  })
  if (INVISIBLE) win.setOpacity(0)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  load(win, hash)
  return win
}

// ---------------- Where the pill sits ----------------

/** Gap between the window edge and the island (matches .stage padding). */
const EDGE = 4
const PILL_H = 38

/** The pill's anchor: the middle of its top edge, in screen points, and the display it's on. */
function pillAnchor(): { display: Electron.Display; x: number; y: number } {
  const place = getSettings().pillPlace
  const saved = place ? screen.getAllDisplays().find((d) => d.id === place.displayId) : undefined
  if (saved && place) {
    const wa = saved.workArea
    return { display: saved, x: wa.x + place.fx * wa.width, y: wa.y + place.fy * wa.height }
  }
  // Default: top centre of the screen with the pointer.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return { display, x: display.workArea.x + display.workArea.width / 2, y: display.workArea.y + 6 + EDGE }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * The overlay window for the current anchor. It stays on screen: near an edge the window is
 * pushed inside and the island is offset within it; in the lower half the panel opens upward.
 */
function overlayPlacement(): { bounds: Electron.Rectangle; layout: { centerX: number; dir: 'down' | 'up' } } {
  const { display, x, y } = pillAnchor()
  const wa = display.workArea
  const dir: 'down' | 'up' = y > wa.y + wa.height / 2 ? 'up' : 'down'
  const wx = Math.round(clamp(x - OVERLAY_W / 2, wa.x, wa.x + wa.width - OVERLAY_W))
  const wy = Math.round(dir === 'down' ? clamp(y - EDGE, wa.y, wa.y + wa.height - OVERLAY_H) : clamp(y + PILL_H + EDGE - OVERLAY_H, wa.y, wa.y + wa.height - OVERLAY_H))
  return { bounds: { x: wx, y: wy, width: OVERLAY_W, height: Math.min(OVERLAY_H, wa.height) }, layout: { centerX: Math.round(x - wx), dir } }
}

function overlayBounds() {
  return overlayPlacement().bounds
}

/** Put the overlay where the pill belongs and tell the renderer where the island sits in it. */
function placeOverlay() {
  const win = liveOverlay()
  if (!win || dragging) return
  const { bounds, layout } = overlayPlacement()
  win.setBounds(bounds)
  const cur = store.state.layout
  if (cur.centerX !== layout.centerX || cur.dir !== layout.dir) store.set({ layout })
}

// Dragging: the window follows the pointer; on release the new spot is saved.
let dragging: { cursor0: Electron.Point; win0: Electron.Point; anchor0: { x: number; y: number }; startedAt: number; timer: NodeJS.Timeout } | null = null

function startPillDrag() {
  const win = liveOverlay()
  if (!win || dragging) return
  const [x, y] = win.getPosition()
  const a = pillAnchor()
  dragging = {
    cursor0: screen.getCursorScreenPoint(),
    win0: { x, y },
    anchor0: { x: a.x, y: a.y },
    startedAt: Date.now(),
    timer: setInterval(() => {
      if (!dragging) return
      // Safety net: if the release never reached the pill, stop following the cursor.
      if (Date.now() - dragging.startedAt > 30_000) return endPillDrag()
      const c = screen.getCursorScreenPoint()
      liveOverlay()?.setPosition(Math.round(dragging.win0.x + c.x - dragging.cursor0.x), Math.round(dragging.win0.y + c.y - dragging.cursor0.y))
    }, 16),
  }
}

function endPillDrag() {
  if (!dragging) return
  clearInterval(dragging.timer)
  const c = screen.getCursorScreenPoint()
  const moved = Math.hypot(c.x - dragging.cursor0.x, c.y - dragging.cursor0.y)
  const x = dragging.anchor0.x + c.x - dragging.cursor0.x
  const y = dragging.anchor0.y + c.y - dragging.cursor0.y
  dragging = null
  if (moved > 3) {
    const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
    const wa = display.workArea
    const cx = clamp(x, wa.x + 24, wa.x + wa.width - 24)
    const cy = clamp(y, wa.y + EDGE, wa.y + wa.height - PILL_H - EDGE)
    // Dropped near the top centre: snap back to the default spot.
    const nearHome = Math.abs(cx - (wa.x + wa.width / 2)) < 60 && cy - wa.y < 48
    updateSettings({ pillPlace: nearHome ? null : { displayId: display.id, fx: (cx - wa.x) / wa.width, fy: (cy - wa.y) / wa.height } })
  }
  placeOverlay()
}

function createOverlay() {
  overlay = makeWindow('', {
    ...overlayBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    type: 'panel',
    show: false,
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  overlay.setIgnoreMouseEvents(true, { forward: true })
  overlay.once('ready-to-show', () => {
    store.set({ layout: overlayPlacement().layout, pillShape: getSettings().pillShape })
    overlay?.showInactive()
    pushState(store.state)
  })
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    if (!INVISIBLE) app.focus({ steal: true })
    return
  }
  settingsWin = makeWindow('settings', {
    width: 640,
    height: 780,
    minWidth: 540,
    minHeight: 560,
    title: 'Watson Settings',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    show: false,
  })
  settingsWin.once('ready-to-show', () => {
    if (INVISIBLE) return void settingsWin?.showInactive()
    settingsWin?.show()
    app.focus({ steal: true })
  })
  settingsWin.on('closed', () => {
    settingsWin = null
    store.set({ hasApiKey: secretStatus().anthropic })
  })
}

/** The Watson window: recent requests as a chat, every hand-off, and anything waiting for an OK. */
function openWindow(opts: { quiet?: boolean } = {}) {
  if (homeWin && !homeWin.isDestroyed()) {
    if (opts.quiet) homeWin.showInactive()
    else {
      homeWin.show()
      homeWin.focus()
      if (!INVISIBLE) app.focus({ steal: true })
    }
    return
  }
  homeWin = makeWindow('home', {
    width: 940,
    height: 700,
    minWidth: 640,
    minHeight: 480,
    title: 'Watson',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#141416',
    show: false,
  })
  homeWin.once('ready-to-show', () => {
    if (INVISIBLE || opts.quiet) homeWin?.showInactive()
    else {
      homeWin?.show()
      app.focus({ steal: true })
    }
  })
  homeWin.on('closed', () => {
    homeWin = null
  })
}

const pinned = new PinnedWidgets(helper, makeWindow)

/** A small ring-and-dot glyph for the menu bar, drawn in code so there's no image file to ship. */
function trayIcon() {
  const size = 36
  const buf = Buffer.alloc(size * size * 4)
  const c = size / 2 - 0.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c)
      const ring = Math.max(0, 1 - Math.abs(d - 12.5) / 1.6)
      const dot = Math.max(0, Math.min(1, 5.5 - d))
      buf[(y * size + x) * 4 + 3] = Math.round(Math.min(1, ring + dot) * 255)
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 })
  img.setTemplateImage(true)
  return img
}

const keyLabel = (accel: string) => accel.replace('Alt', '⌥').replace('Shift', '⇧').replace('Command', '⌘').replace(/\+/g, ' ')

function buildTrayMenu() {
  if (!tray) return
  const s = getSettings()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Talk to Watson    ${keyLabel(s.hotkey)}`, click: () => onHotkey('live') },
      { label: `Dictate & review    ${keyLabel(s.reviewHotkey)}`, click: () => onHotkey('review') },
      { type: 'separator' },
      {
        label: 'When I press the main shortcut',
        submenu: [
          { label: 'Answer right away (live)', type: 'radio', checked: s.inputMode === 'live', click: () => setSettings({ inputMode: 'live' }) },
          { label: 'Show my words to edit first (review)', type: 'radio', checked: s.inputMode === 'review', click: () => setSettings({ inputMode: 'review' }) },
        ],
      },
      { label: 'Open Watson', click: () => openWindow() },
      { label: 'New conversation', click: () => { brain.resetConversation(); dismiss() } },
      { label: 'Remove pinned widgets', enabled: pinned.list().length > 0, click: () => { pinned.removeKind('all'); buildTrayMenu() } },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'Command+,', click: () => openSettings() },
      { type: 'separator' },
      { label: 'Quit Watson', accelerator: 'Command+Q', click: () => app.quit() },
    ]),
  )
}

function createTray() {
  try {
    tray = new Tray(trayIcon())
    tray.setToolTip('Watson')
    buildTrayMenu()
  } catch (e) {
    console.warn('[watson] no menu bar icon:', e)
  }
}

function pushState(s: UIState) {
  const st = { ...s, usageTodayUsd: spentToday() }
  liveOverlay()?.webContents.send('state', st)
  if (homeWin && !homeWin.isDestroyed()) homeWin.webContents.send('state', st)
  // Hand-offs go to history as they progress.
  for (const j of s.jobs) history.upsertJob(j)
}
store.on('change', pushState)

function syncFromSettings(s: Settings) {
  store.set({
    agents: s.agents.filter((a) => a.enabled).map((a) => ({ id: a.id, name: a.name })),
    sounds: s.sounds,
    capture: store.state.phase === 'idle' && !store.state.draft ? s.inputMode : store.state.capture,
  })
}

function setSettings(patch: Partial<Settings>): Settings {
  const prev = getSettings()
  const next = updateSettings(patch)
  if (next.hotkey !== prev.hotkey || next.reviewHotkey !== prev.reviewHotkey) registerHotkeys()
  configureHelper(next)
  syncFromSettings(next)
  if ('pillPlace' in patch) placeOverlay()
  if (next.pillShape !== store.state.pillShape) store.set({ pillShape: next.pillShape })
  buildTrayMenu()
  return next
}

// ---------------- Hotkeys ----------------

function registerHotkeys() {
  globalShortcut.unregisterAll()
  const s = getSettings()
  const bad: string[] = []
  for (const [accel, mode] of [
    [s.hotkey, s.inputMode],
    [s.reviewHotkey, 'review'],
  ] as const) {
    if (!accel) continue
    try {
      // The main shortcut follows the chosen mode at the moment it's pressed.
      const ok = globalShortcut.register(accel, () => onHotkey(accel === s.hotkey ? getSettings().inputMode : mode))
      if (!ok) bad.push(accel)
    } catch {
      bad.push(accel)
    }
  }
  console.log(`[watson] hotkeys: ${[s.hotkey, s.reviewHotkey].filter(Boolean).map((a) => `${a} ${globalShortcut.isRegistered(a) ? 'ok' : 'FAILED'}`).join(', ')}`)
  if (bad.length) store.set({ error: `${bad.join(' and ')} ${bad.length > 1 ? 'are' : 'is'} taken by another app. Pick another shortcut in Settings.` })
}

// ---------------- Voice flow ----------------

let turnAbort: AbortController | null = null
let responding = false
let speakingActive = false
let listening = false
let inputMode: 'voice' | 'text' = 'voice'
let speakSeq = 0
let draftSeq = 0
let turnPanel: Panel | null = null
let hovered = false
const announceQueue: string[] = []
const timers: Record<'noSpeech' | 'followUp' | 'collapse', NodeJS.Timeout | null> = { noSpeech: null, followUp: null, collapse: null }

function clearTimer(name: keyof typeof timers) {
  if (timers[name]) clearTimeout(timers[name]!)
  timers[name] = null
}

function say(sentence: string) {
  helper.send('speak', { speakId: `s${++speakSeq}`, text: sentence })
  speakingActive = true
}

function speakText(text: string) {
  const speaker = new Speaker(say)
  speaker.push(text)
  speaker.flush()
}

function startListening(kind: 'fresh' | 'watch') {
  if (!helper.ready) {
    store.set({ error: "Voice is off: the helper isn't running. You can still type.", expanded: true })
    return
  }
  listening = true
  console.log(`[watson] listen.start (${kind}, ${store.state.capture})`)
  helper.request('listen.start', { silence: store.state.capture === 'review' ? 1.8 : 1.1 }).catch((e: Error) => {
    console.error('[watson] listen.start failed:', e.message)
    listening = false
    store.set({ phase: 'idle', error: e.message, expanded: true })
  })
  if (kind === 'fresh') {
    clearTimer('followUp')
    store.set({ phase: 'listening', transcript: '', reply: store.state.draft ? store.state.reply : '', error: null, notice: null })
    clearTimer('noSpeech')
    timers.noSpeech = setTimeout(() => {
      if (store.state.phase === 'listening' && !store.state.transcript) stopListening(true)
    }, 8000)
  }
}

function stopListening(cancel: boolean) {
  clearTimer('noSpeech')
  clearTimer('followUp')
  if (!listening) {
    if (store.state.phase === 'listening') goIdle()
    return
  }
  helper.send(cancel ? 'listen.cancel' : 'listen.stop')
  if (cancel) {
    listening = false
    goIdle()
  }
}

function goIdle() {
  clearTimer('noSpeech')
  clearTimer('followUp')
  store.set({ phase: 'idle', transcript: '', capture: store.state.draft ? 'review' : getSettings().inputMode })
  armCollapse()
  // An agent's answer that arrived while Watson was busy is read out now.
  const next = !store.state.draft && helper.ready ? announceQueue.shift() : undefined
  if (next) {
    inputMode = 'voice'
    store.set({ phase: 'thinking', reply: next })
    speakText(next)
  }
}

function armCollapse() {
  clearTimer('collapse')
  timers.collapse = setTimeout(() => {
    if (hovered || store.state.phase !== 'idle' || store.state.confirm || store.state.draft) return armCollapse()
    store.set({ panel: null, reply: '', expanded: false, activity: [] })
  }, 90_000)
}

function afterSpeech() {
  if (responding) return
  const next = announceQueue.shift()
  if (next) {
    store.set({ phase: 'thinking', reply: next })
    speakText(next)
    return
  }
  if (inputMode !== 'voice') return goIdle()
  // Conversation mode: keep listening briefly for a follow-up.
  if (!listening) startListening('watch')
  store.set({ phase: 'listening', transcript: '' })
  clearTimer('followUp')
  const seconds = store.state.confirm ? 20 : getSettings().followUpSeconds
  timers.followUp = setTimeout(() => {
    if (store.state.phase === 'listening' && !store.state.transcript) stopListening(true)
  }, seconds * 1000)
}

/** Review mode: words go into an editable draft instead of straight to Watson. */
function appendDraft(text: string) {
  const prev = store.state.draft?.text.trim()
  const joined = prev ? `${prev} ${text.trim()}` : text.trim()
  store.set({ draft: { id: ++draftSeq, text: joined }, phase: 'idle', transcript: '', capture: 'review', expanded: true })
  clearTimer('noSpeech')
  liveOverlay()?.focus() // so the text can be edited right away
}

function onHelperEvent(e: HelperEvent) {
  switch (e.ev) {
    case 'ready':
      store.set({ helperReady: true })
      configureHelper(getSettings())
      void maybeRequestPermissions()
      break
    case 'level':
      liveOverlay()?.webContents.send('level', e.value)
      break
    case 'partial':
      // Talking to Watson acknowledges a timer that's ringing.
      if (store.state.ringing) stopRinging()
      clearTimer('noSpeech')
      clearTimer('followUp')
      if (store.state.phase !== 'listening') store.set({ phase: 'listening', reply: store.state.draft ? store.state.reply : '' })
      store.set({ transcript: e.text })
      break
    case 'final':
      console.log(`[watson] heard ${e.text.split(/\s+/).filter(Boolean).length} words (${store.state.capture})`)
      listening = false
      if (store.state.capture === 'review') appendDraft(e.text)
      else void handleUtterance(e.text, 'voice')
      break
    case 'nospeech':
      console.log('[watson] no speech')
      listening = false
      if (store.state.phase === 'listening') goIdle()
      break
    case 'bargein':
      console.log('[watson] interrupted by the user')
      if (store.state.ringing) stopRinging()
      turnAbort?.abort()
      responding = false
      speakingActive = false
      announceQueue.length = 0
      store.set({ phase: 'listening', transcript: '', reply: '' })
      break
    case 'speak.start':
      speakingActive = true
      if (store.state.phase !== 'speaking') store.set({ phase: 'speaking' })
      if (!listening) startListening('watch') // so you can interrupt
      break
    case 'speak.idle':
      console.log(`[watson] finished speaking${e.stopped ? ' (stopped)' : ''}`)
      speakingActive = false
      if (!e.stopped) afterSpeech()
      break
    case 'error':
      console.error('[helper] error:', e.message)
      store.set({ error: e.message })
      break
  }
}

const YES = /^(yes|yeah|yep|sure|send( it)?|do it|go( ahead)?|confirm|ok(ay)?)\b/i
const NO = /^(no|nope|cancel|stop|don'?t|never ?mind|wait)\b/i
const BYE = /^(stop|cancel|never ?mind|nothing|that'?s (all|it)|thanks?|thank you|goodbye|bye)[.!]?$/i

async function handleUtterance(raw: string, mode: 'voice' | 'text') {
  const text = raw.trim()
  clearTimer('followUp')
  if (!text) return goIdle()
  inputMode = mode
  store.set({ transcript: text, error: null })

  const pending = store.state.confirm
  if (pending) {
    const resolve = confirms.get(pending.id)
    if (YES.test(text)) {
      resolve?.(true)
      store.set({ phase: 'thinking', reply: 'Sending.' })
      return mode === 'voice' ? speakText('Sending.') : goIdle()
    }
    if (NO.test(text)) {
      resolve?.(false)
      store.set({ phase: 'thinking', reply: "Okay, I won't send it." })
      return mode === 'voice' ? speakText("Okay, I won't send it.") : goIdle()
    }
  }
  if (mode === 'voice' && BYE.test(text)) {
    store.set({ reply: '' })
    return goIdle()
  }
  await runTurn(text, mode)
}

async function runTurn(text: string, mode: 'voice' | 'text') {
  turnAbort?.abort()
  if (speakingActive) helper.send('speak.stop')
  speakingActive = false
  const ac = new AbortController()
  turnAbort = ac
  responding = true
  turnPanel = null
  clearTimer('collapse')
  store.set({ phase: 'thinking', reply: '', panel: null, activity: [], expanded: mode === 'text' || store.state.expanded })
  const thinking = store.activity('Thinking')
  let reply = ''
  const speaker = new Speaker((s) => {
    if (mode === 'voice' && !ac.signal.aborted) say(s)
  })
  const host: ToolHost = {
    helper,
    addBlocks: (blocks: Block[], meta) => {
      if (ac.signal.aborted) return
      turnPanel = {
        title: meta?.title ?? turnPanel?.title,
        subtitle: meta?.subtitle ?? turnPanel?.subtitle,
        blocks: [...(turnPanel?.blocks ?? []), ...blocks],
      }
      store.set({ panel: turnPanel, expanded: true })
    },
    activity: (t) => store.activity(t),
    finishActivity: (id, ok, t) => store.finishActivity(id, ok ? 'done' : 'error', t),
    delegate: async (agent, prompt, sensitive, newChat, attachPrevious) => {
      const attach = attachPrevious ? previousAnswer() : undefined
      if (attachPrevious && !attach) throw new Error('There is no earlier answer from one of your AIs to pass along. Ask the user what to send.')
      const { note, job } = await delegations.start(agent, prompt, sensitive, { newChat, attach })
      host.addBlocks([{ type: 'delegation', data: job }])
      return note
    },
    askSeveral: async (agents, prompt, sensitive, attachPrevious) => {
      const attach = attachPrevious ? previousAnswer() : undefined
      if (attachPrevious && !attach) throw new Error('There is no earlier answer from one of your AIs to pass along. Ask the user what to send.')
      const { note, jobs } = await delegations.startGroup(agents, prompt, sensitive, { attach })
      host.addBlocks(jobs.map((job) => ({ type: 'delegation' as const, data: job })))
      return note
    },
    pin: async (kind, params, where) => {
      const id = await pinned.add(kind, params, where)
      buildTrayMenu()
      return id
    },
    unpin: (kind) => {
      pinned.removeKind(kind)
      buildTrayMenu()
    },
  }
  try {
    await brain.respond(text, {
      spoken: mode === 'voice',
      signal: ac.signal,
      host,
      onText: (d) => {
        if (ac.signal.aborted) return
        reply += d
        store.set({ reply })
        speaker.push(d)
      },
    })
    if (ac.signal.aborted) return
    speaker.flush()
    store.removeActivity(thinking)
    const shown = turnPanel as Panel | null // set by tools during the turn
    history.addTurn({ mode, you: text, watson: reply.trim(), title: shown?.title, blocks: shown?.blocks })
  } catch (e) {
    if (ac.signal.aborted) return
    const message = e instanceof BudgetError || e instanceof Error ? e.message : String(e)
    console.error('[watson] answer failed:', message.slice(0, 300))
    store.finishActivity(thinking, 'error', 'Something went wrong')
    store.set({ error: friendlyError(message), reply: '' })
    history.addTurn({ mode, you: text, watson: `⚠︎ ${friendlyError(message)}` })
    if (mode === 'voice') speakText(e instanceof BudgetError ? message : 'Sorry, something went wrong. The details are on screen.')
  } finally {
    if (turnAbort === ac) {
      turnAbort = null
      responding = false
    }
  }
  if (ac.signal.aborted) return
  if (mode === 'voice') {
    if (!speakingActive) afterSpeech()
  } else goIdle()
}

function friendlyError(message: string): string {
  if (/401|authentication|api key/i.test(message)) return 'The Anthropic API key was rejected. Check it in Settings.'
  if (/credit balance|billing/i.test(message)) return 'Your Anthropic account is out of credits. Add some at console.anthropic.com.'
  if (/429|rate limit/i.test(message)) return 'The API is rate-limiting Watson. Try again in a moment.'
  if (/ENOTFOUND|fetch failed|network/i.test(message)) return 'No internet connection.'
  return message
}

const OWN_APP = /^(com\.github\.Electron|com\.watson\.assistant)$/

async function rememberInsertTarget() {
  try {
    const f = await helper.request<{ bundleId?: string; name?: string }>('frontmost', {}, 3000)
    if (f.bundleId && !OWN_APP.test(f.bundleId)) store.set({ insertTarget: f.bundleId, insertTargetName: f.name ?? null })
  } catch {
    /* not critical */
  }
}

let lastHotkeyAt = 0

function onHotkey(mode: InputMode) {
  if (store.state.ringing) return stopRinging()
  const sinceLast = Date.now() - lastHotkeyAt
  lastHotkeyAt = Date.now()
  console.log(`[watson] hotkey (${mode}) while ${store.state.phase}`)
  if (liveOverlay() && store.state.phase === 'idle') placeOverlay()
  switch (store.state.phase) {
    case 'idle':
      // Remember the app you were in, so dictation can be typed back into it.
      void rememberInsertTarget()
      store.set({ capture: store.state.draft ? 'review' : mode })
      return startListening('fresh')
    case 'listening':
      return store.state.transcript ? stopListening(false) : stopListening(true)
    case 'thinking':
      // A second press right after the one that sent the request is almost always a double
      // press, not "cancel": keep the request.
      if (sinceLast < 1500) return console.log('[watson] ignored a quick second press while thinking')
      turnAbort?.abort()
      helper.send('speak.stop')
      return goIdle()
    case 'speaking':
      turnAbort?.abort()
      responding = false
      announceQueue.length = 0
      helper.send('speak.stop')
      store.set({ capture: mode })
      return startListening('fresh')
  }
}

function dismiss() {
  turnAbort?.abort()
  helper.send('speak.stop')
  if (listening) helper.send('listen.cancel')
  listening = false
  announceQueue.length = 0
  const pending = store.state.confirm
  if (pending) confirms.get(pending.id)?.(false)
  clearTimer('noSpeech')
  clearTimer('followUp')
  store.set({
    phase: 'idle',
    panel: null,
    reply: '',
    transcript: '',
    expanded: false,
    activity: [],
    error: null,
    notice: null,
    draft: null,
    capture: getSettings().inputMode,
  })
}

/** The user edited their dictated words and chose where they go. */
async function submitDraft(text: string, target: string) {
  const t = text.trim()
  store.set({ draft: null, capture: getSettings().inputMode })
  if (!t) return goIdle()
  if (target === 'watson') return handleUtterance(t, helper.ready ? 'voice' : 'text')
  if (target === 'insert') {
    const to = store.state.insertTarget
    if (!to) {
      store.set({ error: "I don't know which app you were in. Click into it and dictate again.", draft: { id: ++draftSeq, text: t } })
      return
    }
    const act = store.activity('Typing into your app')
    try {
      await helper.request('ax.insert', { bundleId: to, text: t }, 20_000)
      store.finishActivity(act, 'done', 'Typed into your app')
      store.set({ expanded: false, panel: null, reply: '', transcript: '' })
      goIdle()
    } catch (e) {
      store.finishActivity(act, 'error')
      store.set({ error: e instanceof Error ? e.message : String(e), draft: { id: ++draftSeq, text: t } })
    }
    return
  }
  try {
    const { job } = await delegations.start(target, t, false, { reviewed: true, newChat: true })
    store.set({ transcript: t, reply: '', panel: { title: `Sent to ${job.agent}`, blocks: [{ type: 'delegation', data: job }] }, expanded: true, phase: 'idle' })
    armCollapse()
  } catch (e) {
    store.set({ error: e instanceof Error ? e.message : String(e), draft: { id: ++draftSeq, text: t } })
  }
}

// ---------------- Confirmations and hand-offs ----------------

const confirms = new Map<string, (ok: boolean) => void>()
let confirmSeq = 0

function confirm(title: string, body: string, actionLabel: string): Promise<boolean> {
  const id = `c${++confirmSeq}`
  store.set({ confirm: { id, title, body, actionLabel }, expanded: true })
  if (getSettings().openWindowOnConfirm) openWindow({ quiet: true })
  return new Promise((resolve) => {
    confirms.set(id, (ok) => {
      confirms.delete(id)
      if (store.state.confirm?.id === id) store.set({ confirm: null })
      resolve(ok)
    })
  })
}

function announce(spoken: string, panel: Panel | null) {
  if (panel) store.set({ panel, expanded: true })
  armCollapse()
  if (!helper.ready) {
    store.set({ notice: spoken })
    return
  }
  // Waiting quietly for a follow-up counts as free: stop listening and speak now.
  const quietFollowUp = store.state.phase === 'listening' && !store.state.transcript && !responding && !speakingActive
  if (quietFollowUp) {
    clearTimer('followUp')
    clearTimer('noSpeech')
    if (listening) helper.send('listen.cancel')
    listening = false
  }
  if ((store.state.phase === 'idle' || quietFollowUp) && !store.state.draft) {
    inputMode = 'voice'
    store.set({ phase: 'thinking', reply: spoken })
    speakText(spoken)
  } else {
    announceQueue.push(spoken)
  }
}

// ---------------- Glance: what the pill can show on its own ----------------

/** The next event from Calendar, so the pill can mention it when it's close. Local, no API calls. */
async function refreshGlance() {
  if (!helper.ready) return
  try {
    const now = Date.now()
    const today = await getCalendar(helper, 'today')
    const next = today.days
      .flatMap((d) => d.events)
      .filter((e) => !e.allDay && e.end > now && e.start < now + 3 * 3600_000)
      .sort((a, b) => a.start - b.start)[0]
    store.set({ glance: { nextEvent: next ? { title: next.title, start: next.start, end: next.end } : undefined } })
  } catch {
    store.set({ glance: {} }) // no Calendar access: just don't show it
  }
}

// ---------------- Timers ----------------

let ringTimeout: NodeJS.Timeout | null = null

function stopRinging() {
  if (ringTimeout) clearTimeout(ringTimeout)
  ringTimeout = null
  if (store.state.ringing) store.set({ ringing: null })
}

function onTimerFire(t: TimerItem) {
  const name = timerName(t)
  console.log(`[watson] ${t.kind} went off`)
  store.set({ ringing: t, expanded: true })
  if (Notification.isSupported()) new Notification({ title: t.kind === 'alarm' ? 'Alarm' : 'Timer done', body: name.charAt(0).toUpperCase() + name.slice(1), silent: true }).show()
  announce(t.kind === 'alarm' ? `It's time${t.label ? ` for ${t.label}` : ''}. Your alarm is going off.` : `Your ${name} is done.`, null)
  // The chime repeats in the pill until it's dismissed, for up to a minute.
  if (ringTimeout) clearTimeout(ringTimeout)
  ringTimeout = setTimeout(stopRinging, 60_000)
}

const delegations = new Delegations({
  helper,
  store,
  confirm,
  summarize: (agent, prompt, reply) => brain.summarize(agent, prompt, reply),
  compare: (prompt, answers) => brain.compare(prompt, answers),
  compared: (c) => history.addCompare(c),
  announce,
})

/**
 * The most recent answer from one of the user's AIs, for "send that to Claude". A compared
 * question passes every answer along, labelled, so another AI can weigh them.
 */
function previousAnswer(): { from: string; text: string } | undefined {
  const done = [...store.state.jobs, ...history.get().jobs].filter((j) => j.status === 'done' && j.reply?.trim())
  const last = done.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
  if (!last) return undefined
  if (!last.groupId) return { from: last.agent, text: last.reply ?? '' }
  const group = [...new Map(done.filter((j) => j.groupId === last.groupId).map((j) => [j.agent, j])).values()]
  return { from: joinNames(group.map((j) => j.agent)), text: group.map((j) => `${j.agent}:\n${j.reply}`).join('\n\n') }
}

// ---------------- Helper setup ----------------

function configureHelper(s: Settings) {
  helper.send('configure', { locale: s.speechLocale, voiceId: s.voiceId, rate: s.speechRate, echoCancellation: s.echoCancellation })
}

async function maybeRequestPermissions() {
  try {
    const p = await helper.request<PermissionStatus>('permissions')
    if (p.microphone === 'unknown' || p.speech === 'unknown') await helper.request('permissions.request', {}, 120_000)
  } catch {
    /* shown in Settings */
  }
}

// ---------------- Widgets ----------------

function replaceBlocks(match: (b: Block) => boolean, next: Block, params?: Record<string, string>) {
  const panel = store.state.panel
  if (panel?.blocks.some(match)) store.set({ panel: { ...panel, blocks: panel.blocks.map((b) => (match(b) ? next : b)) } })
  pinned.update(match, next, params)
}

async function refreshNowPlaying(app: MusicApp) {
  const np = await music.nowPlaying(app).catch(() => null)
  if (np) replaceBlocks((b) => b.type === 'nowPlaying' && b.data.app === app, { type: 'nowPlaying', data: np })
}

setInterval(() => {
  const np = store.state.panel?.blocks.find((b) => b.type === 'nowPlaying')
  if (np?.type === 'nowPlaying') void refreshNowPlaying(np.data.app)
}, 5000)

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.on('ui:interactive', (_e, interactive: boolean) => {
    hovered = interactive
    liveOverlay()?.setIgnoreMouseEvents(!interactive, { forward: true })
  })
  // Only take keyboard focus when the user chooses to type, never on hover.
  ipcMain.on('ui:focus', () => liveOverlay()?.focus())
  ipcMain.on('ui:toggleListen', () => onHotkey(store.state.draft ? 'review' : getSettings().inputMode))
  ipcMain.on('ui:ask', (_e, text: string) => {
    if (listening) helper.send('listen.cancel')
    listening = false
    void handleUtterance(String(text).slice(0, 4000), 'text')
  })
  ipcMain.on('ui:cancel', () => {
    turnAbort?.abort()
    helper.send('speak.stop')
    stopListening(true)
  })
  ipcMain.on('ui:dismiss', () => {
    stopRinging()
    dismiss()
  })
  ipcMain.on('ui:openWindow', () => openWindow())
  ipcMain.handle('history:get', () => history.get())
  ipcMain.on('history:clear', () => history.clear())
  ipcMain.on('pill:drag', (_e, phase: string) => (phase === 'start' ? startPillDrag() : endPillDrag()))
  ipcMain.on('pill:shape', (_e, shape: string) => {
    const pillShape = shape === 'circle' ? 'circle' : 'pill'
    updateSettings({ pillShape })
    store.set({ pillShape })
  })
  ipcMain.on('pill:reset', () => {
    updateSettings({ pillPlace: null })
    placeOverlay()
  })
  ipcMain.on('pill:arranging', (_e, on: boolean) => store.set({ arranging: Boolean(on) }))
  ipcMain.on('timer:cancel', (_e, id: string) => timerStore.cancel(String(id)))
  ipcMain.on('timer:stopRinging', () => stopRinging())
  ipcMain.on('ui:confirm', (_e, id: string, ok: boolean) => confirms.get(id)?.(Boolean(ok)))
  ipcMain.on('ui:openSettings', () => openSettings())
  ipcMain.on('ui:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  ipcMain.on('ui:setCapture', (_e, mode: InputMode) => store.set({ capture: mode === 'review' ? 'review' : 'live' }))
  ipcMain.on('ui:dictate', (_e, text: string) => {
    // Keep the user's edits, then listen for more words to add.
    store.set({ draft: { id: store.state.draft?.id ?? ++draftSeq, text: String(text ?? '') }, capture: 'review' })
    if (store.state.phase === 'listening') return stopListening(false)
    startListening('fresh')
  })
  ipcMain.on('ui:submitDraft', (_e, text: string, target: string) => {
    if (listening) helper.send('listen.cancel')
    listening = false
    void submitDraft(String(text ?? '').slice(0, 8000), String(target || 'watson'))
  })
  ipcMain.on('ui:cancelDraft', () => {
    if (listening) helper.send('listen.cancel')
    listening = false
    store.set({ draft: null, error: null })
    goIdle()
  })
  ipcMain.on('ui:pin', async (_e, block: Block) => {
    const p = paramsOf(block)
    if (!p) return
    await pinned.add(p.kind, p.params, 'this')
    buildTrayMenu()
    store.set({ notice: null })
  })
  ipcMain.on('widget:ready', (_e, id: string) => pinned.ready(id))
  ipcMain.on('widget:size', (_e, id: string, _w: number, h: number) => pinned.resize(id, h))
  ipcMain.on('widget:close', (_e, id: string) => {
    pinned.remove(id)
    buildTrayMenu()
  })
  ipcMain.on('widget:stockRange', async (_e, symbol: string, range: StockRange) => {
    try {
      const s = await getStock(symbol, range)
      replaceBlocks((b) => b.type === 'stock' && b.data.symbol === symbol, { type: 'stock', data: s }, { range })
    } catch (e) {
      store.set({ error: e instanceof Error ? e.message : String(e) })
    }
  })
  ipcMain.on('widget:music', async (_e, app: MusicApp, action: 'playpause' | 'next' | 'previous') => {
    try {
      await music.control(app, action)
      setTimeout(() => void refreshNowPlaying(app), 400)
    } catch (e) {
      store.set({ error: e instanceof Error ? e.message : String(e) })
    }
  })
  ipcMain.on('ui:testVoice', () => {
    if (helper.ready) speakText("Hi, I'm Watson. This is how I sound.")
  })

  // The overlay asks once on load, so it never misses the first state push.
  ipcMain.handle('ui:getState', () => ({ ...store.state, usageTodayUsd: spentToday() }))
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => setSettings(patch))
  ipcMain.handle('secrets:status', () => secretStatus())
  ipcMain.handle('secrets:set', (_e, name: SecretName, value: string) => {
    const status = setSecret(name, String(value))
    console.log(`[watson] key ${name} ${status[name] ? 'saved' : 'cleared'}`)
    store.set({ hasApiKey: status.anthropic })
    return status
  })
  ipcMain.handle('helper:voices', async () => (helper.ready ? helper.request<VoiceInfo[]>('voices') : []))
  ipcMain.handle('apps:installed', () => installedApps().catch(() => []))
  ipcMain.handle('helper:apps', async () => (helper.ready ? helper.request<RunningApp[]>('apps.running') : []))
  ipcMain.handle('helper:permissions', async () => (helper.ready ? helper.request<PermissionStatus>('permissions') : null))
  ipcMain.handle('helper:requestPermissions', async () =>
    helper.ready ? helper.request<PermissionStatus>('permissions.request', {}, 120_000) : null,
  )
  ipcMain.on('helper:openPrivacy', (_e, pane: string) => {
    const anchors: Record<string, string> = {
      Microphone: 'Privacy_Microphone',
      SpeechRecognition: 'Privacy_SpeechRecognition',
      Accessibility: 'Privacy_Accessibility',
      Automation: 'Privacy_Automation',
      Calendars: 'Privacy_Calendars',
      Reminders: 'Privacy_Reminders',
    }
    const anchor = anchors[pane]
    if (anchor) void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`)
  })
}

// ---------------- App lifecycle ----------------

app.whenReady().then(() => {
  app.setName('Watson')
  installFileLog()
  if (process.platform === 'darwin') app.dock?.hide()
  // Without an Edit menu, Cmd+C / Cmd+V don't work in text fields on macOS.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'Watson', submenu: [{ label: 'Settings…', accelerator: 'Command+,', click: () => openSettings() }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]),
  )
  registerIpc()
  createOverlay()
  createTray()
  registerHotkeys()
  syncFromSettings(getSettings())
  helper.on('event', onHelperEvent)
  helper.on('exit', (code) => {
    if (quitting) return
    console.warn('[watson] helper exited with code', code)
    store.set({ helperReady: false })
  })
  helper.start()
  history.load()
  history.on('change', (h) => {
    if (homeWin && !homeWin.isDestroyed()) homeWin.webContents.send('history', h)
  })
  timerStore.on('change', (list: TimerItem[]) => store.set({ timers: list }))
  timerStore.on('fire', onTimerFire)
  timerStore.restore()
  store.set({ timers: timerStore.list() })
  pinned.restore()
  setTimeout(() => void refreshGlance(), 4000)
  setInterval(() => void refreshGlance(), 60_000)
  const keys = secretStatus()
  store.set({ hasApiKey: keys.anthropic })
  if (!keys.anthropic) openSettings()
  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed'] as const) screen.on(ev as 'display-added', () => placeOverlay())
})

app.on('second-instance', () => openSettings())
app.on('before-quit', () => {
  quitting = true
})
app.on('will-quit', () => {
  quitting = true
  globalShortcut.unregisterAll()
  timerStore.stop()
  pinned.stop()
  helper.stop()
})
app.on('window-all-closed', () => {
  /* keep running in the menu bar */
})
