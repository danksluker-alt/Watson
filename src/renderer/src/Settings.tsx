// Settings, laid out like macOS System Settings: grouped, inset rows.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { addAppAgent, isAiApp, type InstalledApp } from '@shared/aiApps'
import type { AgentTarget, PermissionStatus, SecretName, SecretStatus, Settings, VoiceInfo } from '@shared/types'
import { Check, Warning } from './components/Icons'
import { Orb } from './components/Orb'

function AddWebsite({ onAdd }: { onAdd: (name: string, url: string) => void }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const ok = name.trim() && /^https?:\/\/\S+\.\S+/.test(url.trim())
  return (
    <form
      className="secret"
      onSubmit={(e) => {
        e.preventDefault()
        if (!ok) return
        onAdd(name.trim(), url.trim())
        setName('')
        setUrl('')
      }}
    >
      <input className="text narrow-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <input className="text" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
      <button className="btn small primary" disabled={!ok}>
        Add
      </button>
    </form>
  )
}

const host = (u?: string) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, '') : ''
  } catch {
    return u ?? ''
  }
}


function Group({ title, footer, children }: { title?: string; footer?: ReactNode; children: ReactNode }) {
  return (
    <section className="group">
      {title && <h2>{title}</h2>}
      <div className="group-box">{children}</div>
      {footer && <p className="group-foot">{footer}</p>}
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="row">
      <div className="row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button role="switch" aria-checked={on} className={on ? 'toggle on' : 'toggle'} onClick={() => onChange(!on)} />
}

function SecretField({ name, saved, placeholder, onSaved }: { name: SecretName; saved: boolean; placeholder: string; onSaved: (s: SecretStatus) => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(!saved)
  useEffect(() => setEditing(!saved), [saved])
  if (!editing) {
    return (
      <span className="saved">
        <Check size={12} /> Saved in Keychain
        <button className="link" onClick={() => setEditing(true)}>
          Change
        </button>
      </span>
    )
  }
  return (
    <form
      className="secret"
      onSubmit={async (e) => {
        e.preventDefault()
        setError('')
        try {
          onSaved(await window.watson.setSecret(name, value))
          setValue('')
        } catch (err) {
          // Electron wraps errors from the main process; keep only the readable part.
          setError(String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
        }
      }}
    >
      <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false} />
      <button className="btn small primary" disabled={!value.trim()}>
        Save
      </button>
      {saved && (
        <button type="button" className="link" onClick={() => setEditing(false)}>
          Cancel
        </button>
      )}
      {error && (
        <span className="perm" role="alert">
          <Warning size={12} /> {error}
        </span>
      )}
    </form>
  )
}

function PermissionRow({ label, state, pane }: { label: string; state: string | boolean | undefined; pane: Parameters<Window['watson']['openPrivacyPane']>[0] }) {
  const ok = state === true || state === 'granted'
  return (
    <Row label={label}>
      <span className={ok ? 'perm ok' : 'perm'}>
        {ok ? <Check size={12} /> : <Warning size={12} />}
        {ok ? 'Allowed' : state === 'denied' ? 'Denied' : 'Not yet'}
      </span>
      {!ok && (
        <button className="btn small" onClick={() => window.watson.openPrivacyPane(pane)}>
          Open
        </button>
      )}
    </Row>
  )
}

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null)
  const [secrets, setSecrets] = useState<SecretStatus | null>(null)
  const [voices, setVoices] = useState<VoiceInfo[]>([])
  const [installed, setInstalled] = useState<InstalledApp[]>([])
  const [perm, setPerm] = useState<PermissionStatus | null>(null)

  useEffect(() => {
    void window.watson.getSettings().then(setS)
    void window.watson.secretStatus().then(setSecrets)
    void window.watson.voices().then(setVoices)
    void window.watson.installedApps().then(setInstalled)
    const poll = () => void window.watson.permissions().then(setPerm)
    poll()
    const t = setInterval(poll, 3000)
    return () => clearInterval(t)
  }, [])

  const save = async (patch: Partial<Settings>) => setS(await window.watson.setSettings(patch))

  const lang = s?.speechLocale.slice(0, 2) ?? 'en'
  const voiceOptions = useMemo(() => {
    // Most human-sounding first; novelty and robotic voices are left out.
    const rank = { siri: 0, premium: 1, enhanced: 2, default: 3 } as const
    const novelty = /speech\.synthesis\.voice|eloquence/
    const g = s?.voiceGender ?? 'any'
    return voices
      .filter((v) => v.language.startsWith(lang) && !novelty.test(v.id) && (g === 'any' || v.gender === g || !v.gender))
      .sort((a, b) => rank[a.quality as keyof typeof rank] - rank[b.quality as keyof typeof rank] || a.name.localeCompare(b.name))
  }, [voices, lang, s?.voiceGender])
  const naturalMale = voices.some((v) => v.language.startsWith(lang) && v.gender === 'male' && ['siri', 'premium', 'enhanced'].includes(v.quality))

  if (!s || !secrets) return <div className="settings" />

  const foundAi = installed.filter((a) => isAiApp(a) && !s.agents.some((g) => g.bundleId === a.bundleId))
  const setAgent = (id: string, patch: Partial<AgentTarget>) => save({ agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) })

  return (
    <div className="settings">
      <div className="drag" />
      <header className="settings-hero">
        <Orb phase="idle" size={56} />
        <div>
          <h1>Watson</h1>
          <p>Your voice assistant. Press {s.hotkey.replace('Alt', '⌥').replace('+', ' ')} anywhere to talk.</p>
        </div>
      </header>

      <Group
        title="Claude"
        footer={
          <>
            Quick questions use Claude Haiku 5.5 (about $0.0002 each). Requests that need reasoning use Claude Sonnet 5.5. Keys are encrypted with your Mac’s Keychain and never leave this Mac except to call the API.{' '}
            <a onClick={() => window.watson.openExternal('https://console.anthropic.com/settings/keys')}>Get an API key</a>
          </>
        }
      >
        <Row label="Anthropic API key">
          <SecretField name="anthropic" saved={secrets.anthropic} placeholder="sk-ant-…" onSaved={setSecrets} />
        </Row>
        <Row label="Smart model choice" hint="Sonnet only when it’s needed">
          <Toggle on={s.smartRouting} onChange={(v) => save({ smartRouting: v })} />
        </Row>
        <Row label="Web search" hint="About $0.01 per search">
          <Toggle on={s.webSearch} onChange={(v) => save({ webSearch: v })} />
        </Row>
        <Row label="Daily budget" hint="Watson stops calling the API after this">
          <span className="money">
            $
            <input type="number" min={0} step={0.1} value={s.dailyBudgetUsd} onChange={(e) => save({ dailyBudgetUsd: Number(e.target.value) })} />
          </span>
        </Row>
      </Group>

      <Group
        title="Voice"
        footer={
          <>
            For the most natural voice, download a Premium voice: System Settings → Accessibility → Spoken Content → System Voice → Manage Voices. Then pick it here.
          </>
        }
      >
        <Row label="Talk shortcut" hint="e.g. Alt+Space, Command+Shift+Space">
          <input className="text" defaultValue={s.hotkey} onBlur={(e) => e.target.value.trim() && save({ hotkey: e.target.value.trim() })} />
        </Row>
        <Row label="When I click Watson or use the talk shortcut" hint={s.inputMode === 'review' ? 'See and edit your words first' : 'Watson answers as soon as you stop'}>
          <div className="segmented light">
            <button className={s.inputMode === 'review' ? 'on' : ''} onClick={() => save({ inputMode: 'review' })}>
              Dictate, then send
            </button>
            <button className={s.inputMode === 'live' ? 'on' : ''} onClick={() => save({ inputMode: 'live' })}>
              Talk live
            </button>
          </div>
        </Row>
        <Row label={s.inputMode === 'review' ? 'Talk live shortcut' : 'Dictate shortcut'} hint="The other way of talking, on its own shortcut">
          <input className="text" defaultValue={s.reviewHotkey} onBlur={(e) => e.target.value.trim() && save({ reviewHotkey: e.target.value.trim() })} />
        </Row>
        <Row label="Listen for “Hey Watson”" hint="Say it to start a live conversation. Listens on this Mac only, so the orange microphone dot stays on while Watson is idle.">
          <Toggle on={s.wakeWord} onChange={(v) => save({ wakeWord: v })} />
        </Row>
        <Row label="Sounds" hint="Soft chimes when Watson listens and answers">
          <Toggle on={s.sounds} onChange={(v) => save({ sounds: v })} />
        </Row>
        <Row label="Voice" hint={s.voiceGender === 'male' && !naturalMale ? 'No natural male voice yet: get one free with “Get more voices” (Siri voices sound most human)' : undefined}>
          <div className="segmented light">
            {(['male', 'female', 'any'] as const).map((g) => (
              <button key={g} className={s.voiceGender === g ? 'on' : ''} onClick={() => save({ voiceGender: g, voiceId: '' })}>
                {g === 'male' ? 'Male' : g === 'female' ? 'Female' : 'Any'}
              </button>
            ))}
          </div>
        </Row>
        <Row label="">
          <select value={s.voiceId} onChange={(e) => save({ voiceId: e.target.value })}>
            <option value="">Best available</option>
            {voiceOptions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.language}){v.quality === 'premium' ? ' · Premium' : v.quality === 'enhanced' ? ' · Enhanced' : ''}
              </option>
            ))}
          </select>
          <button className="btn small" onClick={() => window.watson.testVoice()}>
            Test
          </button>
          <button className="btn small" onClick={() => window.watson.openVoiceSettings()}>
            Get more voices
          </button>
        </Row>
        <Row label="Speaking rate">
          <input type="range" min={0.4} max={0.62} step={0.01} value={s.speechRate} onChange={(e) => save({ speechRate: Number(e.target.value) })} />
        </Row>
        <Row label="Language">
          <select value={s.speechLocale} onChange={(e) => save({ speechLocale: e.target.value })}>
            {['en-US', 'en-GB', 'en-AU', 'es-MX', 'es-ES', 'pt-BR', 'fr-FR', 'de-DE', 'it-IT', 'zh-CN'].map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </Row>
        <Row label="Echo cancellation" hint="Lets you interrupt Watson on speakers">
          <Toggle on={s.echoCancellation} onChange={(v) => save({ echoCancellation: v })} />
        </Row>
        <Row label="Keep listening after answers" hint="Seconds to wait for a follow-up">
          <input type="number" className="narrow" min={0} max={20} value={s.followUpSeconds} onChange={(e) => save({ followUpSeconds: Number(e.target.value) })} />
        </Row>
      </Group>

      <Group
        title="Agents"
        footer="Watson types into these for you when a request needs them, or when you name one (“ask Grok…”): coding, your website, email, anything using their connectors. Websites open in your default browser, signed in as you. Answers come back as a short spoken summary. Watson asks before anything that sends, deletes, buys or publishes."
      >
        {s.agents.map((a) => (
          <Row key={a.id} label={a.name} hint={a.kind === 'web' ? `Website · ${host(a.url)}` : `Mac app · ${a.bundleId}`}>
            {s.defaultAgent === a.id ? (
              <span className="tag">Default</span>
            ) : (
              <button className="link" onClick={() => save({ defaultAgent: a.id })}>
                Make default
              </button>
            )}
            <Toggle on={a.enabled} onChange={(v) => setAgent(a.id, { enabled: v })} />
          </Row>
        ))}
        {foundAi.map((a) => (
          <Row key={a.bundleId} label={a.name} hint="AI app found on this Mac">
            <button className="btn small primary" onClick={() => void save({ agents: addAppAgent(s.agents, a) })}>
              Add
            </button>
          </Row>
        ))}
        <Row label="Add another app" hint="Any app on this Mac">
          <select
            value=""
            onChange={(e) => {
              const app = installed.find((x) => x.bundleId === e.target.value)
              if (app) void save({ agents: addAppAgent(s.agents, app) })
            }}
          >
            <option value="">Choose an app…</option>
            {installed
              .filter((a) => !s.agents.some((g) => g.bundleId === a.bundleId))
              .map((a) => (
                <option key={a.bundleId} value={a.bundleId}>
                  {a.name}
                </option>
              ))}
          </select>
        </Row>
        <Row label="Add a chat website" hint="Any AI you use in the browser">
          <AddWebsite
            onAdd={(name, url) => {
              const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-web`
              void save({ agents: [...s.agents.filter((a) => a.id !== id), { id, name, kind: 'web', url, enabled: true }] })
            }}
          />
        </Row>
        <Row label="Ask before every hand-off">
          <Toggle on={s.confirmHandoffs} onChange={(v) => save({ confirmHandoffs: v })} />
        </Row>
        <Row label="Open the Watson window when something needs my OK" hint="Hand-offs that send, delete or buy">
          <Toggle on={s.openWindowOnConfirm} onChange={(v) => save({ openWindowOnConfirm: v })} />
        </Row>
        <Row label="Return to my app after sending">
          <Toggle on={s.returnFocusAfterHandoff} onChange={(v) => save({ returnFocusAfterHandoff: v })} />
        </Row>
      </Group>

      <Group
        title="Widgets"
        footer={
          <>
            Weather is from Open-Meteo and stocks from Yahoo Finance, both free with no key. To have Watson start a specific song, create a free app at{' '}
            <a onClick={() => window.watson.openExternal('https://developer.spotify.com/dashboard')}>developer.spotify.com</a> and paste its Client ID and Secret.
          </>
        }
      >
        <Row label="Music app">
          <div className="segmented light">
            <button className={s.musicApp === 'spotify' ? 'on' : ''} onClick={() => save({ musicApp: 'spotify' })}>
              Spotify
            </button>
            <button className={s.musicApp === 'music' ? 'on' : ''} onClick={() => save({ musicApp: 'music' })}>
              Apple Music
            </button>
          </div>
        </Row>
        <Row label="Home city">
          <input className="text" defaultValue={s.homeCity} onBlur={(e) => e.target.value.trim() && save({ homeCity: e.target.value.trim() })} />
        </Row>
        <Row label="Units">
          <div className="segmented light">
            {(['F', 'C'] as const).map((u) => (
              <button key={u} className={s.units === u ? 'on' : ''} onClick={() => save({ units: u })}>
                °{u}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Spotify Client ID">
          <SecretField name="spotifyClientId" saved={secrets.spotifyClientId} placeholder="Client ID" onSaved={setSecrets} />
        </Row>
        <Row label="Spotify Client Secret">
          <SecretField name="spotifyClientSecret" saved={secrets.spotifyClientSecret} placeholder="Client secret" onSaved={setSecrets} />
        </Row>
      </Group>

      <Group
        title="Permissions"
        footer="Microphone and Speech Recognition are for listening (recognition runs on this Mac). Accessibility lets Watson type into your AI apps and read their answers. Calendars and Reminders power those widgets. macOS asks about Automation the first time Watson uses Spotify, Music or Notes."
      >
        {perm ? (
          <>
            <PermissionRow label="Microphone" state={perm.microphone} pane="Microphone" />
            <PermissionRow label="Speech Recognition" state={perm.speech} pane="SpeechRecognition" />
            <PermissionRow label="Accessibility" state={perm.accessibility} pane="Accessibility" />
            <PermissionRow label="Calendars" state={perm.calendar} pane="Calendars" />
            <PermissionRow label="Reminders" state={perm.reminders} pane="Reminders" />
            <Row label="Ask for missing permissions">
              <button className="btn small" onClick={() => void window.watson.requestPermissions().then(setPerm)}>
                Request
              </button>
            </Row>
          </>
        ) : (
          <Row label="Voice helper" hint="Run “npm run helper”, then restart Watson">
            <span className="perm">
              <Warning size={12} /> Not running
            </span>
          </Row>
        )}
      </Group>

      <Group title="Coming later" footer="Grok support uses this key once it’s added.">
        <Row label="xAI API key">
          <SecretField name="xai" saved={secrets.xai} placeholder="xai-…" onSaved={setSecrets} />
        </Row>
      </Group>
    </div>
  )
}
