// A stand-in for helper/WatsonHelper.swift that speaks the same JSON-lines
// protocol, so the real Electron app can be tested on any OS.
//
// It simulates: speech recognition (driven by POST /say on the control port),
// the voice (speak → speak.start / speak.idle), barge-in, other apps (a Claude
// Mac app and a browser running Grok that answer after a delay), Calendar,
// Reminders, Notes, Spotify and the battery.
import http from 'node:http'
import readline from 'node:readline'

const PORT = Number(process.env.FAKE_HELPER_PORT || 47811)
const BROWSER = 'com.apple.Safari'
const USER_APP = 'com.apple.TextEdit'

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const reply = (id, data, ok = true, error) => id && out({ ev: 'result', id, ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const log = { spoken: [], sent: [], inserted: [], exec: [], calendarAdds: [], reminderAdds: [], reminderDone: [], commands: [] }
let listening = false
/** Listening for "Hey Watson" (on-device in the real helper). */
let waking = false
let session = 0
let speakQueue = []
let speaking = false
let speakGen = 0
/** How slowly the simulated AIs answer (1 = about 2.4 s); POST /slow sets it, /reset restores it. */
let answerScale = 1

// ---------------- Simulated apps ----------------

const apps = {
  'com.anthropic.claudefordesktop': { windows: [{ title: 'Claude', lines: ['Claude', 'Yesterday', 'Help me plan the launch', 'Sure, here is a plan.'], busy: false }] },
  [BROWSER]: { windows: [{ title: 'Inbox – Mail', lines: ['Inbox', 'Sam: lunch?'], busy: false }] },
}

const REPLIES = {
  grok: [
    'People on X are mostly excited about the new iPhone camera.',
    'The top posts praise low-light photos and the titanium frame.',
    'The main complaints are the price and battery life on the Pro Max.',
  ],
  claude: [
    'Done. I updated the hero section in `src/pages/Home.tsx`:',
    '```tsx',
    '<h1>Know your cycle.</h1>',
    '<Button>Start free</Button>',
    '```',
    'I opened pull request #142 for you to review.',
  ],
  agentq: [
    'Happy to build it. Which kind do you want?',
    '1. A reusable marketing skill for campaign plans',
    '2. A Claude Code subagent for a coding project',
    '3. A voice agent that talks to customers',
    '4. A scheduled weekly marketing task',
    'Pick one or several.',
  ],
  chose: ['Great, I will set up the subagent and the weekly task now.'],
  email: ['Here is the draft to Sarah:', 'Subject: Launch moved to Friday', 'Hi Sarah, quick update: the launch is now on Friday, December 4. Thanks!', 'I saved it as a draft in Gmail. Say the word and I will send it.'],
}

function simulateAnswer(target, text, url) {
  const app = (apps[target] ??= { windows: [] })
  const agent = url?.includes('grok') ? 'grok' : /marketing agent/i.test(text) ? 'agentq' : /^I choose/.test(text) ? 'chose' : /email|sarah/i.test(text) ? 'email' : 'claude'
  let win
  if (url) {
    win = { title: new URL(url).hostname, lines: [new URL(url).hostname.replace(/\..*/, '').toUpperCase(), 'New chat'], busy: false }
    app.windows.unshift(win)
  } else {
    win = app.windows[0]
  }
  win.lines.push(text)
  const lines = REPLIES[agent]
  setTimeout(() => {
    win.busy = true
    win.lines.push(lines[0])
  }, 900 * answerScale)
  setTimeout(() => {
    win.lines.push(...lines.slice(1))
  }, 1700 * answerScale)
  setTimeout(() => {
    win.busy = false
    win.lines.push('Copy', 'Retry')
  }, 2400 * answerScale)
}

// ---------------- Calendar / Reminders / Notes data ----------------

function at(dayOffset, h, m = 0) {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(h, m, 0, 0)
  return d.getTime() / 1000
}
const rawEvents = [
  { title: 'Team standup', start: at(0, 9, 30), end: at(0, 9, 45), allDay: false, calendar: 'Work', color: '#0A84FF' },
  { title: 'Design review', start: at(0, 11, 30), end: at(0, 12, 30), allDay: false, calendar: 'Work', color: '#0A84FF', location: 'Studio' },
  { title: 'Lunch with Ana', start: at(0, 13, 0), end: at(0, 14, 0), allDay: false, calendar: 'Personal', color: '#30D158' },
  { title: 'Gym', start: at(0, 18, 30), end: at(0, 19, 30), allDay: false, calendar: 'Personal', color: '#FF9F0A' },
  { title: 'Mom’s birthday', start: at(1, 0), end: at(2, 0), allDay: true, calendar: 'Family', color: '#FF375F' },
  { title: 'Investor call', start: at(1, 10, 0), end: at(1, 11, 0), allDay: false, calendar: 'Work', color: '#0A84FF' },
]
// An event happening now or soon would turn the resting pill into an "up next" pill and make the pill
// tests depend on the time of day; such an event moves to an hour from now (keeping its length).
const nowSec = Date.now() / 1000
const events = rawEvents.map((e) =>
  !e.allDay && e.start < nowSec + 40 * 60 && e.end > nowSec - 60 ? { ...e, start: nowSec + 3600, end: nowSec + 3600 + (e.end - e.start) } : e
)
const reminders = [
  { id: 'r1', title: 'Renew passport', list: 'Personal', color: '#FF9F0A', priority: 1, due: at(-1, 17) },
  { id: 'r2', title: 'Send invoice to Acme', list: 'Work', color: '#0A84FF', priority: 0, due: at(0, 16) },
  { id: 'r3', title: 'Buy oat milk', list: 'Groceries', color: '#30D158', priority: 0 },
]

const FS = '\u001f'
const RS = '\u001e'
const iso = (daysAgo, h) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h, 12, 0, 0)
  return d.toISOString().replace(/\.\d+Z$/, 'Z')
}
const notes = [
  ['n1', 'Launch checklist', iso(0, 9), 'Notes', 'Launch checklist\nFinal QA on Thursday, press kit, App Store screenshots'],
  ['n2', 'Grocery list', iso(1, 18), 'Notes', 'Grocery list\nOat milk, eggs, spinach, coffee beans'],
  ['n3', 'Ideas for Watson', iso(3, 22), 'Projects', 'Ideas for Watson\nPin widgets on the second screen; morning briefing'],
]

