// Types shared by the main process (Node) and the renderer (the pill and panel).

// ---------- Panel: what Watson draws when an answer is visual ----------

export type WeatherData = {
  place: string
  unit: 'C' | 'F'
  now: { temp: number; feelsLike: number; code: number; isDay: boolean; humidity: number; wind: number }
  today: { high: number; low: number; rainChance: number }
  hourly: { time: string; temp: number; code: number; isDay: boolean }[]
  daily: { day: string; high: number; low: number; code: number; rainChance: number }[]
}

export type StockRange = '1D' | '1W' | '1M' | '3M' | '1Y'

export type StockData = {
  symbol: string
  name: string
  currency: string
  price: number
  change: number
  changePct: number
  range: StockRange
  points: { t: number; v: number }[]
  marketState?: string
  source: string
}

export type MusicApp = 'spotify' | 'music'

export type NowPlayingData = {
  app: MusicApp
  state: 'playing' | 'paused' | 'stopped'
  title: string
  artist: string
  album: string
  artworkUrl?: string
  durationSec: number
  positionSec: number
}

export type DelegationStatus = 'confirming' | 'sending' | 'waiting' | 'reading' | 'done' | 'failed'

export type CalEvent = {
  title: string
  start: number
  end: number
  allDay: boolean
  calendar: string
  color: string
  location?: string
}

export type CalendarData = {
  range: string
  title: string
  days: { label: string; date: string; events: CalEvent[] }[]
  highlight?: string
}

export type RemindersData = {
  list?: string
  title: string
  items: { id: string; title: string; due?: number; list: string; color: string; priority: number }[]
  highlight?: string
}

export type NotesData = {
  query?: string
  notes: { id: string; title: string; snippet: string; modified: number; folder: string }[]
  open?: { title: string; body: string; modified: number }
}

export type ClockData = { cities: { name: string; timeZone: string }[] }

export type BatteryData = {
  percent: number | null
  charging: boolean
  onAC: boolean
  state: string
  timeRemaining?: string
}

export type DelegationData = {
  jobId: string
  agentId: string
  agent: string
  prompt: string
  status: DelegationStatus
  summary?: string
  reply?: string
  error?: string
}

export type Block =
  | { type: 'text'; markdown: string }
  | { type: 'cards'; items: { title: string; subtitle?: string; body?: string; accent?: string }[] }
  | { type: 'list'; ordered?: boolean; items: { title: string; detail?: string; meta?: string }[] }
  | { type: 'table'; columns: string[]; rows: (string | number)[][] }
  | { type: 'stats'; items: { label: string; value: string; delta?: string; trend?: 'up' | 'down' | 'flat' }[] }
  | {
      type: 'chart'
      kind: 'line' | 'bar'
      yLabel?: string
      series: { name: string; points: { x: string; y: number }[] }[]
    }
  | { type: 'weather'; data: WeatherData }
  | { type: 'stock'; data: StockData }
  | { type: 'nowPlaying'; data: NowPlayingData }
  | { type: 'delegation'; data: DelegationData }
  | { type: 'calendar'; data: CalendarData }
  | { type: 'reminders'; data: RemindersData }
  | { type: 'notes'; data: NotesData }
  | { type: 'clock'; data: ClockData }
  | { type: 'battery'; data: BatteryData }

export type Panel = { title?: string; subtitle?: string; blocks: Block[] }

/** Widgets that can be pinned to a screen. */
export type WidgetKind = 'weather' | 'stock' | 'calendar' | 'reminders' | 'notes' | 'clock' | 'battery' | 'nowPlaying'

export const PINNABLE: Block['type'][] = ['weather', 'stock', 'calendar', 'reminders', 'notes', 'clock', 'battery', 'nowPlaying']

export type PinnedWidget = {
  id: string
  kind: WidgetKind
  params: Record<string, string>
  displayId?: number
  x?: number
  y?: number
}

// ---------- UI state pushed from main to the renderer ----------

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking'

