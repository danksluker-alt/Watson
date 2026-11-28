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

export type ContactPerson = {
  id: string
  name: string
  organization?: string
  phones: { label: string; value: string }[]
  emails: { label: string; value: string }[]
  /** Ready to show: "April 12" or "April 12, 1990". */
  birthday?: string
  /** The first address, on one line. */
  address?: string
}

export type ContactsData = { query: string; people: ContactPerson[] }

export type MailMessage = {
  /** The Message-ID header (without < >), for opening it in Mail. */
  id: string
  sender: string
  address?: string
  subject: string
  date: number
  snippet: string
  /** "iCloud · INBOX". */
  mailbox: string
  unread: boolean
}

export type MailData = { query?: string; unread: number; messages: MailMessage[] }

/** The user's Shortcuts, or the one that just ran (only after they said yes). */
export type ShortcutsData = { shortcuts: string[]; ran?: { name: string; output: string } }

export type ClockData = { cities: { name: string; timeZone: string }[] }

export type BatteryData = {
  percent: number | null
  charging: boolean
  onAC: boolean
  state: string
  timeRemaining?: string
}

export type TimerItem = {
  id: string
  kind: 'timer' | 'alarm'
  /** What it's for ("pasta"); may be empty. */
  label: string
  durationSec: number
  endsAt: number
  createdAt: number
}

export type TimersData = { items: TimerItem[]; highlight?: string }

/** Something Watson does on its own at a set time ("turn off my Mac at 11 pm every night"). */
export type AutomationAction = 'shut_down' | 'restart' | 'sleep' | 'sleep_display' | 'dark_mode' | 'light_mode' | 'mute' | 'volume' | 'open_app' | 'quit_app' | 'announce'
export type AutomationRepeat = 'once' | 'daily' | 'weekdays' | 'weekends'
export type AutomationItem = {
  id: string
  /** Short name shown in the dashboard ("Shut down"). */
  label: string
  action: AutomationAction
  /** App name, volume level or the words to say, depending on the action. */
  value?: string
  /** Local time, "HH:mm". */
  time: string
  /** For a one-off on a given day: "YYYY-MM-DD". */
  date?: string
  repeat: AutomationRepeat
  enabled: boolean
  nextAt: number
  lastRunAt?: number
  createdAt: number
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
  /** Hand-offs asked together ("ask Claude and Grok") share a group and are compared at the end. */
  groupId?: string
  /** An earlier answer passed along with this request ("send that to Claude"). */
  attachedFrom?: string
  startedAt?: number
  endedAt?: number
}

/** A question one of your AIs asked, with options to tap; the pick goes back to that AI. */
export type ChoicesData = {
  question?: string
  options: { title: string; detail?: string }[]
  /** More than one may be picked. */
  multiple?: boolean
  agentId?: string
  agent?: string
}

/** Several AIs asked the same thing, side by side, with Watson's read on where they agree. */
export type CompareData = {
  groupId: string
  prompt: string
  jobs: DelegationData[]
  /** Spoken summary: where they agree and the main difference. */
  verdict?: string
  /** One line per agent: what was distinctive about its answer. */
  takeaways?: { agent: string; text: string }[]
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
  | { type: 'compare'; data: CompareData }
  | { type: 'choices'; data: ChoicesData }
  | { type: 'calendar'; data: CalendarData }
  | { type: 'reminders'; data: RemindersData }
  | { type: 'notes'; data: NotesData }
  | { type: 'contacts'; data: ContactsData }
  | { type: 'mail'; data: MailData }
  | { type: 'shortcuts'; data: ShortcutsData }
  | { type: 'clock'; data: ClockData }
  | { type: 'battery'; data: BatteryData }
  | { type: 'timers'; data: TimersData }

export type Panel = { title?: string; subtitle?: string; blocks: Block[] }

/** One request and Watson's answer, for the Watson window. */
export type HistoryTurn = { id: string; at: number; mode: 'voice' | 'text'; you: string; watson: string; title?: string; blocks?: Block[] }

export type HistoryData = { turns: HistoryTurn[]; jobs: (DelegationData & { at: number })[]; compares?: (CompareData & { at: number })[] }

/** Widgets that can be pinned to a screen. */
export type WidgetKind = 'weather' | 'stock' | 'calendar' | 'reminders' | 'notes' | 'mail' | 'clock' | 'battery' | 'nowPlaying' | 'timers'

export const PINNABLE: Block['type'][] = ['weather', 'stock', 'calendar', 'reminders', 'notes', 'mail', 'clock', 'battery', 'nowPlaying', 'timers']

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

export type PillShape = 'pill' | 'circle'

/** Where the pill sits: a display and a point on it, as fractions of its work area (survives resolution changes). */
export type PillPlace = { displayId: number; fx: number; fy: number }

/** Where the island sits inside the overlay window, and which way the panel opens. */
export type IslandLayout = { centerX: number; dir: 'down' | 'up' }

/** Short facts for the idle pill, refreshed in the background from free local sources. */
/** What the pill can show on its own: the next event, when it's close. */
export type Glance = { nextEvent?: { title: string; start: number; end: number } }

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
  /** Unsent words put away in the pill (clicked away or Esc); a click brings them back. New dictation starts fresh. */
  parked: { text: string; at: number } | null
  insertTarget: string | null
  insertTargetName: string | null
  agents: { id: string; name: string }[]
  sounds: boolean
  /** Watson's voice is muted: answers are shown, not spoken. */
  muted: boolean
  automations: AutomationItem[]
  /** Running timers and alarms, soonest first (the pill shows the next one). */
  timers: TimerItem[]
  /** A timer or alarm that just went off and hasn't been dismissed. */
  ringing: TimerItem | null
  layout: IslandLayout
  pillShape: PillShape
  glance: Glance
  /** The user is holding/moving the pill. */
  arranging: boolean
  /** The dashboard is in front: the panel folds back into the pill so they don't overlap. */
  tucked: boolean
}

