import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import path from 'node:path'
import type { Block, Panel, PermissionStatus, RunningApp, SecretName, Settings, StockRange, UIState, VoiceInfo } from '@shared/types'
import { Brain, BudgetError, type ToolHost } from './brain'
import { Delegations } from './delegate'
import { Helper, type HelperEvent } from './helper'
import { getSettings, secretStatus, setSecret, updateSettings } from './settings'
import { Speaker } from './speaker'
import { Store } from './store'
import { getStock } from './tools/stocks'
import * as spotify from './tools/spotify'
import { spentToday } from './usage'

if (!app.requestSingleInstanceLock()) app.quit()

const store = new Store()
const helper = new Helper()
const brain = new Brain()

let overlay: BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let tray: Tray | null = null

const OVERLAY_W = 760
const OVERLAY_H = 680

// ---------------- Windows ----------------

function rendererUrl(hash = ''): { url?: string; file?: string; hash: string } {
  const dev = process.env['ELECTRON_RENDERER_URL']
  return dev ? { url: `${dev}#${hash}`, hash } : { file: path.join(__dirname, '../renderer/index.html'), hash }
}

function load(win: BrowserWindow, hash = '') {
  const r = rendererUrl(hash)
  if (r.url) void win.loadURL(r.url)
  else void win.loadFile(r.file!, { hash })
}

function overlayBounds() {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  return {
    x: Math.round(workArea.x + (workArea.width - OVERLAY_W) / 2),
    y: workArea.y + 6,
    width: OVERLAY_W,
    height: OVERLAY_H,
  }
}

function createOverlay() {
  overlay = new BrowserWindow({
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
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true },
  })
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  overlay.setIgnoreMouseEvents(true, { forward: true })
  overlay.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  overlay.once('ready-to-show', () => {
    overlay?.showInactive()
    pushState(store.state)
  })
  load(overlay)
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    app.focus({ steal: true })
    return
  }
  settingsWin = new BrowserWindow({
    width: 620,
    height: 760,
    minWidth: 520,
    minHeight: 560,
    title: 'Watson Settings',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true },
  })
  settingsWin.once('ready-to-show', () => {
    settingsWin?.show()
    app.focus({ steal: true })
  })
  settingsWin.on('closed', () => {
    settingsWin = null
    store.set({ hasApiKey: secretStatus().anthropic })
  })
  load(settingsWin, 'settings')
}

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
      const a = Math.min(1, ring + dot)
      const i = (y * size + x) * 4
      buf[i] = 0
      buf[i + 1] = 0
      buf[i + 2] = 0
      buf[i + 3] = Math.round(a * 255)
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 })
  img.setTemplateImage(true)
  return img
}

function createTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip('Watson')
  const menu = Menu.buildFromTemplate([
    { label: `Talk to Watson  (${getSettings().hotkey.replace('Alt', '⌥').replace('+', ' ')})`, click: () => onHotkey() },
    { label: 'New conversation', click: () => { brain.resetConversation(); dismiss() } },
    { type: 'separator' },
    { label: 'Settings…', accelerator: 'Command+,', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Quit Watson', accelerator: 'Command+Q', click: () => app.quit() },
  ])
  tray.setContextMenu(menu)
}

function pushState(s: UIState) {
  overlay?.webContents.send('state', { ...s, usageTodayUsd: spentToday() })
}
store.on('change', pushState)

// ---------------- Hotkey ----------------

let registeredHotkey: string | null = null

function registerHotkey(accel: string) {
  if (registeredHotkey) globalShortcut.unregister(registeredHotkey)
  registeredHotkey = null
  try {
    if (globalShortcut.register(accel, onHotkey)) registeredHotkey = accel
    else store.set({ error: `The shortcut ${accel} is taken by another app. Pick another in Settings.` })
  } catch {
    store.set({ error: `"${accel}" isn't a valid shortcut.` })
  }
}

// ---------------- Voice flow ----------------

let turnAbort: AbortController | null = null
let responding = false
let speakingActive = false
let listening = false
let inputMode: 'voice' | 'text' = 'voice'
let speakSeq = 0
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
    store.set({ error: 'Voice is off: the helper isn\'t running. You can still type below.', expanded: true })
    return
  }
  listening = true
  helper.request('listen.start', { silence: 1.1 }).catch((e: Error) => {
    listening = false
    store.set({ phase: 'idle', error: e.message, expanded: true })
  })
  if (kind === 'fresh') {
    clearTimer('followUp')
    store.set({ phase: 'listening', transcript: '', reply: '', error: null, notice: null })
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
  store.set({ phase: 'idle', transcript: '' })
  armCollapse()
}

