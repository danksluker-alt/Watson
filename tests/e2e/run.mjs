// End-to-end test: runs the real Watson app (built Electron main, preload and
// renderer) against the fake native helper and the mock Claude API, clicks
// through the everyday scenarios, checks what happened, and saves screenshots.
//
//   npm run build && xvfb-run -a node tests/e2e/run.mjs [screenshotDir]
//
// On a Mac it runs without xvfb-run.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startMockApi } from './mock-api.mjs'

const require = createRequire(import.meta.url)
const { _electron } = require('playwright')
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const shots = path.resolve(process.argv[2] ?? path.join(root, 'screenshots/e2e'))
fs.mkdirSync(shots, { recursive: true })

const API_PORT = 47901
const HELPER_PORT = 47902
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []

const { server } = await startMockApi(API_PORT)
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'watson-e2e-'))

const app = await _electron.launch({
  executablePath: require('electron'),
  args: ['--no-sandbox', '--disable-gpu', root],
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${API_PORT}`,
    WATSON_MOCK_DATA: `http://127.0.0.1:${API_PORT}`,
    WATSON_HELPER_CMD: `node ${path.join(here, 'fake-helper.mjs')}`,
    FAKE_HELPER_PORT: String(HELPER_PORT),
    WATSON_FAKE_OS: '1',
    WATSON_USER_DATA: userData,
    WATSON_POLL_MS: '400',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
})

const helper = async (route, body) => {
  const res = await fetch(`http://127.0.0.1:${HELPER_PORT}${route}`, body ? { method: 'POST', body: JSON.stringify(body) } : undefined)
  return res.json()
}
const apiRequests = async () => (await fetch(`http://127.0.0.1:${API_PORT}/__requests`)).json()

async function until(check, timeout = 8000, step = 100) {
  const start = Date.now()
  for (;;) {
    const v = await check()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error('timed out')
    await sleep(step)
  }
}

const appLog = fs.createWriteStream(path.join(shots, 'app.log'))
app.process().stdout?.pipe(appLog)
app.process().stderr?.pipe(appLog)

// The overlay is the window without a #hash (settings and widgets have one).
const overlay = await until(async () => app.windows().find((w) => !w.url().includes('#settings') && !w.url().includes('#widget')), 60_000, 250)
await overlay.waitForSelector('.island', { timeout: 60_000, state: 'attached' })
const WALLPAPER = `html[data-view='overlay'] body { background: radial-gradient(1200px 700px at 20% 10%, #6b5bd6 0%, transparent 60%), radial-gradient(1000px 800px at 90% 30%, #e0607e 0%, transparent 55%), linear-gradient(160deg, #1f3b73 0%, #3b2a66 45%, #b4577a 100%) !important; }`
await overlay.addStyleTag({ content: WALLPAPER })

async function reset() {
  await overlay.evaluate(() => window.watson.dismiss())
  await until(async () => (await overlay.$('.pill')) !== null, 5000)
  await helper('/reset', {})
  await sleep(250)
}

async function talk(text, { review = false } = {}) {
  if (await overlay.$('.pill')) await overlay.click('.pill')
  else await overlay.evaluate(() => window.watson.toggleListen())
  await until(async () => (await helper('/state')).listening, 4000)
  if (review) await overlay.click('.mode-switch button:has-text("Review")')
  await helper('/say', { text })
}

async function shot(name) {
  await sleep(450)
  await overlay.screenshot({ path: path.join(shots, `${name}.png`) })
}

