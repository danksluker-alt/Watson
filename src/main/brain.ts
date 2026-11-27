// Watson's brain: picks a model, gives it tools, streams the answer.
//
// Cost rules (you're on a budget):
//   - Claude Haiku 5.5 answers by default; Claude Sonnet 5.5 only for requests
//     that look like they need real reasoning ("explain", "compare", long asks).
//   - Only the last few exchanges are sent, as plain text.
//   - Widgets (weather, stocks, Spotify) are drawn locally from free data;
//     the model only sees a one-line summary of them.
import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import type { Block, Panel, Settings, StockRange } from '@shared/types'
import { getSecret, getSettings } from './settings'
import { record, spentToday } from './usage'
import { getWeather, weatherForModel } from './tools/weather'
import { getStock, stockForModel } from './tools/stocks'
import * as spotify from './tools/spotify'
import { openApp, openFile, openUrl } from './tools/system'

export const HAIKU = 'claude-haiku-5-5'
export const SONNET = 'claude-sonnet-5-5'

type Msg = Anthropic.Beta.BetaMessageParam

export type ToolHost = {
  /** Show (or add to) this turn's panel. */
  addBlocks: (blocks: Block[], meta?: { title?: string; subtitle?: string }) => void
  activity: (text: string) => string
  finishActivity: (id: string, ok: boolean, text?: string) => void
  /** Hand a request to another AI app. Resolves once it has been queued. */
  delegate: (agentId: string, prompt: string, sensitive: boolean) => Promise<string>
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
const SpotifyInput = z.object({
  action: z.enum(['play', 'pause', 'resume', 'next', 'previous', 'now_playing']),
  query: z.string().optional(),
  kind: z.enum(['track', 'album', 'playlist', 'artist']).optional(),
})
const OpenInput = z.object({ kind: z.enum(['app', 'url', 'file']), target: z.string().min(1) })
const DelegateInput = z.object({ agent: z.string(), request: z.string().min(1), sensitive: z.boolean() })

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
      name: 'spotify',
      description: 'Control the Spotify app on this Mac and show what is playing.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['play', 'pause', 'resume', 'next', 'previous', 'now_playing'] },
          query: { type: 'string', description: 'For play: song, album, artist or playlist name' },
          kind: { type: 'string', enum: ['track', 'album', 'playlist', 'artist'] },
        },
        required: ['action'],
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
        `Type a request into one of the user's AI apps, which have their own tools and connectors (Gmail, Calendar, Drive, code, files, web research). Use it for: coding or changing their website/projects, anything needing their email/calendar/documents, long research, or when they name the agent. The answer comes back later and is summarized for the user. Available agents: ${agents.map((a) => `${a.id} (${a.name})`).join(', ')}. Default: ${settings.defaultAgent}.`,
      input_schema: {
        type: 'object',
        properties: {
          agent: { type: 'string', enum: agents.map((a) => a.id) },
          request: { type: 'string', description: 'A clear, complete prompt written as the user, keeping every detail they gave.' },
          sensitive: { type: 'boolean', description: 'true if it would send, post, delete, buy or change something that cannot be undone' },
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
    'get_weather, get_stock and spotify draw their own widgets; after using them, just say the key fact.',
    'Use delegate for coding, website changes, email, calendar, documents and anything needing the user\'s connectors. Then say in a few words that you handed it off.',
    'Never claim you did something you did not do. If you are unsure, say so.',
    `Today is ${today}. Home city: ${settings.homeCity}. Units: °${settings.units}.`,
  ].join('\n')
}

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
    const messages: Msg[] = [...this.history, { role: 'user', content: text }]
    const toolsUsed: string[] = []
    let finalText = ''

    for (let round = 0; round < 6; round++) {
      let message: Anthropic.Beta.BetaMessage
      try {
        message = await this.stream(client, model, settings, opts.spoken, tools, messages, opts)
      } catch (err) {
        if (err instanceof Anthropic.BadRequestError && /web_search/i.test(err.message) && tools.some((t) => toolName(t) === 'web_search')) {
          this.webSearchBroken.add(model)
          tools.splice(tools.findIndex((t) => toolName(t) === 'web_search'), 1)
          round--
          continue
        }
        throw err
      }
      for (const b of message.content) if (b.type === 'text') finalText += b.text

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
      case 'spotify': {
        const { action, query, kind } = SpotifyInput.parse(input)
        const a = host.activity(action === 'play' ? `Finding ${query ?? 'music'} on Spotify` : 'Talking to Spotify')
        try {
          let result = 'Done.'
          if (action === 'play') {
            if (!query) await spotify.control('resume')
            else result = await spotify.play(query, kind ?? 'track')
          } else if (action !== 'now_playing') {
            await spotify.control(action)
          }
          await new Promise((r) => setTimeout(r, 700))
          const np = await spotify.nowPlaying().catch(() => null)
          if (np) host.addBlocks([{ type: 'nowPlaying', data: np }])
          host.finishActivity(a, true)
          return np ? `${result} Now ${np.state}: ${np.title} by ${np.artist}.` : result
        } catch (e) {
          host.finishActivity(a, false)
          throw new Error(`Spotify: ${e instanceof Error ? e.message : e}. Is the Spotify app installed, and is Automation allowed for Watson?`)
        }
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
        const { agent, request, sensitive } = DelegateInput.parse(input)
        return host.delegate(agent, request, sensitive)
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
      for (const b of message.content) if (b.type === 'text') spoken += b.text
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
