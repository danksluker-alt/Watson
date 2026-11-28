// AI apps Watson recognizes on a Mac, so they can be added as agents with one click.
// Shared by the main process (scanning /Applications) and Settings (the "Found on this Mac" list).
import type { AgentTarget } from './types'

export type KnownApp = { name: string; chatMenu?: string[] }

/** Bundle id → the name people say ("ask Grok") and how to reach a plain chat. */
export const KNOWN_AI_APPS: Record<string, KnownApp> = {
  'com.anthropic.claudefordesktop': { name: 'Claude', chatMenu: ['Go', 'Claude'] },
  'com.openai.chat': { name: 'ChatGPT' },
  'com.openai.codex': { name: 'Codex' },
  'com.anysphere.sand': { name: 'Grok' }, // the "Grok Bot" desktop app
  'ai.x.grok': { name: 'Grok' },
  'ai.perplexity.mac': { name: 'Perplexity' },
  'ai.perplexity.app': { name: 'Perplexity' },
  'com.google.GeminiMacOS': { name: 'Gemini' },
  'com.microsoft.copilot-mac': { name: 'Copilot' },
  'com.microsoft.Copilot': { name: 'Copilot' },
  'com.todesktop.230313mzl4w4u92': { name: 'Cursor' },
  'com.deepseek.chat': { name: 'DeepSeek' },
  'ai.mistral.lechat': { name: 'Le Chat' },
}

/** Names that suggest an AI app we don't know by bundle id yet. */
const AI_NAME = /\b(chatgpt|claude|grok|gemini|perplexity|copilot|codex|cursor|deepseek|mistral|le chat|poe|msty|lm studio|ollama|chatbot|ai chat)\b/i

export type InstalledApp = { name: string; bundleId: string }

export function isAiApp(app: InstalledApp): boolean {
  return Boolean(KNOWN_AI_APPS[app.bundleId]) || AI_NAME.test(app.name)
}

/** "Grok Bot" → "Grok": the name the user will say. */
export function agentName(app: InstalledApp): string {
  return KNOWN_AI_APPS[app.bundleId]?.name ?? app.name.replace(/\s+(bot|app|desktop|for mac)$/i, '')
}

/**
 * Adds an app as an agent. If a website agent already has that name (Grok on grok.com), the app
 * takes over the name and the website is turned off, so "ask Grok" goes to the app.
 */
export function addAppAgent(agents: AgentTarget[], app: InstalledApp): AgentTarget[] {
  const name = agentName(app)
  if (agents.some((a) => a.bundleId === app.bundleId)) return agents
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'app'
  const clash = agents.find((a) => a.id === base || a.name.toLowerCase() === name.toLowerCase())
  const rest = agents.map((a) => (a === clash && a.kind === 'web' ? { ...a, id: a.id === base ? `${base}-web` : a.id, name: `${a.name} (web)`, enabled: false } : a))
  const id = rest.some((a) => a.id === base) ? `${base}-app` : base
  return [...rest, { id, name, kind: 'app', bundleId: app.bundleId, chatMenu: KNOWN_AI_APPS[app.bundleId]?.chatMenu, enabled: true }]
}
