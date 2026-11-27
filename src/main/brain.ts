// Watson's brain: picks a model, gives it tools, streams the answer.
//
// Cost rules (you're on a budget):
//   - Claude Haiku 5.5 answers by default; Claude Sonnet 5.5 only for requests
//     that look like they need real reasoning ("explain", "compare", long asks).
//   - Only the last few exchanges are sent, as plain text.
//   - Widgets (weather, stocks, Spotify) are drawn locally from free data;
//     the model only sees a one-line summary of them.
import Anthropic from '@anthropic-ai/sdk'
import { clipboard } from 'electron'
import { z } from 'zod'
import type { Block, MusicApp, Panel, Settings, StockRange, WidgetKind } from '@shared/types'
import type { Helper } from './helper'
import type { ScreenChoice } from './pinned'
import { getSecret, getSettings } from './settings'
import { record, spentToday } from './usage'
import { getWeather, weatherForModel } from './tools/weather'
import { getStock, stockForModel } from './tools/stocks'
import * as music from './tools/music'
import { openApp, openFile, openUrl } from './tools/system'
import { addEvent, addReminder, calendarForModel, completeReminder, getCalendar, getReminders, remindersForModel } from './tools/calendar'
import { macControl, type MacAction } from './tools/mac'
import { findFiles } from './tools/files'
import { forget, memories, memoryPrompt, remember } from './memory'
import { createNote, notesForModel, readNote, recentNotes, searchNotes } from './tools/notes'
import { clockForModel, worldClock } from './tools/clock'
import { battery } from './tools/battery'
import { spokenDuration, timerName, timers } from './timers'

export const HAIKU = 'claude-haiku-5-5'
export const SONNET = 'claude-sonnet-5-5'

type Msg = Anthropic.Beta.BetaMessageParam

export type ToolHost = {
  /** Show (or add to) this turn's panel. */
  addBlocks: (blocks: Block[], meta?: { title?: string; subtitle?: string }) => void
  activity: (text: string) => string
  finishActivity: (id: string, ok: boolean, text?: string) => void
  /** Hand a request to another AI app. Resolves once it has been queued. */
  delegate: (agentId: string, prompt: string, sensitive: boolean, newChat: boolean) => Promise<string>
  /** Put a widget on a screen as a floating window. */
  pin: (kind: WidgetKind, params: Record<string, string>, screen: ScreenChoice) => Promise<string>
  unpin: (kind: WidgetKind | 'all') => void
  helper: Helper
}

export class BudgetError extends Error {}

// ---------------- Tool schemas ----------------

const PanelBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), markdown: z.string() }),
  z.object({
    type: z.literal('cards'),
    items: z.array(z.object({ title: z.string(), subtitle: z.string().optional(), body: z.string().optional(), accent: z.string().optional() })),
  }),
  z.object({
    type: z.literal('list'),
    ordered: z.boolean().optional(),
    items: z.array(z.object({ title: z.string(), detail: z.string().optional(), meta: z.string().optional() })),
  }),
  z.object({ type: z.literal('table'), columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number()]))) }),
  z.object({
    type: z.literal('stats'),
    items: z.array(z.object({ label: z.string(), value: z.string(), delta: z.string().optional(), trend: z.enum(['up', 'down', 'flat']).optional() })),
  }),
  z.object({
    type: z.literal('chart'),
    kind: z.enum(['line', 'bar']),
    yLabel: z.string().optional(),
    series: z.array(z.object({ name: z.string(), points: z.array(z.object({ x: z.string(), y: z.number() })) })),
  }),
])
const ShowPanelInput = z.object({ title: z.string().optional(), subtitle: z.string().optional(), blocks: z.array(PanelBlock).min(1) })
const WeatherInput = z.object({ location: z.string().optional() })
const StockInput = z.object({ symbol: z.string().min(1), range: z.enum(['1D', '1W', '1M', '3M', '1Y']).optional() })
const MusicInput = z.object({
  action: z.enum(['play', 'pause', 'resume', 'next', 'previous', 'now_playing']),
  query: z.string().optional(),
  kind: z.enum(['track', 'album', 'playlist', 'artist']).optional(),
  app: z.enum(['spotify', 'apple_music']).optional(),
})
const OpenInput = z.object({ kind: z.enum(['app', 'url', 'file']), target: z.string().min(1) })
const DelegateInput = z.object({ agent: z.string(), request: z.string().min(1), sensitive: z.boolean(), new_chat: z.boolean().optional() })
const CalendarInput = z.object({ range: z.string().optional() })
const AddEventInput = z.object({ title: z.string().min(1), start: z.string(), end: z.string().optional(), all_day: z.boolean().optional(), location: z.string().optional() })
const RemindersInput = z.object({ list: z.string().optional() })
const AddReminderInput = z.object({ title: z.string().min(1), due: z.string().optional(), list: z.string().optional() })
const NotesInput = z.object({ action: z.enum(['recent', 'search', 'read', 'create']), query: z.string().optional(), title: z.string().optional(), body: z.string().optional() })
const ClockInput = z.object({ cities: z.array(z.string()).max(5) })
const MacInput = z.object({
  action: z.enum(['volume', 'volume_up', 'volume_down', 'mute', 'unmute', 'dark_mode', 'light_mode', 'toggle_appearance', 'sleep_display']),
  level: z.number().optional(),
})
const CompleteReminderInput = z.object({ title: z.string().min(1) })
const MemoryInput = z.object({ action: z.enum(['remember', 'forget', 'list']), text: z.string().optional() })
const FindInput = z.object({ query: z.string().min(1) })
const TimerInput = z.object({
  action: z.enum(['start', 'alarm', 'list', 'cancel']),
  seconds: z.number().optional(),
  time: z.string().optional(),
  label: z.string().optional(),
  target: z.string().optional(),
})
const WIDGETS = ['weather', 'stock', 'calendar', 'reminders', 'notes', 'clock', 'battery', 'now_playing', 'timers'] as const
const PinInput = z.object({
  action: z.enum(['pin', 'unpin']),
  widget: z.enum([...WIDGETS, 'all']),
  location: z.string().optional(),
  symbol: z.string().optional(),
  cities: z.array(z.string()).optional(),
  screen: z.union([z.enum(['this', 'main', 'other']), z.number().int().min(1).max(6)]).optional(),
})

