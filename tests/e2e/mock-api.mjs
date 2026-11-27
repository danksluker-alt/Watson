// A scripted stand-in for the Claude Messages API (streaming and not), plus
// the free data sources Watson uses (Open-Meteo, Yahoo Finance). It plays the
// model's part with simple rules so the real app's tool loop, streaming,
// panels, speech and hand-offs can be exercised without a key or network.
import http from 'node:http'

export function startMockApi(port) {
  const requests = []

  const lastUserText = (messages) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'user') continue
      if (typeof m.content === 'string') return m.content.replace(/\n\n\(Local time:[^)]*\)$/, '')
      const t = m.content.find((b) => b.type === 'text')
      if (t) return t.text.replace(/\n\n\(Local time:[^)]*\)$/, '')
    }
    return ''
  }
  const toolResults = (messages) => {
    const last = messages[messages.length - 1]
    return Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'tool_result') : []
  }
  const tomorrowAt = (h) => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}:00`
  }
  const todayAt = (h) => tomorrowAt(h).replace(/\d{4}-\d{2}-\d{2}/, new Date().toLocaleDateString('en-CA'))

  /** Decide the model's first move for a user request. */
  function plan(text) {
    const t = text.toLowerCase()
    if (t.includes('<answer>')) {
      const code = t.includes('```')
      return {
        text: code ? 'Claude updated the headline and opened a pull request for you to review.' : t.includes('sarah') ? 'Claude drafted the email to Sarah and saved it in Gmail. It is waiting for you to say send.' : 'Grok says people on X love the new camera, but complain about the price and battery life.',
        tools: code ? [{ name: 'show_panel', input: { title: 'Claude’s changes', blocks: [{ type: 'text', markdown: '```tsx\n<h1>Know your cycle.</h1>\n<Button>Start free</Button>\n```' }, { type: 'list', items: [{ title: 'Pull request #142', detail: 'Ready for review' }] }] } }] : [],
      }
    }
    if (/^(ask|have|tell) grok/.test(t)) return { tools: [{ name: 'delegate', input: { agent: 'grok', request: text.replace(/^(ask|have|tell) grok( to)?/i, '').trim().replace(/^./, (c) => c.toUpperCase()), sensitive: false } }] }
    if (/^(ask|have|tell) claude/.test(t)) {
      const req = text.replace(/^(ask|have|tell) claude( to)?/i, '').trim().replace(/^./, (c) => c.toUpperCase())
      return { tools: [{ name: 'delegate', input: { agent: 'claude', request: req, sensitive: /email|send/.test(t) } }] }
    }
    if (t.startsWith('pin ')) {
      const widget = ['weather', 'calendar', 'clock', 'battery', 'reminders', 'stock'].find((w) => t.includes(w)) ?? 'weather'
      return { tools: [{ name: 'pin_widget', input: { action: 'pin', widget, ...(widget === 'clock' ? { cities: ['Tokyo', 'London'] } : {}), screen: t.includes('other') ? 'other' : 'this' } }] }
    }
    if (t.includes('weather')) return { tools: [{ name: 'get_weather', input: { location: /in ([a-z ]+?)( this| today|\?|$)/.exec(t)?.[1]?.replace(/\b\w/g, (c) => c.toUpperCase()) ?? 'Lisbon' } }] }
    if (t.includes('stock')) return { tools: [{ name: 'get_stock', input: { symbol: t.includes('tesla') ? 'TSLA' : 'AAPL', range: '1D' } }] }
    if (t.startsWith('play ')) return { tools: [{ name: 'music', input: { action: 'play', query: text.slice(5).replace(/[.?!]$/, ''), kind: 'track' } }] }
    if (t.includes('add') && (t.includes('dentist') || t.includes('calendar'))) return { tools: [{ name: 'add_calendar_event', input: { title: 'Dentist', start: tomorrowAt(15), end: tomorrowAt(16) } }] }
    if (t.includes('calendar') || t.includes('my day')) return { tools: [{ name: 'get_calendar', input: { range: 'today' } }] }
    if (t.startsWith('remind me')) return { tools: [{ name: 'add_reminder', input: { title: 'Call Mom', due: todayAt(18) } }] }
    if (t.includes('reminders')) return { tools: [{ name: 'get_reminders', input: {} }] }
    if (t.includes('note')) return { tools: [{ name: 'notes', input: { action: 'recent' } }] }
    if (/\btime\b.*\bin\b/.test(t)) return { tools: [{ name: 'world_clock', input: { cities: ['Tokyo', 'London'] } }] }
    if (t.includes('battery')) return { tools: [{ name: 'battery', input: {} }] }
    if (t.includes('compare')) {
      return {
        text: 'Here is how the three plans compare.',
        tools: [{ name: 'show_panel', input: { title: 'Plans', blocks: [{ type: 'table', columns: ['Plan', 'Price', 'Best for'], rows: [['API only', '$1–3/mo', 'Quick questions'], ['Claude Pro', '$20/mo', 'Hand-offs'], ['Max', '$100/mo', 'Agents']] }] } }],
      }
    }
    return { text: 'The Eiffel Tower is about 330 meters tall, a little taller than when it opened in 1889.' }
  }

  /** The model's reply after its tools ran. */
  function afterTools(text, results) {
    const r = results.map((x) => (typeof x.content === 'string' ? x.content : JSON.stringify(x.content))).join('\n')
    if (results.some((x) => x.is_error)) return `Sorry, that didn't work: ${r.slice(0, 120)}`
    const t = text.toLowerCase()
    if (t.startsWith('pin ')) return r
    if (/^(ask|have|tell) (grok|claude)/.test(t)) return r.includes('confirm') ? 'I’ll hand that to Claude as soon as you confirm.' : `I’ve handed that to ${t.includes('grok') ? 'Grok' : 'Claude'}. I’ll tell you what comes back.`
    if (t.includes('weather')) {
      const j = JSON.parse(r)
      return `It's ${j.now.split(',')[0]} and mostly sunny in ${j.place} right now. Rain moves in over the weekend, so bring an umbrella.`
    }
    if (t.includes('stock')) {
      const j = JSON.parse(r)
      return `${j.name} is at ${j.price}, ${j.change.startsWith('+') ? 'up' : 'down'} ${j.change.split('(')[1].replace(/[()]/g, '').split(' ')[0]} today.`
    }
    if (t.includes('calendar') || t.includes('my day') || t.includes('dentist')) return t.includes('add') ? `${r} You're free then.` : 'You have four things today: standup at 9:30, a design review at 11:30, lunch with Ana and the gym at 6:30.'
    if (t.startsWith('remind me')) return `${r} I'll remind you.`
    if (t.includes('reminders')) return 'You have three reminders. Renewing your passport is overdue.'
    if (t.includes('note')) return 'Your latest note is the launch checklist from this morning.'
    if (/\btime\b.*\bin\b/.test(t)) return 'It’s the middle of the night in Tokyo, and early afternoon in London.'
    if (t.includes('battery')) return `Your Mac is at ${r}`
    if (t.startsWith('play ')) return r.split(' Now')[0]
    return 'Done.'
  }

  function respond(body) {
    const messages = body.messages ?? []
    const text = lastUserText(messages)
    const results = toolResults(messages)
    const toolNames = new Set((body.tools ?? []).map((t) => t.name))
    if (results.length) {
      try {
        return { text: afterTools(text, results), tools: [] }
      } catch (e) {
        return { text: `(mock could not read the tool result: ${e.message})`, tools: [] }
      }
    }
    const p = plan(text)
    return { text: p.text ?? '', tools: (p.tools ?? []).filter((t) => toolNames.has(t.name)) }
  }

  let seq = 0
  function message(body, r) {
    const content = []
    if (r.text) content.push({ type: 'text', text: r.text })
    for (const t of r.tools) content.push({ type: 'tool_use', id: `toolu_${++seq}`, name: t.name, input: t.input })
    return {
      id: `msg_${++seq}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content,
      stop_reason: r.tools.length ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1400, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
  }

  async function stream(res, body, r) {
    const msg = message(body, r)
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    send('message_start', { type: 'message_start', message: { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 1 } } })
    let index = 0
    for (const block of msg.content) {
      if (block.type === 'text') {
        send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        // Stream a few words at a time, like the real API.
        const words = block.text.split(/(?<= )/)
        for (let i = 0; i < words.length; i += 3) {
          send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: words.slice(i, i + 3).join('') } })
          await new Promise((r) => setTimeout(r, 25))
        }
      } else {
        send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
        send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
      }
      send('content_block_stop', { type: 'content_block_stop', index })
      index++
    }
    send('message_delta', { type: 'message_delta', delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { output_tokens: 60 } })
    send('message_stop', { type: 'message_stop' })
    res.end()
  }

  // ---------------- Data sources ----------------

  const PLACES = {
    lisbon: { name: 'Lisbon', latitude: 38.72, longitude: -9.14, timezone: 'Europe/Lisbon' },
    tokyo: { name: 'Tokyo', latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo' },
    london: { name: 'London', latitude: 51.5, longitude: -0.12, timezone: 'Europe/London' },
    'new york': { name: 'New York', latitude: 40.71, longitude: -74.0, timezone: 'America/New_York' },
  }

  function forecast() {
    const pad = (n) => String(n).padStart(2, '0')
    const now = new Date()
    const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`
    const hours = Array.from({ length: 48 }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + i))
    const days = Array.from({ length: 7 }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + i))
    return {
      current: { time: stamp(now), temperature_2m: 21.4, apparent_temperature: 20.6, weather_code: 1, wind_speed_10m: 13.8, relative_humidity_2m: 58, is_day: 1 },
      hourly: {
        time: hours.map(stamp),
        temperature_2m: hours.map((_, i) => 21 - i * 0.3 + Math.sin(i / 3)),
        weather_code: hours.map((_, i) => (i < 4 ? 1 : i < 8 ? 2 : i < 20 ? 3 : 61)),
        is_day: hours.map((h) => (h.getHours() >= 7 && h.getHours() < 18 ? 1 : 0)),
      },
      daily: {
        time: days.map((d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`),
        weather_code: [1, 61, 63, 3, 0, 0, 2],
        temperature_2m_max: [23, 20, 18, 19, 22, 24, 23],
        temperature_2m_min: [15, 14, 12, 11, 13, 15, 14],
        precipitation_probability_max: [10, 70, 85, 20, 0, 0, 10],
      },
    }
  }

  function chart(symbol, range) {
    const n = range === '1d' ? 78 : range === '5d' ? 65 : range === '1mo' ? 22 : range === '3mo' ? 64 : 52
    const step = range === '1d' ? 300 : range === '5d' ? 1800 : range === '1y' ? 604800 : 86400
    const start = Math.floor(Date.now() / 1000) - n * step
    const base = symbol === 'TSLA' ? 352 : 245
    const closes = Array.from({ length: n }, (_, i) => +(base + Math.sin(i / 7) * 2 + i * (range === '1y' ? 0.6 : 0.05) + Math.cos(i / 2.3) * 0.5).toFixed(2))
    return {
      chart: {
        result: [
          {
            meta: { symbol, currency: 'USD', regularMarketPrice: closes[n - 1], previousClose: base, chartPreviousClose: base, longName: symbol === 'TSLA' ? 'Tesla, Inc.' : 'Apple Inc.', marketState: 'REGULAR' },
            timestamp: closes.map((_, i) => start + i * step),
            indicators: { quote: [{ close: closes }] },
          },
        ],
        error: null,
      },
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname.startsWith('/v1/messages')) {
      const body = JSON.parse(await new Promise((r) => {
        let b = ''
        req.on('data', (c) => (b += c))
        req.on('end', () => r(b))
      }))
      requests.push({ model: body.model, stream: Boolean(body.stream), tools: (body.tools ?? []).map((t) => t.name), text: lastUserText(body.messages ?? []).slice(0, 200), betas: req.headers['anthropic-beta'] ?? null, effort: body.output_config?.effort ?? null })
      const r = respond(body)
      if (body.stream) return stream(res, body, r)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(message(body, r)))
    }
    if (url.pathname === '/v1/search') {
      const hit = PLACES[(url.searchParams.get('name') ?? '').toLowerCase()] ?? { ...PLACES.lisbon, name: url.searchParams.get('name') }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ results: [hit] }))
    }
    if (url.pathname === '/v1/forecast') {
      const f = forecast()
      if (url.searchParams.get('temperature_unit') === 'fahrenheit') {
        const F = (c) => c * 1.8 + 32
        f.current.temperature_2m = F(f.current.temperature_2m)
        f.current.apparent_temperature = F(f.current.apparent_temperature)
        f.hourly.temperature_2m = f.hourly.temperature_2m.map(F)
        f.daily.temperature_2m_max = f.daily.temperature_2m_max.map(F)
        f.daily.temperature_2m_min = f.daily.temperature_2m_min.map(F)
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(f))
    }
    const m = url.pathname.match(/^\/v8\/finance\/chart\/(.+)$/)
    if (m) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(chart(decodeURIComponent(m[1]), url.searchParams.get('range'))))
    }
    if (url.pathname === '/__requests') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify(requests))
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, requests })))
}