function armCollapse() {
  clearTimer('collapse')
  timers.collapse = setTimeout(() => {
    if (hovered || store.state.phase !== 'idle' || store.state.confirm) return armCollapse()
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

function onHelperEvent(e: HelperEvent) {
  switch (e.ev) {
    case 'ready':
      store.set({ helperReady: true })
      configureHelper(getSettings())
      void maybeRequestPermissions()
      break
    case 'level':
      overlay?.webContents.send('level', e.value)
      break
    case 'partial':
      clearTimer('noSpeech')
      clearTimer('followUp')
      if (store.state.phase !== 'listening') store.set({ phase: 'listening', reply: '' })
      store.set({ transcript: e.text })
      break
    case 'final':
      listening = false
      void handleUtterance(e.text, 'voice')
      break
    case 'nospeech':
      listening = false
      if (store.state.phase === 'listening') goIdle()
      break
    case 'bargein':
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
      speakingActive = false
      if (!e.stopped) afterSpeech()
      break
    case 'error':
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
      store.set({ phase: 'thinking', reply: 'Okay, I won\'t send it.' })
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
    delegate: (agent, prompt, sensitive) => delegations.start(agent, prompt, sensitive),
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
    store.finishActivity(thinking, 'done', 'Done')
  } catch (e) {
    if (ac.signal.aborted) return
    const message = e instanceof BudgetError || e instanceof Error ? e.message : String(e)
    store.finishActivity(thinking, 'error', 'Something went wrong')
    store.set({ error: friendlyError(message), reply: '' })
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

function onHotkey() {
  if (overlay && store.state.phase === 'idle') overlay.setBounds(overlayBounds())
  switch (store.state.phase) {
    case 'idle':
      return startListening('fresh')
    case 'listening':
      return store.state.transcript ? stopListening(false) : stopListening(true)
    case 'thinking':
      turnAbort?.abort()
      helper.send('speak.stop')
      return goIdle()
    case 'speaking':
      turnAbort?.abort()
      responding = false
      announceQueue.length = 0
      helper.send('speak.stop')
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
  store.set({ phase: 'idle', panel: null, reply: '', transcript: '', expanded: false, activity: [], error: null, notice: null })
}

// ---------------- Confirmations and hand-offs ----------------

const confirms = new Map<string, (ok: boolean) => void>()
let confirmSeq = 0

function confirm(title: string, body: string, actionLabel: string): Promise<boolean> {
  const id = `c${++confirmSeq}`
  store.set({ confirm: { id, title, body, actionLabel }, expanded: true })
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
  if (store.state.phase === 'idle') {
    inputMode = 'voice'
    store.set({ phase: 'thinking', reply: spoken })
    speakText(spoken)
  } else {
    announceQueue.push(spoken)
  }
}

const delegations = new Delegations({
  helper,
  store,
  confirm,
  summarize: (agent, prompt, reply) => brain.summarize(agent, prompt, reply),
  announce,
})

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

function replaceBlock(match: (b: Block) => boolean, next: Block) {
  const panel = store.state.panel
  if (!panel) return
  store.set({ panel: { ...panel, blocks: panel.blocks.map((b) => (match(b) ? next : b)) } })
}

async function refreshNowPlaying() {
  const np = await spotify.nowPlaying().catch(() => null)
  if (np) replaceBlock((b) => b.type === 'nowPlaying', { type: 'nowPlaying', data: np })
}

setInterval(() => {
  if (store.state.panel?.blocks.some((b) => b.type === 'nowPlaying')) void refreshNowPlaying()
}, 5000)

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.on('ui:interactive', (_e, interactive: boolean) => {
    hovered = interactive
    overlay?.setIgnoreMouseEvents(!interactive, { forward: true })
  })
  // Only take keyboard focus when the user chooses to type, never on hover.
  ipcMain.on('ui:focus', () => overlay?.focus())
  ipcMain.on('ui:toggleListen', () => onHotkey())
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
  ipcMain.on('ui:dismiss', () => dismiss())
  ipcMain.on('ui:confirm', (_e, id: string, ok: boolean) => confirms.get(id)?.(Boolean(ok)))
  ipcMain.on('ui:openSettings', () => openSettings())
  ipcMain.on('ui:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  ipcMain.on('widget:stockRange', async (_e, symbol: string, range: StockRange) => {
    try {
      const s = await getStock(symbol, range)
      replaceBlock((b) => b.type === 'stock' && b.data.symbol === symbol, { type: 'stock', data: s })
    } catch (e) {
      store.set({ error: e instanceof Error ? e.message : String(e) })
    }
  })
  ipcMain.on('widget:spotify', async (_e, action: 'playpause' | 'next' | 'previous') => {
    try {
      await spotify.control(action)
      setTimeout(() => void refreshNowPlaying(), 400)
    } catch (e) {
      store.set({ error: e instanceof Error ? e.message : String(e) })
    }
  })
  ipcMain.on('ui:testVoice', () => {
    if (helper.ready) speakText("Hi, I'm Watson. This is how I sound.")
  })

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const prev = getSettings()
    const next = updateSettings(patch)
    if (next.hotkey !== prev.hotkey) registerHotkey(next.hotkey)
    configureHelper(next)
    return next
  })
  ipcMain.handle('secrets:status', () => secretStatus())
  ipcMain.handle('secrets:set', (_e, name: SecretName, value: string) => {
    const status = setSecret(name, String(value))
    store.set({ hasApiKey: status.anthropic })
    return status
  })
  ipcMain.handle('helper:voices', async () => (helper.ready ? helper.request<VoiceInfo[]>('voices') : []))
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
    }
    const anchor = anchors[pane]
    if (anchor) void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`)
  })
}

// ---------------- App lifecycle ----------------

app.whenReady().then(() => {
  app.setName('Watson')
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
  registerHotkey(getSettings().hotkey)
  helper.on('event', onHelperEvent)
  helper.on('exit', () => store.set({ helperReady: false }))
  helper.start()
  const keys = secretStatus()
  store.set({ hasApiKey: keys.anthropic })
  if (!keys.anthropic) openSettings()
  screen.on('display-metrics-changed', () => overlay?.setBounds(overlayBounds()))
})

app.on('second-instance', () => openSettings())
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  helper.stop()
})
app.on('window-all-closed', () => {
  /* keep running in the menu bar */
})