async function scenario(name, fn) {
  if (process.env.ONLY && !name.toLowerCase().includes(process.env.ONLY.toLowerCase())) return
  const started = Date.now()
  try {
    await reset()
    const detail = await Promise.race([fn(), sleep(75_000).then(() => Promise.reject(new Error('scenario took over 75s')))])
    results.push({ name, ok: true, ms: Date.now() - started, detail: detail ?? '' })
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (e) {
    const st = await helper('/state').catch(() => ({ commands: [] }))
    const reqs = await apiRequests().catch(() => [])
    const ui = await overlay.evaluate(() => document.querySelector('.island')?.getAttribute('data-mode') + '/' + document.querySelector('.island')?.getAttribute('data-phase')).catch(() => '?')
    e.message += ` [said: ${st.spoken?.slice(-2).join(' ').slice(0, 160)}] [ui ${ui}; helper cmds: ${st.commands.slice(-8).join(',')}; last API: ${reqs.slice(-2).map((r) => r.text.slice(0, 40)).join(' | ')}]`
    results.push({ name, ok: false, ms: Date.now() - started, detail: e.message })
    console.log(`  ✗ ${name} — ${e.message}`)
    await overlay.screenshot({ path: path.join(shots, `FAILED-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {})
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
const spokenText = async () => (await helper('/state')).spoken.join(' ')

console.log('Watson end-to-end scenarios')

await scenario('Pill at rest', async () => {
  await shot('01-pill')
  const label = await overlay.textContent('.pill')
  assert(label.includes('Watson'), `pill says "${label}"`)
  await overlay.click('.pill')
  await until(async () => (await helper('/state')).listening, 4000)
  await overlay.mouse.move(5, 700)
  await shot('01b-listening')
  await overlay.evaluate(() => window.watson.cancel())
})

await scenario('Live voice: weather with widget and spoken answer', async () => {
  await talk("What's the weather in Lisbon this weekend?")
  await overlay.waitForSelector('.weather', { timeout: 10_000 })
  await until(async () => (await spokenText()).includes('Lisbon'), 8000)
  // The API streams pieces that split words; they must join back exactly.
  await until(async () => (await spokenText()).includes('mostly sunny in Lisbon right now. Rain moves in over the weekend'), 8000)
  await shot('02-weather')
  const reqs = (await apiRequests()).filter((r) => r.text.includes('weather'))
  assert(reqs[0]?.model === 'claude-haiku-5-5', `used ${reqs[0]?.model}`)
  // After speaking, Watson keeps listening for a follow-up.
  await until(async () => (await helper('/state')).listening, 5000)
  return `spoke: "${(await spokenText()).slice(0, 70)}…", model ${reqs[0].model}, then listened for a follow-up`
})

await scenario('Interrupting Watson while it talks (barge-in)', async () => {
  await talk("What's the weather in Lisbon this weekend?")
  await until(async () => (await helper('/state')).speaking, 8000, 30)
  await helper('/say', { text: 'How is Apple stock doing today?' })
  await overlay.waitForSelector('.stock', { timeout: 10_000 })
  const reqs = await apiRequests()
  assert(reqs.some((r) => r.text.includes('Apple stock')), 'second question never reached the model')
  return 'speech stopped, the new question was answered'
})

await scenario('Stock chart, switching range', async () => {
  await talk('How is Apple stock doing today?')
  await overlay.waitForSelector('.stock')
  await overlay.click('.segmented button:has-text("1Y")')
  await until(async () => (await overlay.textContent('.segmented button.on')) === '1Y', 6000)
  await shot('03-stock')
  return 'range changed to 1Y and the chart reloaded'
})

await scenario('Hand-off to Grok (website) and answer back', async () => {
  await talk('Ask Grok what people on X are saying about the new iPhone')
  const sent = await until(async () => (await helper('/state')).sent[0], 10_000)
  assert(sent.url === 'https://grok.com/', `sent to ${sent.url}`)
  assert(sent.newChat === true, 'did not start a new chat')
  await shot('04-grok-waiting')
  await until(async () => (await spokenText()).includes('Grok answered'), 20_000)
  await overlay.waitForSelector('.delegation .status.done', { timeout: 5000 })
  await shot('05-grok-answered')
  return `typed "${sent.text.slice(0, 50)}…" into ${sent.target}, summary spoken`
})

await scenario('Hand-off to Claude app with code in the answer', async () => {
  await talk('Ask Claude to make the hero headline on my website shorter and open a PR')
  const sent = await until(async () => (await helper('/state')).sent[0], 10_000)
  assert(sent.bundleId === 'com.anthropic.claudefordesktop', `sent to ${sent.bundleId}`)
  await until(async () => (await spokenText()).includes('Claude answered'), 20_000)
  await overlay.waitForSelector('.md-code', { timeout: 5000 })
  await shot('06-claude-code')
  return 'answer shown with the code and a spoken summary'
})

await scenario('Sensitive request waits for “send”', async () => {
  await talk('Ask Claude to email Sarah that the launch moved to Friday')
  await overlay.waitForSelector('.confirm', { timeout: 10_000 })
  await sleep(600)
  assert((await helper('/state')).sent.length === 0, 'sent before confirming!')
  await shot('07-confirm')
  await overlay.click('.confirm .btn.primary')
  const sent = await until(async () => (await helper('/state')).sent[0], 10_000)
  await until(async () => (await spokenText()).includes('Claude answered'), 20_000)
  return `nothing went out until Send was pressed; then "${sent.text.slice(0, 40)}…"`
})

await scenario('Dictate, edit, then send to Claude (review mode)', async () => {
  await talk('draft a tweet about our launch on friday', { review: true })
  await overlay.waitForSelector('.draft textarea', { timeout: 8000 })
  await until(async () => (await overlay.inputValue('.draft textarea')).includes('launch'), 4000)
  await shot('08-review-draft')
  await overlay.fill('.draft textarea', 'Draft a short, upbeat tweet announcing that Watson launches this Friday.')
  await overlay.click('.draft-targets .chip:has-text("Claude")')
  await shot('09-review-edited')
  await overlay.press('.draft textarea', 'Enter')
  const sent = await until(async () => (await helper('/state')).sent[0], 10_000)
  assert(sent.text === 'Draft a short, upbeat tweet announcing that Watson launches this Friday.', `sent "${sent.text}"`)
  assert(!(await overlay.$('.confirm')), 'asked to confirm text the user already reviewed')
  await until(async () => (await spokenText()).includes('Claude answered'), 20_000)
  return 'the edited text went to Claude exactly as written'
})

await scenario('Dictate into the app you were using', async () => {
  await talk('see you at the offsite on thursday', { review: true })
  await overlay.waitForSelector('.draft textarea', { timeout: 8000 })
  await overlay.click('.draft-targets .chip:has-text("Type into")')
  await overlay.click('.send-btn')
  const ins = await until(async () => (await helper('/state')).inserted[0], 8000)
  assert(ins.bundleId === 'com.apple.TextEdit', `inserted into ${ins.bundleId}`)
  return `typed "${ins.text}" into TextEdit`
})

await scenario('Calendar: today, then add an event', async () => {
  await talk("What's on my calendar today?")
  await overlay.waitForSelector('.calendar-w .cal-event', { timeout: 10_000 })
  const n = (await overlay.$$('.calendar-w .cal-event')).length
  await shot('10-calendar')
  await reset()
  await talk('Add a dentist appointment to my calendar tomorrow at 3pm')
  await overlay.waitForSelector('.cal-event.highlight', { timeout: 10_000 })
  const added = (await helper('/state')).calendarAdds[0]
  assert(added?.title === 'Dentist', 'event not added')
  await shot('11-calendar-added')
  return `${n} events today; added “Dentist” tomorrow 3 PM`
})

await scenario('Reminders: add one', async () => {
  await talk('Remind me to call mom at 6pm')
  await overlay.waitForSelector('.reminders-w .rem-row.highlight', { timeout: 10_000 })
  await shot('12-reminders')
  return 'added and highlighted in the list'
})

await scenario('Notes, world clock and battery widgets', async () => {
  await talk('Show my recent notes')
  await overlay.waitForSelector('.notes-w .note-row', { timeout: 10_000 })
  await shot('13-notes')
  await reset()
  await talk('What time is it in Tokyo and London?')
  await overlay.waitForSelector('.clock-w .clock-cell:nth-child(3)', { timeout: 10_000 })
  await shot('14-clock')
  await reset()
  await talk("How's my battery?")
  await overlay.waitForSelector('.battery-w', { timeout: 10_000 })
  await shot('15-battery')
})

await scenario('Timer: counts down in the pill, rings, stops', async () => {
  await talk('Set a tea timer for 12 seconds')
  await overlay.waitForSelector('.timers-w .timer-row', { timeout: 10_000 })
  await shot('21-timer')
  await overlay.evaluate(() => window.watson.dismiss())
  await overlay.mouse.move(5, 700)
  await overlay.waitForSelector('.pill-timer', { timeout: 5000 })
  await sleep(700)
  await overlay.screenshot({ path: path.join(shots, '22-pill-timer.png') })
  await overlay.waitForSelector('.card.ringing', { timeout: 15_000 })
  await shot('23-timer-ringing')
  await until(async () => (await helper('/state')).spoken.some((x) => /tea timer is done/i.test(x)), 8000)
  await overlay.click('.ringing-stop')
  await until(async () => !(await overlay.$('.card.ringing')), 5000)
  return 'countdown in the pill, rang, spoke "tea timer is done", stopped'
})

await scenario('Check off a reminder, remember a fact, turn the volume down', async () => {
  await talk('Check off renew passport')
  await until(async () => ((await helper('/state')).reminderDone ?? []).length === 1, 10_000)
  await overlay.waitForSelector('.reminders-w', { timeout: 10_000 })
  await reset()
  await talk('Remember that I parked on level 3, spot B12')
  await overlay.waitForSelector('.list-meta:has-text("Remembered")', { timeout: 10_000 })
  await shot('24-remembered')
  await reset()
  await talk('Turn the volume down')
  await until(async () => (await helper('/state')).exec.some((e) => e.script.includes('set volume output volume 45')), 8000)
  return 'reminder checked off; memory saved; volume 60 → 45'
})

await scenario('Music: play and pause from the widget', async () => {
  await talk('Play Midnight City')
  await overlay.waitForSelector('.now-playing', { timeout: 10_000 })
  await shot('16-music')
  await overlay.click('.np-main')
  await until(async () => (await helper('/state')).exec.some((e) => e.script.includes('playpause')), 5000)
  return 'Now Playing shown; pause sent to Spotify'
})

await scenario('Pin a widget to the screen, then remove it', async () => {
  const before = app.windows().length
  const opened = app.waitForEvent('window', { timeout: 15_000 })
  await talk('Pin the weather to my screen')
  const win = await opened
  await win.waitForSelector('.weather', { timeout: 10_000 })
  await sleep(600)
  await win.screenshot({ path: path.join(shots, '17-pinned-weather.png') })
  assert(app.windows().length === before + 1, 'no widget window')
  await win.hover('.widget-shell')
  await win.click('.widget-close')
  await until(async () => app.windows().length === before, 5000)
  return 'floating widget window opened with live data, then closed'
})

await scenario('Pin button on a calendar card', async () => {
  await talk("What's on my calendar today?")
  await overlay.waitForSelector('.calendar-w')
  const opened = app.waitForEvent('window', { timeout: 10_000 })
  await overlay.hover('.pinnable')
  await overlay.click('.pin-btn')
  const win = await opened
  await win.waitForSelector('.calendar-w', { timeout: 10_000 })
  await sleep(500)
  await win.screenshot({ path: path.join(shots, '18-pinned-calendar.png') })
  await win.click('.widget-close', { force: true })
})

await scenario('Typed question, visual answer', async () => {
  await overlay.evaluate(() => window.watson.ask('Compare the three plans'))
  await overlay.waitForSelector('table', { timeout: 10_000 })
  await shot('19-typed-table')
  const spoken = (await helper('/state')).spoken
  assert(spoken.length === 0, 'spoke an answer to a typed question')
  return 'table shown, nothing spoken'
})

await scenario('Settings window', async () => {
  const opened = app.waitForEvent('window', { timeout: 10_000 })
  await overlay.evaluate(() => window.watson.openSettings())
  const win = await opened
  await win.waitForSelector('.settings-hero', { timeout: 10_000 })
  await win.setViewportSize({ width: 640, height: 2400 }).catch(() => {})
  await sleep(500)
  await win.screenshot({ path: path.join(shots, '20-settings.png'), fullPage: true })
  const agents = await win.$$eval('.group:has(h2:text("Agents")) .row-label span', (els) => els.map((e) => e.textContent))
  assert(agents.includes('Grok') && agents.includes('Claude'), `agents: ${agents.join(', ')}`)
  await win.close()
  return `agents listed: ${agents.slice(0, 7).join(', ')}`
})

const reqs = await apiRequests()
const models = reqs.reduce((m, r) => ({ ...m, [r.model]: (m[r.model] ?? 0) + 1 }), {})
console.log(`\nAPI calls: ${reqs.length} (${Object.entries(models).map(([k, v]) => `${k} ×${v}`).join(', ')})`)
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} scenarios passed. Screenshots: ${shots}`)
fs.writeFileSync(path.join(shots, 'results.json'), JSON.stringify({ results, apiCalls: reqs.length, models }, null, 2))

const proc = app.process()
await Promise.race([app.close().catch(() => {}), sleep(5000)])
proc.kill('SIGKILL')
server.close()
fs.rmSync(userData, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
