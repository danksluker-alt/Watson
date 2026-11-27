// Renders the built UI in Chromium with a fake window.watson and sample data,
// so the design can be checked without macOS. Usage:
//   npm run build && node scripts/screenshots.mjs [outDir]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
// Playwright is not a project dependency; use whichever copy is installed.
const { chromium } = createRequire(import.meta.url)('playwright')

const root = path.resolve('out/renderer')
const outDir = path.resolve(process.argv[2] ?? 'screenshots')
fs.mkdirSync(outDir, { recursive: true })

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  const file = fs.existsSync(p) && fs.statSync(p).isFile() ? p : path.join(root, 'index.html')
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(0, r))
const base = `http://localhost:${server.address().port}`

const hours = ['Now', '3PM', '4PM', '5PM', '6PM', '7PM', '8PM', '9PM', '10PM', '11PM', '12AM', '1AM']
const weather = {
  place: 'Lisbon', unit: 'C',
  now: { temp: 21, feelsLike: 20, code: 1, isDay: true, humidity: 58, wind: 14 },
  today: { high: 23, low: 15, rainChance: 10 },
  hourly: hours.map((time, i) => ({ time, temp: 21 - Math.round(i / 2), code: i < 4 ? 1 : i < 7 ? 2 : 3, isDay: i < 5 })),
  daily: [
    { day: 'Today', high: 23, low: 15, code: 1, rainChance: 10 },
    { day: 'Sat', high: 20, low: 14, code: 61, rainChance: 70 },
    { day: 'Sun', high: 18, low: 12, code: 63, rainChance: 85 },
    { day: 'Mon', high: 19, low: 11, code: 3, rainChance: 20 },
    { day: 'Tue', high: 22, low: 13, code: 0, rainChance: 0 },
    { day: 'Wed', high: 24, low: 15, code: 0, rainChance: 0 },
  ],
}
const t0 = Date.parse('2026-11-27T14:30:00Z')
const stock = {
  symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD', price: 248.31, change: 3.12, changePct: 1.27, range: '1D', marketState: 'REGULAR', source: 'Yahoo Finance',
  points: Array.from({ length: 70 }, (_, i) => ({ t: t0 + i * 300000, v: 245.2 + Math.sin(i / 7) * 1.4 + i * 0.045 + Math.cos(i / 2.3) * 0.35 })),
}
const nowPlaying = { state: 'playing', title: 'Midnight City', artist: 'M83', album: "Hurry Up, We're Dreaming", durationSec: 243, positionSec: 87 }
const delegation = {
  jobId: 'job1', agent: 'Claude', status: 'done',
  prompt: 'On bloom-tracking.com, make the hero headline shorter and change the main button to say "Start free". Open a pull request when done.',
  summary: 'Claude shortened the headline and opened a pull request.',
  reply: 'I updated `src/pages/Home.tsx`:\n\n- Headline is now **Know your cycle.**\n- The button says **Start free**\n\nPull request #142 is open for review.',
}

const baseState = { phase: 'idle', expanded: false, transcript: '', reply: '', activity: [], panel: null, jobs: [], confirm: null, error: null, notice: null, helperReady: true, hasApiKey: true, usageTodayUsd: 0.0132 }

const scenes = [
  { name: '01-pill', h: 120, state: {} },
  { name: '02-pill-handoff', h: 120, state: { jobs: [{ ...delegation, status: 'waiting' }] } },
  { name: '03-listening', h: 160, level: 0.6, state: { phase: 'listening', transcript: "What's the weather like in Lisbon this weekend?" } },
  { name: '04-thinking', h: 160, state: { phase: 'thinking', transcript: "What's the weather like in Lisbon this weekend?", activity: [{ id: 'a1', text: 'Checking the weather in Lisbon', status: 'running' }] } },
  { name: '05-weather', h: 780, state: { phase: 'speaking', transcript: "What's the weather like in Lisbon this weekend?", reply: "It's 21 and mostly sunny in Lisbon now, but bring an umbrella: rain moves in Saturday and Sunday.", activity: [{ id: 'a1', text: 'Checking the weather in Lisbon', status: 'done' }], panel: { blocks: [{ type: 'weather', data: weather }] } } },
  { name: '06-stock', h: 560, state: { transcript: 'How is Apple stock doing today?', reply: 'Apple is up 1.3% today at $248.31.', activity: [{ id: 'a1', text: 'Looking up AAPL', status: 'done' }], panel: { title: 'Apple', blocks: [{ type: 'stock', data: stock }] } } },
  { name: '07-spotify-and-claude', h: 640, state: { transcript: 'Play Midnight City', reply: 'Playing Midnight City by M83.', panel: { title: 'From Claude', blocks: [{ type: 'nowPlaying', data: nowPlaying }, { type: 'delegation', data: delegation }] } } },
  { name: '08-confirm', h: 480, state: { transcript: 'Ask Claude to email Sarah that the launch moved to Friday', reply: "I'll hand this to Claude once you confirm.", confirm: { id: 'c1', title: 'Send this to Claude?', body: 'Draft and send an email to Sarah saying the launch has moved to Friday, December 4. Keep it short and friendly.', actionLabel: 'Send' }, jobs: [{ ...delegation, status: 'confirming', prompt: 'Draft and send an email to Sarah…' }] } },
  { name: '09-dashboard', h: 700, state: { transcript: 'Compare my three plans', reply: 'Here’s how the three plans compare.', panel: { title: 'Plan comparison', subtitle: 'Monthly cost and usage', blocks: [
    { type: 'stats', items: [{ label: 'Spend this month', value: '$4.12', delta: '18% vs last month', trend: 'down' }, { label: 'Questions', value: '1,284', delta: '240 this week', trend: 'up' }, { label: 'Hand-offs', value: '37', trend: 'flat', delta: 'steady' }] },
    { type: 'chart', kind: 'bar', yLabel: 'Questions per day', series: [{ name: 'Questions', points: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x, i) => ({ x, y: [42, 58, 51, 77, 64, 30, 22][i] })) }] },
    { type: 'table', columns: ['Plan', 'Price', 'Models', 'Best for'], rows: [['API only', '$1–3/mo', 'Haiku + Sonnet', 'Quick questions'], ['Claude Pro', '$20/mo', 'All', 'Hand-offs, coding'], ['Max', '$100/mo', 'All', 'Heavy agent work']] },
  ] } } },
  { name: '10-error', h: 260, state: { transcript: 'What time is it in Tokyo?', error: 'The Anthropic API key was rejected. Check it in Settings.' } },
]

