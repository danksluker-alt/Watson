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
    WATSON_INVISIBLE: '1',
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
  await overlay.evaluate(() => {
    window.watson.cancelDraft()
    window.watson.dismiss()
  })
  await until(async () => (await overlay.$('.pill')) !== null, 5000)
  await helper('/reset', {})
  await sleep(250)
}

async function talk(text, { review = false } = {}) {
  if (await overlay.$('.pill')) await overlay.click('.pill')
  else await overlay.evaluate(() => window.watson.toggleListen())
  await until(async () => (await helper('/state')).listening, 4000)
  if (review) await overlay.evaluate(() => window.watson.setCapture('review'))
  await helper('/say', { text })
}

async function shot(name) {
  await sleep(450)
  await overlay.screenshot({ path: path.join(shots, `${name}.png`) })
}

async function scenario(name, fn) {
  if (process.env.ONLY && !process.env.ONLY.toLowerCase().split('|').some((o) => name.toLowerCase().includes(o))) return
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
// Most scenarios talk live; the dictation scenarios switch to the default (dictate, then send).
await overlay.evaluate(() => window.watson.setSettings({ inputMode: 'live' }))
const setMode = (m) => overlay.evaluate((mode) => window.watson.setSettings({ inputMode: mode }), m)

await scenario('Pill at rest', async () => {
  await overlay.mouse.move(5, 700)
  await shot('01-pill')
  // At rest it's a small circle: nothing to report.
  const w = await overlay.evaluate(() => document.querySelector('.island').getBoundingClientRect().width)
  assert(w <= 40, `resting pill is ${w}px wide, expected the circle`)
  await overlay.click('.pill')
  await until(async () => (await helper('/state')).listening, 4000)
  await overlay.mouse.move(5, 700)
  await shot('01b-listening')
  await overlay.evaluate(() => window.watson.cancel())
})

await scenario('Click opens dictation: nothing is sent until Send', async () => {
  await setMode('review')
  try {
    await overlay.mouse.move(5, 700)
    await overlay.click('.pill')
    await until(async () => (await helper('/state')).listening, 4000)
    await helper('/say', { text: "What's the weather in Lisbon this weekend?" })
    await overlay.waitForSelector('.draft textarea', { timeout: 8000 })
    await until(async () => (await overlay.inputValue('.draft textarea')).includes('Lisbon'), 4000)
    await sleep(1200)
    assert(!(await apiRequests()).some((r) => r.text.includes('Lisbon')), 'sent before pressing Send')
    assert(!(await helper('/state')).listening, 'still listening after the words were in')
    assert((await overlay.textContent('.dest-opt.current')).includes('Auto'), 'Auto should be the default target')
    // Clean: the choices are one level down, not on the first view.
    assert(!(await overlay.$('.dest.open')), 'AI choices shown before asking for them')
    await shot('01c-dictation')
    await overlay.click('.send-btn')
    await overlay.waitForSelector('.weather', { timeout: 10_000 })
    await until(async () => (await spokenText()).includes('Lisbon'), 10_000)
    await until(async () => !(await helper('/state')).speaking, 15_000)
    await sleep(800)
    // A dictated request gets its answer, and then the mic stays off.
    assert(!(await helper('/state')).listening, 'listened to the room after a dictated request')
    return 'words shown to edit, nothing sent until Send; answered; no follow-up listening'
  } finally {
    await setMode('live')
  }
})

await scenario('While talking only your words show; click them to type', async () => {
  await setMode('review')
  try {
    await overlay.click('.pill')
    await until(async () => (await helper('/state')).listening, 4000)
    await helper('/partial', { text: 'Write a long note to the team about the' })
    await overlay.waitForSelector('.dictation', { timeout: 5000 })
    assert(!(await overlay.$('.send-btn')), 'Send shown while still talking')
    assert(!(await overlay.$('.chip')), 'choices shown while still talking')
    await shot('01d-dictating')
    await overlay.click('.dictation-text')
    await overlay.waitForSelector('.draft textarea', { timeout: 5000 })
    await until(async () => !(await helper('/state')).listening, 4000)
    assert((await overlay.inputValue('.draft textarea')).includes('note to the team'), 'words heard so far were lost')
    assert(await overlay.$('.send-btn'), 'no Send button after taking over')
    return 'clean while talking; a click stopped the mic and kept the words for typing'
  } finally {
    await setMode('live')
  }
})

await scenario('An unsent message is kept when you click away', async () => {
  await setMode('review')
  try {
    await talk('remind the team about the offsite agenda', { review: true })
    await overlay.waitForSelector('.draft textarea', { timeout: 8000 })
    await overlay.fill('.draft textarea', 'A long prompt I spent a while writing about the offsite agenda')
    await sleep(600) // edits are saved as you type
    // Esc (or clicking away) puts it in the pill instead of throwing it away.
    await overlay.keyboard.press('Escape')
    await overlay.waitForSelector('.pill-label.unsent', { timeout: 5000 })
    await shot('01e-draft-kept')
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'draft.json'), 'utf8'))
    assert(saved.text.includes('spent a while'), 'draft not saved to disk')
    assert(!(await apiRequests()).some((r) => r.text.includes('offsite')), 'sent without Send')
    await overlay.click('.pill')
    await overlay.waitForSelector('.draft textarea', { timeout: 5000 })
    assert((await overlay.inputValue('.draft textarea')).includes('spent a while'), 'the edited text came back different')
    assert(!(await helper('/state')).listening, 'reopening a draft turned the mic on')
    await overlay.click('.tool[aria-label="Discard"]')
    await until(async () => !fs.existsSync(path.join(userData, 'draft.json')), 4000)
    return 'Esc kept it in the pill, a click brought it back, Discard removed it'
  } finally {
    await setMode('live')
  }
})