function execFake(cmd, args) {
  const script = args.join(' ')
  log.exec.push({ cmd, script: script.slice(0, 400) })
  if (script.includes('get volume settings')) return '60,false'
  if (cmd.endsWith('pmset')) return "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t76%; discharging; 4:21 remaining present: true"
  if (script.includes('application "Notes"')) {
    if (script.includes('make new note')) return ''
    if (script.includes('set ids to id of notes')) return notes.map((n) => [n[0], n[2]].join(FS)).join(RS) + RS
    if (script.includes('plaintext of x) & fs') || script.includes('return (name of x) & fs')) {
      const n = notes[0]
      return [n[1], n[2], n[4]].join(FS)
    }
    return notes.map((n) => [n[0], n[1], n[2], n[3], n[4].slice(0, 160)].join(FS)).join(RS) + RS
  }
  if (script.includes('application "Spotify"') || script.includes('application "Music"')) {
    if (script.includes('player state is stopped')) return 'Midnight City|M83|Hurry Up, We’re Dreaming||243000|87.2|playing'
    return ''
  }
  return ''
}

// ---------------- Speech ----------------

function pumpSpeech() {
  if (speaking || !speakQueue.length) return
  speaking = true
  const gen = speakGen
  const item = speakQueue.shift()
  out({ ev: 'speak.start', id: item.id })
  setTimeout(() => {
    if (gen !== speakGen) return
    speaking = false
    if (speakQueue.length) pumpSpeech()
    else out({ ev: 'speak.idle' })
  }, Math.min(1200, 120 + item.text.length * 6))
}

function stopSpeech() {
  const was = speaking || speakQueue.length > 0
  speakGen++
  speaking = false
  speakQueue = []
  if (was) out({ ev: 'speak.idle', stopped: true })
}

async function say(text) {
  if (!listening) return false
  const sid = session
  if (speaking || speakQueue.length) {
    stopSpeech()
    out({ ev: 'bargein' })
  }
  const words = text.split(/\s+/)
  for (let i = 1; i <= words.length; i++) {
    if (sid !== session || !listening) return true
    out({ ev: 'level', value: 0.4 + Math.random() * 0.4 })
    out({ ev: 'partial', text: words.slice(0, i).join(' '), session: sid })
    await sleep(35)
  }
  await sleep(150)
  if (sid !== session || !listening) return true
  listening = false
  out({ ev: 'final', text, session: sid })
  return true
}

// ---------------- Command loop ----------------