const wallpaper = 'radial-gradient(1200px 700px at 20% 10%, #6b5bd6 0%, transparent 60%), radial-gradient(1000px 800px at 90% 30%, #e0607e 0%, transparent 55%), linear-gradient(160deg, #1f3b73 0%, #3b2a66 45%, #b4577a 100%)'

const browser = await chromium.launch()
for (const scene of scenes) {
  const page = await browser.newPage({ viewport: { width: 760, height: scene.h }, deviceScaleFactor: 2 })
  const state = { ...baseState, ...scene.state }
  await page.addInitScript(({ state, level }) => {
    const noop = () => {}
    window.watson = {
      onState: (cb) => { setTimeout(() => cb(state), 0); return noop },
      onLevel: (cb) => { if (level) { const t = setInterval(() => cb(level * (0.6 + Math.random() * 0.6)), 50); return () => clearInterval(t) } return noop },
      setInteractive: noop, focus: noop, toggleListen: noop, ask: noop, cancel: noop, dismiss: noop, answerConfirm: noop, stockRange: noop, spotify: noop,
      openSettings: noop, openExternal: noop, testVoice: noop, openPrivacyPane: noop,
    }
  }, { state, level: scene.level ?? 0 })
  await page.goto(`${base}/index.html`)
  await page.addStyleTag({ content: `html[data-view='overlay'] body { background: ${wallpaper} !important; }` })
  await page.waitForTimeout(900)
  await page.screenshot({ path: path.join(outDir, `${scene.name}.png`) })
  await page.close()
}

// Settings, light and dark
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 620, height: 1500 }, deviceScaleFactor: 2, colorScheme: scheme })
  await page.addInitScript(() => {
    const noop = () => {}
    const settings = { hotkey: 'Alt+Space', homeCity: 'Lisbon', units: 'C', speechLocale: 'en-US', voiceId: '', speechRate: 0.52, echoCancellation: true, followUpSeconds: 6, smartRouting: true, webSearch: true, dailyBudgetUsd: 0.5, confirmHandoffs: false, returnFocusAfterHandoff: true, defaultAgent: 'claude', agents: [{ id: 'claude', name: 'Claude', bundleId: 'com.anthropic.claudefordesktop', enabled: true }, { id: 'chatgpt', name: 'ChatGPT', bundleId: 'com.openai.chat', enabled: false }] }
    window.watson = {
      onState: () => noop, onLevel: () => noop,
      getSettings: async () => settings, setSettings: async (p) => Object.assign(settings, p),
      secretStatus: async () => ({ anthropic: true, xai: false, spotifyClientId: false, spotifyClientSecret: false }),
      setSecret: async () => ({ anthropic: true, xai: false, spotifyClientId: false, spotifyClientSecret: false }),
      voices: async () => [{ id: 'ava', name: 'Ava', language: 'en-US', quality: 'premium' }, { id: 'zoe', name: 'Zoe', language: 'en-US', quality: 'enhanced' }],
      runningApps: async () => [{ name: 'Claude', bundleId: 'com.anthropic.claudefordesktop' }, { name: 'Safari', bundleId: 'com.apple.Safari' }],
      permissions: async () => ({ microphone: 'granted', speech: 'granted', accessibility: false }),
      requestPermissions: async () => null, openPrivacyPane: noop, openExternal: noop, testVoice: noop,
    }
  })
  await page.goto(`${base}/index.html#settings`)
  await page.waitForTimeout(700)
  await page.screenshot({ path: path.join(outDir, `11-settings-${scheme}.png`), fullPage: true })
  await page.close()
}

await browser.close()
server.close()
console.log(`Saved screenshots to ${outDir}`)
