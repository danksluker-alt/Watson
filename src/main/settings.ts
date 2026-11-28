// Settings live in ~/Library/Application Support/Watson/settings.json.
// API keys never go there: they are encrypted with macOS Keychain-backed
// safeStorage and written to secrets.json as ciphertext only.
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentTarget, SecretName, SecretStatus, Settings } from '@shared/types'

export const AGENT_PRESETS: AgentTarget[] = [
  // Claude's app also has a Code view where ⌘N starts a coding session: switch to chat first.
  { id: 'claude', name: 'Claude', kind: 'app', bundleId: 'com.anthropic.claudefordesktop', chatMenu: ['Go', 'Claude'], enabled: true },
  { id: 'grok', name: 'Grok', kind: 'web', url: 'https://grok.com/', enabled: true },
  { id: 'chatgpt', name: 'ChatGPT', kind: 'app', bundleId: 'com.openai.chat', enabled: false },
  { id: 'gemini', name: 'Gemini', kind: 'web', url: 'https://gemini.google.com/app', enabled: false },
  { id: 'claude-web', name: 'Claude (web)', kind: 'web', url: 'https://claude.ai/new', enabled: false },
  { id: 'chatgpt-web', name: 'ChatGPT (web)', kind: 'web', url: 'https://chatgpt.com/', enabled: false },
  { id: 'perplexity', name: 'Perplexity', kind: 'web', url: 'https://www.perplexity.ai/', enabled: false },
]

/** A sensible home city before the user picks one: the city in the Mac's time zone ("America/Denver" → "Denver"). */
function cityFromTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  const city = tz.includes('/') ? tz.split('/').pop()!.replace(/_/g, ' ') : ''
  return city && !/^(UTC|GMT)/i.test(city) ? city : 'New York'
}

/** Celsius everywhere except the few places that use Fahrenheit. */
function unitsFromLocale(): 'C' | 'F' {
  const region = Intl.DateTimeFormat().resolvedOptions().locale.split('-')[1] ?? 'US'
  return ['US', 'LR', 'MM', 'BS', 'BZ', 'KY', 'PW'].includes(region.toUpperCase()) ? 'F' : 'C'
}

export const DEFAULT_SETTINGS: Settings = {
  hotkey: 'Alt+Space',
  reviewHotkey: 'Alt+Shift+Space',
  inputMode: 'live',
  sounds: true,
  musicApp: 'spotify',
  browserBundleId: '',
  pinned: [],
  homeCity: cityFromTimeZone(),
  units: unitsFromLocale(),
  speechLocale: 'en-US',
  voiceId: '',
  speechRate: 0.52,
  echoCancellation: true,
  followUpSeconds: 6,
  smartRouting: true,
  webSearch: true,
  dailyBudgetUsd: 0.5,
  confirmHandoffs: false,
  returnFocusAfterHandoff: true,
  defaultAgent: 'claude',
  agents: AGENT_PRESETS,
  pillShape: 'circle',
  openWindowOnConfirm: true,
  pillPlace: null,
}

const SECRET_NAMES: SecretName[] = ['anthropic', 'xai', 'spotifyClientId', 'spotifyClientSecret']

const file = (name: string) => path.join(app.getPath('userData'), name)

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, value: unknown) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(file(name), JSON.stringify(value, null, 2), { mode: 0o600 })
}

let cached: Settings | null = null

export function getSettings(): Settings {
  if (!cached) {
    const saved = readJson<Partial<Settings>>('settings.json', {})
    cached = { ...DEFAULT_SETTINGS, ...saved }
    // Older settings files have agents without a kind; newer presets may be missing.
    // Saved presets pick up new preset fields (like chatMenu) without losing the user's choices.
    const agents = (saved.agents ?? AGENT_PRESETS).map((a) => {
      const preset = AGENT_PRESETS.find((p) => p.id === a.id)
      return { ...(preset ? { chatMenu: preset.chatMenu } : {}), ...a, kind: a.kind ?? 'app' } as AgentTarget
    })
    for (const preset of AGENT_PRESETS) if (!agents.some((a) => a.id === preset.id)) agents.push({ ...preset, enabled: false })
    cached.agents = agents
  }
  return cached
}

export function updateSettings(patch: Partial<Settings>): Settings {
  cached = { ...getSettings(), ...patch }
  writeJson('settings.json', cached)
  return cached
}

type SecretFile = Partial<Record<SecretName, string>>

export function getSecret(name: SecretName): string | null {
  const enc = readJson<SecretFile>('secrets.json', {})[name]
  // Developers and tests can supply the API key through the environment instead.
  if (!enc) return name === 'anthropic' ? (process.env.ANTHROPIC_API_KEY ?? null) : null
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

export function setSecret(name: SecretName, value: string): SecretStatus {
  const all = readJson<SecretFile>('secrets.json', {})
  const trimmed = value.trim()
  if (!trimmed) delete all[name]
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('macOS encryption is not available yet.')
    all[name] = safeStorage.encryptString(trimmed).toString('base64')
  }
  writeJson('secrets.json', all)
  return secretStatus()
}

export function secretStatus(): SecretStatus {
  const all = readJson<SecretFile>('secrets.json', {})
  const status = Object.fromEntries(SECRET_NAMES.map((n) => [n, Boolean(all[n])])) as SecretStatus
  if (!status.anthropic && process.env.ANTHROPIC_API_KEY) status.anthropic = true
  return status
}