await scenario('Mute Watson: answers show instead of being spoken', async () => {
  await overlay.evaluate(() => window.watson.setMuted(true))
  try {
    await talk('How tall is the Eiffel Tower?')
    await overlay.waitForSelector('.reply', { timeout: 10_000 })
    await until(async () => (await overlay.textContent('.reply')).includes('330'), 10_000)
    await sleep(800)
    assert(!(await spokenText()).includes('330'), 'spoke while muted')
    assert(await overlay.$('.icon-btn.muted'), 'no muted button showing')
    await shot('01f-muted')
    return 'the answer was on screen and nothing was spoken'
  } finally {
    await overlay.evaluate(() => window.watson.setMuted(false))
  }
})

await scenario('Switch from dictating to live talk while speaking', async () => {
  await setMode('review')
  try {
    await overlay.click('.pill')
    await until(async () => (await helper('/state')).listening, 4000)
    await helper('/partial', { text: 'How tall is' })
    await overlay.waitForSelector('.dictation .live-switch', { timeout: 5000 })
    assert((await overlay.getAttribute('.island', 'data-capture')) === 'review', 'not dictating at first')
    await overlay.click('.live-switch')
    await until(async () => (await overlay.getAttribute('.island', 'data-capture')) === 'live', 3000)
    await overlay.waitForSelector('.live-switch.on', { timeout: 3000 })
    await shot('01g-live-glow')
    await helper('/say', { text: 'How tall is the Eiffel Tower?' })
    await until(async () => (await spokenText()).includes('330 meters'), 10_000)
    assert(!(await overlay.$('.send-btn')), 'asked to press Send in live talk')
    return 'one click turned dictation into live talk: answered out loud with no Send step'
  } finally {
    await overlay.evaluate(() => window.watson.cancel())
    await setMode('live')
  }
})