export type Activity = { id: string; text: string; status: 'running' | 'done' | 'error' }

export type PendingConfirm = { id: string; title: string; body: string; actionLabel: string }

export type InputMode = 'live' | 'review'

/** Words dictated in review mode, waiting for the user to edit and send. */
export type Draft = { id: number; text: string }

export type UIState = {
  phase: Phase
  expanded: boolean
  transcript: string
  reply: string
  activity: Activity[]
  panel: Panel | null
  jobs: DelegationData[]
  confirm: PendingConfirm | null
  error: string | null
  notice: string | null
  helperReady: boolean
  hasApiKey: boolean
  usageTodayUsd: number
  /** How the current listening session ends: answer right away, or fill the draft. */
  capture: InputMode
  draft: Draft | null
  insertTarget: string | null
  insertTargetName: string | null
  agents: { id: string; name: string }[]
  sounds: boolean
}

// ---------- Settings ----------

export type AgentTarget = {
  id: string
  name: string
  /** 'app': a Mac app such as Claude or ChatGPT. 'web': a chat website opened in your browser. */
  kind: 'app' | 'web'
  bundleId?: string
  url?: string
  enabled: boolean
}

export type Settings = {
  hotkey: string
  reviewHotkey: string
  inputMode: InputMode
  sounds: boolean
  musicApp: MusicApp
  browserBundleId: string
  pinned: PinnedWidget[]
  homeCity: string
  units: 'C' | 'F'
  speechLocale: string
  voiceId: string
  speechRate: number
  echoCancellation: boolean
  followUpSeconds: number
  smartRouting: boolean
  webSearch: boolean
  dailyBudgetUsd: number
  confirmHandoffs: boolean
  returnFocusAfterHandoff: boolean
  defaultAgent: string
  agents: AgentTarget[]
}

export type SecretName = 'anthropic' | 'xai' | 'spotifyClientId' | 'spotifyClientSecret'

export type SecretStatus = Record<SecretName, boolean>

export type PermissionStatus = {
  microphone: string
  speech: string
  accessibility: boolean
  calendar?: string
  reminders?: string
}

export type VoiceInfo = { id: string; name: string; language: string; quality: string }

export type RunningApp = { name: string; bundleId: string }

// ---------- The API the preload script exposes as window.watson ----------

export type WatsonAPI = {
  onState: (cb: (s: UIState) => void) => () => void
  getState: () => Promise<UIState>
  onLevel: (cb: (level: number) => void) => () => void
  setInteractive: (interactive: boolean) => void
  focus: () => void
  toggleListen: () => void
  ask: (text: string) => void
  cancel: () => void
  dismiss: () => void
  answerConfirm: (id: string, accepted: boolean) => void
  stockRange: (symbol: string, range: StockRange) => void
  music: (app: MusicApp, action: 'playpause' | 'next' | 'previous') => void
  setCapture: (mode: InputMode) => void
  dictate: (currentText: string) => void
  submitDraft: (text: string, target: string) => void
  cancelDraft: () => void
  pin: (block: Block) => void
  onWidget: (cb: (msg: { id: string; block: Block | null }) => void) => () => void
  widgetReady: (id: string) => void
  widgetSize: (id: string, width: number, height: number) => void
  closeWidget: (id: string) => void
  openSettings: () => void
  openExternal: (url: string) => void
  getSettings: () => Promise<Settings>
  setSettings: (patch: Partial<Settings>) => Promise<Settings>
  secretStatus: () => Promise<SecretStatus>
  setSecret: (name: SecretName, value: string) => Promise<SecretStatus>
  voices: () => Promise<VoiceInfo[]>
  runningApps: () => Promise<RunningApp[]>
  permissions: () => Promise<PermissionStatus | null>
  requestPermissions: () => Promise<PermissionStatus | null>
  openPrivacyPane: (pane: 'Microphone' | 'SpeechRecognition' | 'Accessibility' | 'Automation' | 'Calendars' | 'Reminders') => void
  testVoice: () => void
}