// ---------- Settings ----------

export type AgentTarget = {
  id: string
  name: string
  /** 'app': a Mac app such as Claude or ChatGPT. 'web': a chat website opened in your browser. */
  kind: 'app' | 'web'
  bundleId?: string
  url?: string
  /** Menu path that switches the app to plain chat before "New Chat", e.g. ["Go", "Claude"]. */
  chatMenu?: string[]
  enabled: boolean
}

export type Settings = {
  hotkey: string
  reviewHotkey: string
  inputMode: InputMode
  /** Listen on this Mac for "Hey Watson" to start a live conversation. Off unless chosen. */
  wakeWord: boolean
  /** Which kind of voice "Best available" prefers. */
  voiceGender: 'male' | 'female' | 'any'
  /** Watson's own voice is off (the Mac's sound isn't touched). */
  muted: boolean
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
  pillShape: PillShape
  /** Bring the Watson window forward when something needs the user's OK. */
  openWindowOnConfirm: boolean
  /** null = top centre of the screen with the pointer. */
  pillPlace: PillPlace | null
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

export type VoiceInfo = { id: string; name: string; language: string; quality: string; gender?: string }

export type RunningApp = { name: string; bundleId: string }

// ---------- The API the preload script exposes as window.watson ----------

export type WatsonAPI = {
  onState: (cb: (s: UIState) => void) => () => void
  getState: () => Promise<UIState>
  onLevel: (cb: (level: number) => void) => () => void
  setInteractive: (interactive: boolean) => void
  focus: () => void
  toggleListen: () => void
  /** Start a live voice conversation (sends the draft first, if there is one). */
  talkLive: (draft?: string) => void
  /** The pill's right-click menu. */
  pillMenu: () => void
  /** Answer a question an AI asked: sent to that AI in the same conversation. */
  replyToAgent: (agentId: string, text: string) => void
  /** Opens System Settings where natural voices are downloaded. */
  openVoiceSettings: () => void
  ask: (text: string) => void
  cancel: () => void
  dismiss: () => void
  answerConfirm: (id: string, accepted: boolean) => void
  stockRange: (symbol: string, range: StockRange) => void
  music: (app: MusicApp, action: 'playpause' | 'next' | 'previous') => void
  setCapture: (mode: InputMode) => void
  dictate: (currentText: string) => void
  /** Stop listening and keep the words so far, to finish by typing. */
  takeOver: (currentText: string) => void
  /** Keeps the draft's edited text in the main process (and on disk) as you type. */
  draftText: (text: string) => void
  /** Brings a put-away draft back. */
  openDraft: () => void
  setMuted: (muted: boolean) => void
  removeAutomation: (id: string) => void
  setAutomationEnabled: (id: string, enabled: boolean) => void
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
  testVoice: (voiceId?: string, gender?: string) => void
  installedApps: () => Promise<{ name: string; bundleId: string }[]>
  openWindow: () => void
  getHistory: () => Promise<HistoryData>
  onHistory: (cb: (h: HistoryData) => void) => () => void
  clearHistory: () => void
  pillDrag: (phase: 'start' | 'end') => void
  setPillShape: (shape: PillShape) => void
  resetPillPlace: () => void
  setArranging: (on: boolean) => void
  cancelTimer: (id: string) => void
  stopRinging: () => void
}