function toolDefs(settings: Settings): Anthropic.Beta.BetaToolUnion[] {
  const agents = settings.agents.filter((a) => a.enabled)
  const tools: Anthropic.Beta.BetaToolUnion[] = [
    {
      name: 'show_panel',
      description:
        'Show a visual answer in Watson\'s panel. Use it for anything better seen than heard: comparisons, steps, schedules, data, code. Block types: text (markdown), cards (items: title, subtitle?, body?), list (items: title, detail?, meta?; ordered?), table (columns, rows), stats (items: label, value, delta?, trend up|down|flat), chart (kind line|bar, series: [{name, points: [{x, y}]}], yLabel?).',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          blocks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['text', 'cards', 'list', 'table', 'stats', 'chart'] },
                markdown: { type: 'string' },
                ordered: { type: 'boolean' },
                items: { type: 'array', items: { type: 'object' } },
                columns: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } } },
                kind: { type: 'string', enum: ['line', 'bar'] },
                yLabel: { type: 'string' },
                series: { type: 'array', items: { type: 'object' } },
              },
              required: ['type'],
            },
          },
        },
        required: ['blocks'],
      },
    },
    {
      name: 'get_weather',
      description: `Current weather and forecast. Draws a weather widget for the user. Omit location for the user's home (${settings.homeCity}).`,
      input_schema: { type: 'object', properties: { location: { type: 'string', description: 'City, e.g. "Lisbon"' } } },
    },
    {
      name: 'get_stock',
      description: 'Live stock or crypto price with a chart widget. Use ticker symbols (AAPL, TSLA, BTC-USD, ^GSPC for the S&P 500).',
      input_schema: {
        type: 'object',
        properties: { symbol: { type: 'string' }, range: { type: 'string', enum: ['1D', '1W', '1M', '3M', '1Y'] } },
        required: ['symbol'],
      },
    },
    {
      name: 'music',
      description: `Control Spotify or Apple Music on this Mac and show what's playing. Default app: ${settings.musicApp === 'music' ? 'apple_music' : 'spotify'}.`,
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['play', 'pause', 'resume', 'next', 'previous', 'now_playing'] },
          query: { type: 'string', description: 'For play: song, album, artist or playlist name' },
          kind: { type: 'string', enum: ['track', 'album', 'playlist', 'artist'] },
          app: { type: 'string', enum: ['spotify', 'apple_music'] },
        },
        required: ['action'],
      },
    },
    {
      name: 'get_calendar',
      description: 'Show events from the user\'s Apple Calendar (all their accounts). Draws a calendar widget.',
      input_schema: { type: 'object', properties: { range: { type: 'string', description: '"today", "tomorrow", "week", or a date YYYY-MM-DD' } } },
    },
    {
      name: 'add_calendar_event',
      description: 'Add an event to the user\'s default calendar. Times are local, format YYYY-MM-DDTHH:mm.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, all_day: { type: 'boolean' }, location: { type: 'string' } },
        required: ['title', 'start'],
      },
    },
    {
      name: 'get_reminders',
      description: 'Show incomplete reminders from Apple Reminders. Draws a reminders widget.',
      input_schema: { type: 'object', properties: { list: { type: 'string', description: 'List name, e.g. "Groceries". Omit for all lists.' } } },
    },
    {
      name: 'add_reminder',
      description: 'Add a reminder to Apple Reminders. Due time is local, format YYYY-MM-DDTHH:mm.',
      input_schema: { type: 'object', properties: { title: { type: 'string' }, due: { type: 'string' }, list: { type: 'string' } }, required: ['title'] },
    },
    {
      name: 'complete_reminder',
      description: 'Check off (complete) one of the user\'s open reminders by its title or words in it. Shows the updated list.',
      input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    },
    {
      name: 'notes',
      description: 'Apple Notes: list recent notes, search them, read one, or create a new note. Draws a notes widget.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['recent', 'search', 'read', 'create'] },
          query: { type: 'string', description: 'For search/read: words in the title or text' },
          title: { type: 'string', description: 'For create' },
          body: { type: 'string', description: 'For create: plain text, new lines allowed' },
        },
        required: ['action'],
      },
    },
    {
      name: 'world_clock',
      description: 'Show the time in other cities as clock widgets.',
      input_schema: { type: 'object', properties: { cities: { type: 'array', items: { type: 'string' } } }, required: ['cities'] },
    },
    {
      name: 'battery',
      description: 'Show the Mac\'s battery level and charging state.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'timer',
      description:
        'Timers and alarms on this Mac, with a live countdown widget. When one goes off Watson chimes, says it out loud and shows a notification. start: a countdown (seconds, label?). alarm: at a clock time (time "HH:mm" for the next occurrence, or "YYYY-MM-DDTHH:mm"; label?). list. cancel: target = label, "all", or omit for the soonest.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'alarm', 'list', 'cancel'] },
          seconds: { type: 'number', description: 'For start: total length in seconds (10 minutes = 600)' },
          time: { type: 'string', description: 'For alarm: local time' },
          label: { type: 'string', description: 'What it is for, e.g. "pasta"' },
          target: { type: 'string', description: 'For cancel' },
        },
        required: ['action'],
      },
    },
    {
      name: 'mac',
      description:
        'Control this Mac: volume (level 0-100), volume_up / volume_down (level = step, default 15), mute, unmute, dark_mode, light_mode, toggle_appearance, sleep_display (also locks if a password is required on wake).',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['volume', 'volume_up', 'volume_down', 'mute', 'unmute', 'dark_mode', 'light_mode', 'toggle_appearance', 'sleep_display'] },
          level: { type: 'number' },
        },
        required: ['action'],
      },
    },
    {
      name: 'memory',
      description:
        'Long-term memory on this Mac. remember: save a fact the user tells you to keep (write it as a short self-contained sentence, e.g. "Car is parked on level 3, spot B12 (Nov 27)"). forget: remove memories containing text ("all" for everything). list: show them.',
      input_schema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['remember', 'forget', 'list'] }, text: { type: 'string' } },
        required: ['action'],
      },
    },
    {
      name: 'read_clipboard',
      description: 'Read the text the user has copied, when they refer to it ("what I copied", "this text", "summarize/translate/reply to this"). Only when asked.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'find_files',
      description: 'Find files and folders on this Mac with Spotlight, by name or content. Shows a list; then use open (kind file) with the path if the user wants it opened.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Words in the file name or text, e.g. "tax 2025"' } }, required: ['query'] },
    },
    {
      name: 'pin_widget',
      description:
        'Pin a live widget to the screen as a small floating window that stays and refreshes itself, or remove pinned widgets. Screens: "this" (where the user is), "main", "other" (another display), or a display number.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['pin', 'unpin'] },
          widget: { type: 'string', enum: [...WIDGETS, 'all'] },
          location: { type: 'string', description: 'For weather' },
          symbol: { type: 'string', description: 'For stock' },
          cities: { type: 'array', items: { type: 'string' }, description: 'For clock' },
          screen: { description: '"this", "main", "other" or a number', anyOf: [{ type: 'string', enum: ['this', 'main', 'other'] }, { type: 'integer' }] },
        },
        required: ['action', 'widget'],
      },
    },
    {
      name: 'open',
      description: 'Open an app, a website or a file on this Mac.',
      input_schema: {
        type: 'object',
        properties: { kind: { type: 'string', enum: ['app', 'url', 'file'] }, target: { type: 'string', description: 'App name, URL, or file path' } },
        required: ['kind', 'target'],
      },
    },
  ]
  if (agents.length) {
    tools.push({
      name: 'delegate',
      description:
        `Type a request into one of the user's AI agents (Mac apps or chat websites), which have their own tools and connectors (Gmail, Drive, code, files, web research, X/Twitter for Grok). Use it for: coding or changing their website/projects, anything needing their email or documents, long research, or whenever they name the agent ("ask Grok…"). The answer comes back later and is summarized for the user. Agents: ${agents.map((a) => `${a.id} (${a.name})`).join(', ')}. Default: ${settings.defaultAgent}.`,
      input_schema: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: agents.map((a) => a.id) },
          request: { type: 'string', description: 'A clear, complete prompt written as the user, keeping every detail they gave.' },
          sensitive: { type: 'boolean', description: 'true if it would send, post, delete, buy or change something that cannot be undone' },
          new_chat: { type: 'boolean', description: 'false only when this follows up on the previous request to the same agent' },
        },
        required: ['agent', 'request', 'sensitive'],
      },
    })
  }
  return tools
}