await scenario('Hovering the pill shows the dashboard and live talk', async () => {
  // Start away from it, so moving onto it counts as arriving.
  await overlay.mouse.move(5, 700)
  await until(async () => (await overlay.$('.pill')) !== null, 4000)
  // Wait until the island has finished closing into the circle before aiming at it.
  await until(async () => (await overlay.evaluate(() => document.querySelector('.island').getBoundingClientRect().width)) <= 40, 4000)
  await sleep(300)
  const box = await overlay.$eval('.island', (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await overlay.mouse.move(box.x - 4, box.y, { steps: 3 })
  await overlay.mouse.move(box.x, box.y, { steps: 3 })
  // If the arrival was missed (the window was still settling), a small second move counts.
  const shown = await overlay.waitForSelector('.pill-quick.live', { timeout: 2000 }).catch(() => null)
  if (!shown) {
    await overlay.mouse.move(box.x + 3, box.y, { steps: 2 })
    await overlay.waitForSelector('.pill-quick.live', { timeout: 3000 })
  }
  await shot('01h-pill-hover')
  await overlay.click('.pill-quick.live')
  await until(async () => (await helper('/state')).listening, 4000)
  assert((await overlay.getAttribute('.island', 'data-capture')) === 'live', 'the live button did not start live talk')
  await overlay.evaluate(() => window.watson.cancel())
  await overlay.mouse.move(5, 700)
  return 'two small buttons appeared on hover; the live one started a live conversation'
})

await scenario('Talk live from the dictation box', async () => {
  await setMode('review')
  try {
    await overlay.click('.pill')
    await until(async () => (await helper('/state')).listening, 4000)
    await helper('/say', { text: 'How tall is the Eiffel Tower?' })
    await overlay.waitForSelector('.draft textarea', { timeout: 8000 })
    await overlay.click('.tool.live')
    await until(async () => (await spokenText()).includes('330 meters'), 10_000)
    // Live: it keeps listening for a follow-up.
    await until(async () => (await helper('/state')).listening, 10_000)
    return 'the dictated words were answered out loud, then Watson listened for a follow-up'
  } finally {
    await overlay.evaluate(() => window.watson.cancel())
    await setMode('live')
  }
})

await scenario('“Hey Watson” starts a live conversation', async () => {
  await overlay.evaluate(() => window.watson.setSettings({ wakeWord: true }))
  try {
    await until(async () => (await helper('/state')).waking, 6000)
    const r = await helper('/wake', {})
    assert(r.ok, 'wake phrase not accepted')
    await until(async () => (await helper('/state')).listening, 4000)
    await helper('/say', { text: 'How tall is the Eiffel Tower?' })
    await until(async () => (await spokenText()).includes('330 meters'), 10_000)
    return 'waited for the wake phrase while idle, then listened and answered live'
  } finally {
    await overlay.evaluate(() => window.watson.cancel())
    await overlay.evaluate(() => window.watson.setSettings({ wakeWord: false }))
    await until(async () => !(await helper('/state')).waking, 6000)
  }
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

await scenario('An AI asks a question: tap options, they go back to it', async () => {
  await talk('Ask Claude to create a new marketing agent for my apps')
  await until(async () => (await spokenText()).includes('Claude answered'), 20_000)
  await overlay.waitForSelector('.choices .choice', { timeout: 5000 })
  await overlay.click('.choice:has-text("Claude Code subagent")')
  await overlay.click('.choice:has-text("Scheduled marketing task")')
  await shot('31-choices')
  await overlay.click('.choices-send .btn.primary')
  const sent = await until(async () => (await helper('/state')).sent[1], 10_000)
  assert(sent.text === 'I choose these: 2. Claude Code subagent; 4. Scheduled marketing task.', `sent "${sent.text}"`)
  assert(sent.newChat === false, 'the answer should go to the same conversation')
  await until(async () => (await spokenText()).match(/Claude answered/g)?.length === 2, 20_000)
  return 'two options tapped and sent to the same Claude chat; its next answer came back'
})

await scenario('Dashboard in front: the panel folds into the pill', async () => {
  await talk('Compare the three plans')
  await overlay.waitForSelector('table', { timeout: 10_000 })
  await overlay.evaluate(() => window.watson.openWindow())
  await until(async () => (await overlay.evaluate(() => document.querySelector('.island')?.getAttribute('data-mode'))) === 'pill', 5000)
  const win = await until(async () => app.windows().find((w) => w.url().includes('#home')), 10_000)
  await win.close()
  await until(async () => !(await overlay.evaluate(() => window.watson.getState())).tucked, 5000)
  return 'opening the dashboard folded the panel away; closing it brought Watson back'
})

await scenario('Two requests that need an OK are asked one after the other', async () => {
  await talk('Email both Sarah and Sam that the launch moved')
  await overlay.waitForSelector('.confirm', { timeout: 10_000 })
  const first = await overlay.textContent('.confirm')
  await overlay.click('.confirm .btn.primary')
  await until(async () => (await overlay.$('.confirm')) && (await overlay.textContent('.confirm')) !== first, 5000)
  await overlay.click('.confirm .btn.primary')
  const sent = await until(async () => {
    const s = (await helper('/state')).sent
    return s.length === 2 ? s : null
  }, 15_000)
  assert(sent.some((x) => x.text.includes('Sarah')) && sent.some((x) => x.text.includes('Sam')), 'both should go out after their OK')
  await until(async () => (await spokenText()).match(/Claude answered/g)?.length === 2, 25_000)
  return 'the second confirmation appeared after the first was answered; both went out'
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
  await overlay.click('.dest-opt.current')
  await shot('09a-review-more')
  await overlay.click('.dest-opt:has-text("Claude")')
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
  await overlay.click('.dest-opt.current')
  await overlay.click('.dest-opt:has-text("TextEdit")')
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
  // The circle grows into a pill with the countdown.
  // (It may take turns with other live things, like a test event about to start.)
  await until(async () => (await overlay.$$eval('.pill-label.live.timer', (els) => els.map((e) => e.textContent))).some((t) => /tea · 0:\d\d/i.test(t)), 9000)
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

await scenario('Pill: corner position and circle shape stay on screen', async () => {
  const W = 760
  // Put the pill in the bottom-right corner of the screen, as dragging it there would.
  await overlay.evaluate(async () => {
    const s = await window.watson.getSettings()
    void s
    await window.watson.setSettings({ pillPlace: { displayId: -1, fx: 0.97, fy: 0.95 } })
  })
  // displayId -1 doesn't exist, so it falls back to the default spot; use the real primary display.
  const displayId = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().id)
  await overlay.evaluate((id) => window.watson.setSettings({ pillPlace: { displayId: id, fx: 0.97, fy: 0.95 } }), displayId)
  await until(async () => (await overlay.evaluate(() => window.watson.getState())).layout.dir === 'up', 5000)
  const st = await overlay.evaluate(() => window.watson.getState())
  assert(st.layout.centerX > W / 2, `pill should sit right of centre, centerX=${st.layout.centerX}`)
  // Open the panel: it must open upward and stay inside the window.
  await talk('Compare the three plans')
  await overlay.waitForSelector('table', { timeout: 10_000 })
  await sleep(600)
  const box = await overlay.evaluate(() => {
    const r = document.querySelector('.island').getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: innerWidth, vh: innerHeight }
  })
  assert(box.left >= 0 && box.right <= box.vw && box.top >= 0 && box.bottom <= box.vh, `panel cut off: ${JSON.stringify(box)}`)
  assert(box.bottom > box.vh - 12, `panel should open upward from the bottom: ${JSON.stringify(box)}`)
  await shot('25-corner-panel')
  await reset()
  await overlay.mouse.move(5, 5)
  await until(async () => (await overlay.evaluate(() => document.querySelector('.island')?.getBoundingClientRect().width)) <= 40, 5000)
  await sleep(500)
  await overlay.screenshot({ path: path.join(shots, '26-circle.png') })
  // The pill shape, if chosen instead, rests as a labelled pill.
  await overlay.evaluate(() => window.watson.setPillShape('pill'))
  await until(async () => (await overlay.textContent('.pill')).includes('Watson'), 5000)
  await overlay.evaluate(() => window.watson.setPillShape('circle'))
  await overlay.evaluate(() => window.watson.resetPillPlace())
  await until(async () => (await overlay.evaluate(() => window.watson.getState())).layout.dir === 'down', 5000)
  return 'bottom-right corner: panel opened upward, fully on screen; circle 38 px'
})

await scenario('Follow-up: a real question is answered, side talk is ignored', async () => {
  await talk('What time is it in Tokyo and London?')
  await until(async () => (await spokenText()).includes('Tokyo'), 10_000)
  // Watson listens a few seconds for a follow-up, without the key.
  await until(async () => (await helper('/state')).listening, 10_000)
  await helper('/say', { text: 'And how tall is the Eiffel Tower?' })
  await until(async () => (await spokenText()).includes('330 meters'), 10_000)
  await until(async () => (await helper('/state')).listening, 10_000)
  const before = (await helper('/state')).spoken.length
  await helper('/say', { text: 'so anyway I told my friend it was fine' })
  await until(async () => (await overlay.evaluate(() => window.watson.getState())).phase === 'idle', 10_000)
  await sleep(800)
  const st = await helper('/state')
  assert(st.spoken.length === before, `said "${st.spoken.slice(before).join(' ')}" to side talk`)
  assert(!st.listening, 'kept listening after side talk')
  const h = await overlay.evaluate(() => window.watson.getHistory())
  assert(!h.turns.some((t) => t.you.includes('my friend')), 'side talk was saved in the history')
  return 'follow-up answered; side talk got no reply, wasn’t saved, and listening stopped'
})

await scenario('Ask two AIs at once; live pill; side-by-side comparison', async () => {
  await helper('/slow', { scale: 6 }) // the AIs take ~15 s, long enough to watch the pill
  await talk('Ask Claude and Grok what people think of the new iPhone camera')
  const sent = await until(async () => {
    const s = (await helper('/state')).sent
    return s.length === 2 ? s : null
  }, 10_000)
  assert(new Set(sent.map((x) => x.target)).size === 2, `both went to ${sent[0].target}`)
  // Close the panel: the circle becomes a pill that says what's going on.
  await until(async () => (await overlay.evaluate(() => window.watson.getState())).phase === 'idle', 15_000)
  await overlay.evaluate(() => window.watson.dismiss())
  await overlay.mouse.move(5, 700)
  const live = await until(async () => (await overlay.$('.pill-label.live')) && (await overlay.textContent('.pill-label.live')), 5000)
  assert(/Claude \+ Grok|Grok \+ Claude/.test(live), `pill said "${live}"`)
  await shot('29-pill-live')
  await until(async () => (await spokenText()).includes('more complete'), 40_000)
  await overlay.waitForSelector('.compare-grid', { timeout: 5000 })
  const cols = await overlay.$$eval('.compare-col', (els) => els.length)
  assert(cols === 2, `${cols} columns`)
  await shot('30-compare')
  return `typed into ${sent.map((x) => x.target).join(' and ')}, pill showed "${live}", compared in ${cols} columns`
})

await scenario('Pass an earlier answer to another AI', async () => {
  await talk('Send that to Claude')
  const sent = await until(async () => (await helper('/state')).sent[0], 10_000)
  assert(sent.text.startsWith('Turn it into a short summary'), `typed "${sent.text.slice(0, 40)}"`)
  assert(/earlier answer from (Claude and Grok|Grok and Claude)/.test(sent.text) && sent.text.includes('price and battery'), 'the earlier answers were not passed along')
  assert(!(await overlay.$('.confirm')), 'the attached answer should not trigger a confirmation')
  await until(async () => (await spokenText()).includes('Claude answered'), 20_000)
  return 'both earlier answers went along with the request, no confirmation needed'
})

await scenario('Automations: schedule one, see it in the dashboard', async () => {
  await overlay.evaluate(() => window.watson.ask('Turn off my Mac at 11 every night'))
  // Scheduling a shut-down asks first.
  await overlay.waitForSelector('.confirm .btn.primary', { timeout: 10_000 })
  assert(!(await overlay.evaluate(() => window.watson.getState())).automations.length, 'scheduled before the OK')
  await overlay.click('.confirm .btn.primary')
  await until(async () => (await overlay.evaluate(() => document.body.innerText)).includes('Every day at 11:00 PM'), 10_000)
  const existing = app.windows().find((w) => w.url().includes('#home'))
  const opened = existing ? null : app.waitForEvent('window', { timeout: 10_000 })
  await overlay.evaluate(() => window.watson.openWindow())
  const win = existing ?? (await opened)
  await win.waitForSelector('.home', { timeout: 10_000 })
  await win.setViewportSize({ width: 940, height: 700 }).catch(() => {})
  await win.click('nav button:has-text("Automations")')
  await win.waitForSelector('.auto-row', { timeout: 5000 })
  const row = await win.textContent('.auto-row')
  assert(row.includes('Shut down') && row.includes('Every day at 11:00 PM'), `row: ${row}`)
  await sleep(300)
  await win.screenshot({ path: path.join(shots, '27c-window-automations.png') })
  await win.click('.auto-row .toggle')
  await until(async () => (await win.$('.auto-row.off')) !== null, 3000)
  await win.click('.auto-row .row-icon')
  await until(async () => (await win.$('.auto-row')) === null, 3000)
  return 'created by voice, shown under Automations, turned off and deleted from the dashboard'
})

await scenario('Watson window: chat history and hand-offs', async () => {
  // It may already be open: a confirmation earlier ("send") brings it forward on its own.
  const existing = app.windows().find((w) => w.url().includes('#home'))
  const opened = existing ? null : app.waitForEvent('window', { timeout: 10_000 })
  await overlay.evaluate(() => window.watson.openWindow())
  const win = existing ?? (await opened)
  await win.waitForSelector('.home', { timeout: 10_000 })
  await win.setViewportSize({ width: 940, height: 700 }).catch(() => {})
  await win.click('nav button:has-text("Conversation")')
  await win.waitForSelector('.bubble.you', { timeout: 10_000 })
  const you = await win.$$eval('.bubble.you', (els) => els.length)
  assert(you >= 5, `only ${you} requests in the history`)
  await sleep(400)
  await win.screenshot({ path: path.join(shots, '27-window-chat.png') })
  await win.click('nav button:has-text("Widgets")')
  await win.waitForSelector('.widget-tile', { timeout: 5000 })
  const tiles = await win.$$eval('.widget-tile', (els) => els.length)
  assert(tiles >= 4, `only ${tiles} recent widgets`)
  await sleep(400)
  await win.screenshot({ path: path.join(shots, '27b-window-widgets.png') })
  await win.click('nav button:has-text("AI agents")')
  await win.waitForSelector('.job-card', { timeout: 5000 })
  const agents = await win.$$eval('.job-agent', (els) => els.map((e) => e.textContent))
  assert(agents.some((a) => a.includes('Grok')) && agents.some((a) => a.includes('Claude')), `hand-offs: ${agents.join(' | ')}`)
  await win.waitForSelector('.job-card.group .compare-col', { timeout: 5000 })
  await win.click('.job-card.done .job-toggle')
  await win.waitForSelector('.job-reply', { timeout: 5000 })
  await sleep(300)
  await win.screenshot({ path: path.join(shots, '28-window-handoffs.png') })
  // Typing in the window asks Watson; the answer lands in the chat.
  await win.click('nav button:has-text("Conversation")')
  await win.fill('.home-ask input', 'How tall is the Eiffel Tower?')
  await win.press('.home-ask input', 'Enter')
  await win.waitForSelector('.bubble.watson:has-text("330 meters")', { timeout: 10_000 })
  await win.close()
  return `${you} requests as chat bubbles; ${agents.length} hand-offs with full answers; typed question answered`
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
