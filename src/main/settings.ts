// Settings live in ~/Library/Application Support/Watson/settings.json.
// API keys never go there: they are encrypted with macOS Keychain-backed
// safeStorage and written to secrets.json as ciphertext only.
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { SecretName, SecretStatus, Settings } from '@shared/types'

export const DEFAULT_SETTINGS: Settings = {
  hotkey: 'Alt+Space',
  homeCity: 'New York',
  units: 'F',
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
  agents: [
    { id: 'claude', name: 'Claude', bundleId: 'com.anthropic.claudefordesktop', enabled: true },
    { id: 'chatgpt', name: 'ChatGPT', bundleId: 'com.openai.chat', enabled: false },
  ],
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
  if (!cached) cached = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>('settings.json', {}) }
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
  if (!enc || !safeStorage.isEncryptionAvailable()) return null
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
  return Object.fromEntries(SECRET_NAMES.map((n) => [n, Boolean(all[n])])) as SecretStatus
}