function systemPrompt(settings: Settings, spoken: boolean): string {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  return [
    "You are Watson, the user's personal assistant on their Mac. You orchestrate their AI apps and show visual answers.",
    spoken
      ? 'Your reply is spoken aloud: 1 to 3 short, natural sentences. No markdown, no lists, no URLs in what you say.'
      : 'The user typed this. Reply briefly in plain text.',
    'When an answer is better seen (steps, comparisons, tables, numbers, code), call show_panel and say only one sentence.',
    'Widget tools (weather, stocks, music, calendar, reminders, notes, clock, battery) draw their own widgets; after using them, just say the key fact.',
    'For "good morning", "brief me" or "how does my day look": call get_weather, get_calendar (today) and get_reminders together, then give a warm 2–3 sentence briefing. Never correct the user\'s greeting or the time of day; focus on what is still ahead today.',
    'Use memory to remember things only when the user asks you to remember or note something about themselves; to answer "where did I park" and similar, use what you remember.',
    'Timers and alarms ("set a timer for 10 minutes", "wake me at 7") use the timer tool; confirm the length or time in a few words.',
    'When the user wants something kept on screen ("pin", "keep it up", "put it on my other screen"), use pin_widget.',
    'Calendar events and reminders you add take effect right away: repeat back what you added.',
    'Use delegate for coding, website changes, email, calendar, documents and anything needing the user\'s connectors. Then say in a few words that you handed it off.',
    'Never claim you did something you did not do. If you are unsure, say so.',
    'Answer only the newest request and call only the tools it needs. Your earlier replies in this conversation were based on real tool results (only their text is kept to save space): trust them, and never re-check, retract or "correct" them unless the user says something is wrong.',
    'Say each thing once: after a tool runs, do not add a closing line like "Done." or repeat what the widget shows.',
    `Today is ${today}. Home city: ${settings.homeCity}. Units: °${settings.units}.`,
    memoryPrompt(),
  ]
    .filter(Boolean)
    .join('\n')
}