async function handle(msg) {
  const { id, cmd } = msg
  log.commands.push(cmd)
  switch (cmd) {
    case 'configure':
      return reply(id)
    case 'wake.start':
      if (!listening) waking = true
      return reply(id)
    case 'wake.stop':
      waking = false
      return reply(id)
    case 'listen.start':
      session++
      waking = false
      listening = true
      out({ ev: 'listening', session })
      return reply(id)
    case 'listen.stop':
    case 'listen.cancel':
      listening = false
      session++
      return reply(id)
    case 'speak':
      log.spoken.push(msg.text)
      speakQueue.push({ id: msg.speakId, text: msg.text })
      pumpSpeech()
      return reply(id)
    case 'speak.stop':
      stopSpeech()
      return reply(id)
    case 'voices':
      return reply(id, [{ id: 'ava', name: 'Ava', language: 'en-US', quality: 'premium' }])
    case 'permissions':
    case 'permissions.request':
      return reply(id, { microphone: 'granted', speech: 'granted', accessibility: true, calendar: 'granted', reminders: 'granted' })
    case 'apps.running':
      return reply(id, [{ name: 'Claude', bundleId: 'com.anthropic.claudefordesktop' }, { name: 'TextEdit', bundleId: USER_APP }])
    case 'frontmost':
      return reply(id, { bundleId: USER_APP, name: 'TextEdit' })
    case 'browser.default':
      return reply(id, { bundleId: BROWSER })
    case 'ax.snapshot': {
      const app = apps[msg.bundleId]
      if (!app) return reply(id, undefined, false, "That app isn't open.")
      return reply(id, { windows: app.windows.map((w) => ({ title: w.title, lines: [...w.lines], busy: w.busy })) })
    }
    case 'ax.send': {
      const target = msg.url ? msg.browser || BROWSER : msg.bundleId
      log.sent.push({ target, url: msg.url, bundleId: msg.bundleId, text: msg.text, newChat: msg.newChat })
      await sleep(300)
      simulateAnswer(target, msg.text, msg.url)
      return reply(id, { bundleId: target })
    }
    case 'ax.insert':
      log.inserted.push({ bundleId: msg.bundleId, text: msg.text })
      return reply(id)
    case 'calendar.events':
      return reply(id, events.filter((e) => e.start < msg.to && e.end > msg.from))
    case 'calendar.add': {
      const e = { title: msg.title, start: msg.start, end: msg.end, allDay: msg.allDay, calendar: 'Home', color: '#BF5AF2', location: msg.location }
      events.push(e)
      log.calendarAdds.push(e)
      return reply(id, e)
    }
    case 'reminders.list':
      return reply(id, msg.list ? reminders.filter((r) => r.list.toLowerCase().includes(String(msg.list).toLowerCase())) : reminders)
    case 'reminders.add': {
      const r = { id: `r${reminders.length + 1}`, title: msg.title, list: msg.list || 'Reminders', color: '#0A84FF', priority: 0, due: msg.due }
      reminders.unshift(r)
      log.reminderAdds.push(r)
      return reply(id, { title: msg.title, list: r.list })
    }
    case 'reminders.complete': {
      const i = reminders.findIndex((r) => r.title.toLowerCase().includes(String(msg.title).toLowerCase()))
      if (i < 0) return reply(id, undefined, false, `There's no open reminder called "${msg.title}".`)
      const [r] = reminders.splice(i, 1)
      log.reminderDone.push(r.title)
      return reply(id, { title: r.title, list: r.list })
    }
    case 'exec':
      return reply(id, execFake(msg.program, msg.args ?? []))
    case 'ping':
      return reply(id, { pong: true })
    default:
      return reply(id, undefined, false, `Unknown command ${cmd}`)
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    void handle(JSON.parse(line))
  } catch {
    /* ignore */
  }
})
process.stdin.on('end', () => process.exit(0))

// ---------------- Control port for the test ----------------

http
  .createServer(async (req, res) => {
    const body = await new Promise((r) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => r(b ? JSON.parse(b) : {}))
    })
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/partial') {
      // Words heard so far, with no end yet (the user is still talking).
      if (!listening) return res.end(JSON.stringify({ ok: false }))
      out({ ev: 'partial', text: body.text, session })
      return res.end(JSON.stringify({ ok: true }))
    }
    if (req.url === '/say') {
      const ok = await say(body.text)
      res.statusCode = ok ? 200 : 409
      return res.end(JSON.stringify({ ok }))
    }
    if (req.url === '/state') return res.end(JSON.stringify({ listening, waking, speaking: speaking || speakQueue.length > 0, ...log }))
    if (req.url === '/wake') {
      if (!waking) return res.end(JSON.stringify({ ok: false }))
      waking = false
      out({ ev: 'wake' })
      return res.end(JSON.stringify({ ok: true }))
    }
    if (req.url === '/reset') {
      for (const k of Object.keys(log)) log[k] = []
      answerScale = 1
      return res.end('{}')
    }
    if (req.url === '/slow') {
      answerScale = Number(body.scale) || 1
      return res.end('{}')
    }
    res.statusCode = 404
    res.end('{}')
  })
  .listen(PORT, '127.0.0.1')

out({ ev: 'ready', permissions: { microphone: 'granted', speech: 'granted', accessibility: true } })
