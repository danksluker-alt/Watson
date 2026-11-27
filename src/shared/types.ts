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

export type NowPlayingData = {
  state: 'playing' | 'paused' | 'stopped'
  title: string
  artist: string
  album: string
  artworkUrl?: string
  durationSec: number
  positionSec: number
}

export type DelegationStatus = 'confirming' | 'sending' | 'waiting' | 'reading' | 'done' | 'failed'

export type DelegationData = {
  jobId: string
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

export type Panel = { title?: string; subtitle?: string; blocks: Block[] }

// ---------- UI state pushed from main to the renderer ----------

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking'

export type Activity = { id: string; text: string; status: 'running' | 'done' | 'error' }

export type PendingConfirm = { id: string; title: string; body: string; actionLabel: string }

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
}

// ---------- Settings ----------

export type AgentTarget = {
  id: string
  name: string
  bundleId: string
  enabled: boolean
}

export type Settings = {
  hotkey: string
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
}

export type VoiceInfo = { id: string; name: string; language: string; quality: string }

export type RunningApp = { name: string; bundleId: string }

// ---------- The API the preload script exposes as window.watson ----------

export type WatsonAPI = {
  onState: (cb: (s: UIState) => void) => () => void
  onLevel: (cb: (level: number) => void) => () => void
  setInteractive: (interactive: boolean) => void
  focus: () => void
  toggleListen: () => void
  ask: (text: string) => void
  cancel: () => void
  dismiss: () => void
  answerConfirm: (id: string, accepted: boolean) => void
  stockRange: (symbol: string, range: StockRange) => void
  spotify: (action: 'playpause' | 'next' | 'previous') => void
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
  openPrivacyPane: (pane: 'Microphone' | 'SpeechRecognition' | 'Accessibility' | 'Automation') => void
  testVoice: () => void
}