/** A closing line that adds nothing after a real answer. */
const FILLER = /^(done|shown|all set|okay|ok|there you go|here you go|got it)[.!]?$/i

const toolName = (t: Anthropic.Beta.BetaToolUnion) => ('name' in t ? t.name : '')

const HARD = /\b(why|explain|compare|analy[sz]e|plan|strategy|pros and cons|think (hard|carefully|it through)|reason|step by step|in detail|deep(ly)?|write (me )?(a|an)|draft|essay|summari[sz]e)\b/i

export function pickModel(text: string, settings: Settings): string {
  if (!settings.smartRouting) return HAIKU
  return HARD.test(text) || text.split(/\s+/).length > 45 ? SONNET : HAIKU
}

// ---------------- The brain ----------------

export class Brain {
  private client: Anthropic | null = null
  private clientKey: string | null = null
  private history: Msg[] = []
  private webSearchBroken = new Set<string>()

  private getClient(): Anthropic {
    const key = getSecret('anthropic')
    if (!key) throw new Error('Add your Anthropic API key in Settings first.')
    if (!this.client || this.clientKey !== key) {
      this.client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 90_000 })
      this.clientKey = key
    }
    return this.client
  }

  resetConversation() {
    this.history = []
  }

  private checkBudget(settings: Settings) {
    if (settings.dailyBudgetUsd > 0 && spentToday() >= settings.dailyBudgetUsd) {
      throw new BudgetError(`You've reached today's budget of $${settings.dailyBudgetUsd.toFixed(2)}. You can raise it in Settings.`)
    }
  }

  async respond(text: string, opts: { spoken: boolean; signal: AbortSignal; host: ToolHost; onText: (delta: string) => void }): Promise<string> {
    const settings = getSettings()
    this.checkBudget(settings)
    const client = this.getClient()
    const model = pickModel(text, settings)
    const tools = toolDefs(settings)
    if (settings.webSearch && !this.webSearchBroken.has(model)) {
      tools.push(
        model === SONNET
          ? { type: 'web_search_20260209', name: 'web_search', max_uses: 3 }
          : { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
      )
    }
    const now = new Date().toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    // The time goes on this message only, so the cached system prompt stays the same all day.
    const messages: Msg[] = [...this.history, { role: 'user', content: `${text}\n\n(Local time: ${now})` }]
    const toolsUsed: string[] = []
    let finalText = ''
    let shown = ''

    for (let round = 0; round < 6; round++) {
      let message: Anthropic.Beta.BetaMessage
      // Later rounds follow tool calls. Keep a space between rounds, and hold back their first
      // few characters so a bare "Done." after a real answer can be dropped.
      let held = ''
      let passing = !shown
      let firstOfRound = true
      const emit = (d: string) => {
        // Only the first piece of a later round needs a space in front of it.
        if (firstOfRound && shown && !/\s$/.test(shown) && !/^\s/.test(d)) d = ` ${d}`
        firstOfRound = false
        shown += d
        opts.onText(d)
      }
      const onText = (d: string) => {
        if (passing) return emit(d)
        held += d
        if (held.trim().length >= 16) {
          passing = true
          emit(held.trimStart())
          held = ''
        }
      }
      try {
        message = await this.stream(client, model, settings, opts.spoken, tools, messages, { signal: opts.signal, onText })
        if (held.trim() && !FILLER.test(held.trim())) emit(held.trimStart())
      } catch (err) {
        if (err instanceof Anthropic.BadRequestError && /web_search/i.test(err.message) && tools.some((t) => toolName(t) === 'web_search')) {
          this.webSearchBroken.add(model)
          tools.splice(tools.findIndex((t) => toolName(t) === 'web_search'), 1)
          round--
          continue
        }
        throw err
      }
      const roundText = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim()
      if (roundText && !(finalText && FILLER.test(roundText))) finalText = finalText ? `${finalText} ${roundText}` : roundText

      if (message.stop_reason === 'refusal') {
        finalText ||= "I can't help with that one."
        break
      }
      if (message.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: message.content })
        continue
      }
      const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      if (!calls.length || message.stop_reason === 'max_tokens') break

      messages.push({ role: 'assistant', content: message.content })
      const results = await Promise.all(
        calls.map(async (call): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          toolsUsed.push(call.name)
          try {
            const out = await this.runTool(call.name, call.input, settings, opts.host)
            return { type: 'tool_result', tool_use_id: call.id, content: out }
          } catch (e) {
            return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: e instanceof Error ? e.message : String(e) }
          }
        }),
      )
      messages.push({ role: 'user', content: results })
    }

    // Keep only plain text in memory: small, cheap context next time.
    const remembered = finalText.trim() || (toolsUsed.length ? `(used ${[...new Set(toolsUsed)].join(', ')})` : '(no answer)')
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: remembered })
    this.history = this.history.slice(-12)
    return finalText.trim()
  }

  private async stream(
    client: Anthropic,
    model: string,
    settings: Settings,
    spoken: boolean,
    tools: Anthropic.Beta.BetaToolUnion[],
    messages: Msg[],
    opts: { signal: AbortSignal; onText: (delta: string) => void },
  ): Promise<Anthropic.Beta.BetaMessage> {
    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model,
      max_tokens: 4096,
      system: systemPrompt(settings, spoken),
      tools,
      messages,
      cache_control: { type: 'ephemeral' },
      output_config: { effort: model === SONNET ? 'medium' : 'low' },
      stream: true,
    }
    if (model === SONNET) {
      // If Sonnet declines on a safety false positive, the API retries on a fallback model.
      params.betas = ['server-side-fallback-2026-07-01']
      params.fallbacks = 'default'
    }
    const stream = client.beta.messages.stream(params, { signal: opts.signal })
    stream.on('text', (delta) => opts.onText(delta))
    const message = await stream.finalMessage()
    record(model, message.usage)
    return message
  }

  private async runTool(name: string, input: unknown, settings: Settings, host: ToolHost): Promise<string> {
    switch (name) {
      case 'show_panel': {
        const p = ShowPanelInput.safeParse(input)
        if (!p.success) throw new Error(`Invalid panel: ${p.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
        host.addBlocks(p.data.blocks as Block[], { title: p.data.title, subtitle: p.data.subtitle })
        return 'Shown.'
      }
      case 'get_weather': {
        const { location } = WeatherInput.parse(input)
        const place = location?.trim() || settings.homeCity
        const a = host.activity(`Checking the weather in ${place}`)
        try {
          const w = await getWeather(place, settings.units)
          host.addBlocks([{ type: 'weather', data: w }])
          host.finishActivity(a, true)
          return JSON.stringify(weatherForModel(w))
        } catch (e) {
          host.finishActivity(a, false)
          throw e
        }
      }
      case 'get_stock': {
        const { symbol, range } = StockInput.parse(input)
        const a = host.activity(`Looking up ${symbol.toUpperCase()}`)
        try {
          const s = await getStock(symbol, (range ?? '1D') as StockRange)
          host.addBlocks([{ type: 'stock', data: s }])
          host.finishActivity(a, true)
          return JSON.stringify(stockForModel(s))
        } catch (e) {
          host.finishActivity(a, false)
          throw new Error(`Couldn't get ${symbol}: ${e instanceof Error ? e.message : e}`)
        }
      }
      case 'music': {
        const { action, query, kind, app } = MusicInput.parse(input)
        const which: MusicApp = app === 'apple_music' ? 'music' : app === 'spotify' ? 'spotify' : settings.musicApp
        const label = which === 'music' ? 'Music' : 'Spotify'
        const a = host.activity(action === 'play' && query ? `Finding ${query} on ${label}` : `Talking to ${label}`)
        try {
          let result = 'Done.'
          if (action === 'play') {
            if (!query) await music.control(which, 'resume')
            else result = await music.play(which, query, kind ?? 'track')
          } else if (action !== 'now_playing') {
            await music.control(which, action)
          }
          await new Promise((r) => setTimeout(r, 700))
          const np = await music.nowPlaying(which).catch(() => null)
          if (np) host.addBlocks([{ type: 'nowPlaying', data: np }])
          host.finishActivity(a, true)
          return np ? `${result} Now ${np.state}: ${np.title} by ${np.artist}.` : result
        } catch (e) {
          host.finishActivity(a, false)
          throw new Error(`${label}: ${e instanceof Error ? e.message : e}. Is the app installed, and is Automation allowed for Watson?`)
        }
      }
      case 'get_calendar': {
        const { range } = CalendarInput.parse(input)
        const a = host.activity('Checking your calendar')
        try {
          const c = await getCalendar(host.helper, range || 'today')
          host.addBlocks([{ type: 'calendar', data: c }])
          host.finishActivity(a, true)
          return JSON.stringify(calendarForModel(c))
        } catch (e) {
          host.finishActivity(a, false)
          throw e
        }
      }
      case 'add_calendar_event': {
        const e = AddEventInput.parse(input)
        const a = host.activity(`Adding “${e.title}” to your calendar`)
        try {
          const r = await addEvent(host.helper, { title: e.title, start: e.start, end: e.end, allDay: e.all_day, location: e.location })
          const c = await getCalendar(host.helper, r.date, e.title)
          host.addBlocks([{ type: 'calendar', data: c }])
          host.finishActivity(a, true)
          return r.summary
        } catch (err) {
          host.finishActivity(a, false)
          throw err
        }
      }
      case 'get_reminders': {
        const { list } = RemindersInput.parse(input)
        const a = host.activity('Checking your reminders')
        try {
          const r = await getReminders(host.helper, list)
          host.addBlocks([{ type: 'reminders', data: r }])
          host.finishActivity(a, true)
          return JSON.stringify(remindersForModel(r))
        } catch (e) {
          host.finishActivity(a, false)
          throw e
        }
      }
      case 'add_reminder': {
        const r = AddReminderInput.parse(input)
        const a = host.activity(`Adding “${r.title}” to Reminders`)
        try {
          const msg = await addReminder(host.helper, r)
          const list = await getReminders(host.helper, r.list, r.title)
          host.addBlocks([{ type: 'reminders', data: list }])
          host.finishActivity(a, true)
          return msg
        } catch (e) {
          host.finishActivity(a, false)
          throw e
        }
      }
      case 'notes': {
        const n = NotesInput.parse(input)
        const a = host.activity(n.action === 'create' ? 'Creating a note' : n.action === 'recent' ? 'Opening your notes' : `Looking for “${n.query ?? ''}” in Notes`)
        try {
          const data =
            n.action === 'recent'
              ? await recentNotes()
              : n.action === 'search'
                ? await searchNotes(n.query ?? '')
                : n.action === 'read'
                  ? await readNote(n.query ?? n.title ?? '')
                  : await createNote(n.title ?? 'New note', n.body ?? '')
          host.addBlocks([{ type: 'notes', data }])
          host.finishActivity(a, true)
          return n.action === 'create' ? `Created the note “${n.title ?? 'New note'}”.` : JSON.stringify(notesForModel(data))
        } catch (e) {
          host.finishActivity(a, false)
          throw new Error(`Notes: ${e instanceof Error ? e.message : e}`)
        }
      }
      case 'world_clock': {
        const { cities } = ClockInput.parse(input)
        const c = await worldClock(cities)
        host.addBlocks([{ type: 'clock', data: c }])
        return JSON.stringify(clockForModel(c))
      }
      case 'battery': {
        const b = await battery()
        host.addBlocks([{ type: 'battery', data: b }])
        return b.percent === null ? 'This Mac has no battery (it is on power).' : `${b.percent}%, ${b.state}${b.timeRemaining ? `, ${b.timeRemaining} left` : ''}.`
      }
      case 'complete_reminder': {
        const { title } = CompleteReminderInput.parse(input)
        const a = host.activity(`Checking off “${title}”`)
        try {
          const msg = await completeReminder(host.helper, title)
          host.addBlocks([{ type: 'reminders', data: await getReminders(host.helper) }])
          host.finishActivity(a, true)
          return msg
        } catch (e) {
          host.finishActivity(a, false)
          throw e
        }
      }
      case 'mac': {
        const { action, level } = MacInput.parse(input)
        try {
          return await macControl(action as MacAction, level)
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e)
          if (/not allowed|-1743|assistive/i.test(m)) throw new Error('macOS blocked it. Allow Watson to control "System Events" in System Settings → Privacy & Security → Automation.')
          throw e
        }
      }
      case 'memory': {
        const { action, text } = MemoryInput.parse(input)
        if (action === 'remember') {
          const m = remember(text ?? '')
          host.addBlocks([{ type: 'list', items: [{ title: m.text, meta: 'Remembered' }] }], { title: 'Watson will remember' })
          return `Remembered: ${m.text}`
        }
        if (action === 'forget') {
          const gone = forget(text ?? '')
          return gone.length ? `Forgot ${gone.length} thing${gone.length === 1 ? '' : 's'}: ${gone.map((g) => g.text).join('; ')}` : 'Nothing matched.'
        }
        const all = memories()
        if (all.length) host.addBlocks([{ type: 'list', items: all.map((m) => ({ title: m.text, meta: new Date(m.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) })) }], { title: 'What Watson remembers' })
        return all.length ? `${all.length} memories, shown.` : 'Nothing remembered yet.'
      }
      case 'read_clipboard': {
        const text = (await clipboard.readText()).trim()
        if (!text) return 'The clipboard has no text.'
        return text.length > 6000 ? `${text.slice(0, 6000)}\n[…clipboard cut at 6000 characters]` : text
      }
      case 'find_files': {
        const { query } = FindInput.parse(input)
        const a = host.activity(`Searching for “${query}”`)
        try {
          const found = await findFiles(query)
          host.finishActivity(a, true)
          if (!found.length) return `No files found for "${query}".`
          const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          host.addBlocks([{ type: 'list', items: found.map((f) => ({ title: f.name, detail: f.folder, meta: `${f.kind} · ${day(f.modified)}` })) }], { title: `Files matching “${query}”` })
          return JSON.stringify({ files: found.map((f) => ({ name: f.name, path: f.path, modified: day(f.modified) })), list: 'shown to the user already; do not show it again' })
        } catch (e) {
          host.finishActivity(a, false)
          throw e
        }
      }
      case 'timer': {
        const t = TimerInput.parse(input)
        const show = (highlight?: string) => host.addBlocks([{ type: 'timers', data: { items: timers.list(), highlight } }])
        const at = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        switch (t.action) {
          case 'start': {
            const item = timers.start(t.seconds ?? 0, t.label)
            show(item.id)
            return `Started ${item.label ? `the ${item.label} timer` : 'a timer'} for ${spokenDuration(item.durationSec)}. It ends at ${at(item.endsAt)}.`
          }
          case 'alarm': {
            const raw = (t.time ?? '').trim()
            const hm = raw.match(/^(\d{1,2}):(\d{2})$/)
            const when = hm ? new Date(new Date().setHours(Number(hm[1]), Number(hm[2]), 0, 0)) : new Date(raw)
            const item = timers.alarm(when, t.label)
            show(item.id)
            const day = new Date(item.endsAt).toDateString() === new Date().toDateString() ? 'today' : new Date(item.endsAt).toLocaleDateString('en-US', { weekday: 'long' })
            return `Alarm set for ${at(item.endsAt)} ${day}${item.label ? ` (${item.label})` : ''}. Watson must be running for it to go off.`
          }
          case 'list': {
            const list = timers.list()
            show()
            return list.length ? list.map((x) => `${timerName(x)}: ends ${at(x.endsAt)}`).join('; ') : 'No timers or alarms are running.'
          }
          case 'cancel': {
            const gone = timers.cancel(t.target)
            if (timers.list().length) show()
            return gone.length ? `Cancelled ${gone.map(timerName).join(', ')}.` : 'There was no matching timer.'
          }
        }
        return 'Done.'
      }
      case 'pin_widget': {
        const p = PinInput.parse(input)
        const kind = (p.widget === 'now_playing' ? 'nowPlaying' : p.widget) as WidgetKind | 'all'
        if (p.action === 'unpin') {
          host.unpin(kind)
          return kind === 'all' ? 'Removed all pinned widgets.' : `Removed the pinned ${p.widget.replace('_', ' ')} widget.`
        }
        if (kind === 'all') throw new Error('Pin one widget at a time.')
        const params: Record<string, string> = {}
        if (p.location) params.location = p.location
        if (p.symbol) params.symbol = p.symbol.toUpperCase()
        if (p.cities?.length) params.cities = p.cities.join(',')
        if (kind === 'nowPlaying') params.app = settings.musicApp
        await host.pin(kind, params, p.screen ?? 'this')
        return `Pinned the ${p.widget.replace('_', ' ')} widget to the ${typeof p.screen === 'number' ? `screen ${p.screen}` : p.screen === 'other' ? 'other screen' : p.screen === 'main' ? 'main screen' : 'screen'}. It refreshes on its own and can be dragged anywhere.`
      }
      case 'open': {
        const { kind, target } = OpenInput.parse(input)
        const a = host.activity(`Opening ${target}`)
        try {
          const r = kind === 'app' ? await openApp(target) : kind === 'url' ? await openUrl(target) : await openFile(target)
          host.finishActivity(a, true)
          return r
        } catch (e) {
          host.finishActivity(a, false)
          throw e
        }
      }
      case 'delegate': {
        const { agent, request, sensitive, new_chat } = DelegateInput.parse(input)
        return host.delegate(agent, request, sensitive, new_chat ?? true)
      }
      default:
        throw new Error(`Unknown tool ${name}`)
    }
  }

  /** Summarize another agent's answer for the ear, plus an optional panel. */
  async summarize(agentName: string, prompt: string, replyText: string): Promise<{ spoken: string; panel: Panel | null }> {
    const settings = getSettings()
    this.checkBudget(settings)
    const client = this.getClient()
    const blocks: Block[] = []
    let meta: { title?: string; subtitle?: string } = {}
    const clipped = replyText.length > 14_000 ? `${replyText.slice(0, 14_000)}\n[…cut for length]` : replyText
    const messages: Msg[] = [
      {
        role: 'user',
        content: `The user asked ${agentName}:\n<request>${prompt}</request>\n\n${agentName} answered:\n<answer>${clipped}</answer>\n\nTell the user what ${agentName} said in 1 to 3 spoken sentences: the outcome first, then anything they need to do. If the answer has code, steps, a list, a draft or data, also call show_panel with a clean, readable version (code in a markdown text block).`,
      },
    ]
    const tools = toolDefs(settings).filter((t) => toolName(t) === 'show_panel')
    let spoken = ''
    for (let round = 0; round < 3; round++) {
      const message = await client.beta.messages.create({
        model: HAIKU,
        max_tokens: 4096,
        system: 'You are Watson, a voice assistant. You relay answers from the user\'s other AI apps clearly and briefly. Spoken text has no markdown.',
        tools,
        messages,
        output_config: { effort: 'low' },
      })
      record(HAIKU, message.usage)
      // Keep the first real summary; later rounds (after show_panel) only add filler like "Done."
      const roundText = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim()
      if (!spoken && roundText) spoken = roundText
      const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      if (!calls.length) break
      messages.push({ role: 'assistant', content: message.content })
      messages.push({
        role: 'user',
        content: calls.map((call): Anthropic.Beta.BetaToolResultBlockParam => {
          const p = ShowPanelInput.safeParse(call.input)
          if (!p.success) return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: p.error.message }
          blocks.push(...(p.data.blocks as Block[]))
          meta = { title: p.data.title, subtitle: p.data.subtitle }
          return { type: 'tool_result', tool_use_id: call.id, content: 'Shown.' }
        }),
      })
    }
    return { spoken: spoken.trim(), panel: blocks.length ? { ...meta, blocks } : null }
  }
}
