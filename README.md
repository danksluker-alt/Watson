# Watson

A voice assistant for your Mac that lives in a small black circle at the top of the screen.
Press **⌥ Space** (or click the circle) from any app and talk. Watson answers out loud. When
an answer is better seen, the pill opens into a panel with live widgets: weather, stocks,
your calendar, reminders, notes, world clocks, battery and what's playing. You can pin any
of those widgets to any screen.

Watson is also an orchestrator. When a request needs one of your other AIs, it types the
request in for you: Claude or ChatGPT on your Mac, or Grok, Gemini, Perplexity or any chat
website in your browser. That covers coding, changing your website, or anything that uses
their Gmail, Calendar or Drive connectors. Watson watches for the answer and reads you a short
summary. The work runs on that service's own plan, not on Watson's API key.

## Why Watson, and not just Siri or the AI apps themselves

If you use more than one AI, you know the routine: copy the question into Claude, then into
Grok, sit and watch each one type, flip between windows to compare, copy the better answer into a
third app to turn it into an email, and a week later you can't remember which app said what.
Siri can't help with any of that; it doesn't talk to your AIs.

Watson does the running around for you:

- **One question, several AIs.** "Ask Claude and Grok which laptop to buy." Watson types it into
  each app, waits for all of them in the background while you keep working, and shows the answers
  side by side with a short verdict: where they agree, what differs, which is more complete.
- **No babysitting.** The circle turns into a live status pill ("Claude + Grok · 1 of 2 in · 0:42",
  "Grok is writing · 0:18") and Watson tells you when the answers are in.
- **No copy-paste between AIs.** "Send that to Claude and turn it into an email" passes the last
  answer (or every answer from a comparison) along with your request.
- **One place for everything.** The Watson window keeps every question, hand-off and full answer,
  searchable, on this Mac.
- **Cheap.** The AIs do the heavy work on your own subscriptions; Watson only spends a small Haiku
  call to summarize or compare.

## Install

Watson is built and tested locally on the Mac (see **Build the app** below): `npm run dist`
makes `release/mac-arm64/Watson.app`, which goes in **Applications**. Its icon lives in the menu
bar; the pill sits at the top of your screen. The first launch opens Settings: paste your
Anthropic API key and allow the permissions it asks for.

Builds are signed with your free **Apple Development** certificate when you have one (Xcode →
Settings → Accounts, with any Apple ID), so macOS keeps Watson's permissions across rebuilds.
Without one the build is signed ad hoc and macOS asks for permissions again after each rebuild.

Watson writes a log to `~/Library/Logs/Watson/watson.log` (no keys or conversation text).

The GitHub Actions workflows in `.github/workflows` only run when started by hand
(Actions → Run workflow); pushes don't trigger them.

## The pill and the Watson window

- At rest Watson is a small circle. It grows into a pill only to tell you something: an AI working
  on your request and for how long ("Grok is writing · 0:18"), a comparison in progress, a running
  timer ("Tea · 3:12"), an event about to start ("MATH 112 · in 8m"), or an answer that just came in.
  Several things take turns; anything that needs your OK stays put.
- **Click** it to talk. **Hold** it for half a second to lift it and drag it anywhere, on any screen;
  when you let go, choose **Circle** or **Pill** (a pill that says "Watson" at rest), or **Reset** it
  to the top centre. Near an edge or
  the bottom of the screen the panel shifts or opens upward so it's never cut off.
- **The dashboard** (right-click the circle → Open dashboard, the ⤢ button in the panel, or the
  menu-bar icon) has your recent requests as a chat, **AI agents** (what Claude and Grok are working on
  and every answer and comparison), **Widgets** (the latest weather, stocks, calendar and other things
  you asked to see), and anything waiting for your OK. It comes forward on its
  own when something needs confirming (Settings → Agents). History stays on this Mac
  (`history.json`); **Clear history** removes it.

After it answers, Watson listens for a few seconds so you can just keep talking ("and tomorrow?").
If what it hears isn't meant for it, like you talking to someone else or thinking aloud, it stays quiet
and stops listening. Talking over Watson stops it, but answers from your AIs that are still waiting to be
read aren't lost.

## Two ways to talk

| | How | What happens |
|---|---|---|
| **Dictate, then send** (default) | Click the circle, or ⌥ Space | Your words appear in a box as you speak. Nothing is sent until you press **Send** (or Return), and you can fix the text first. **Auto** lets Watson answer or hand it to Claude or Grok (or name one: "ask Grok…"); you can also pick an AI or "Type into <app>". Watson speaks the answer, then the microphone goes off. |
| **Talk live** | **Talk live** in the dictation box, ⌥⇧ Space, the right-click menu, or say **"Hey Watson"** | A spoken conversation: Watson answers as soon as you stop, you can talk over it, and it listens a few seconds for a follow-up. |

Settings → Voice swaps which one the click and ⌥ Space use. **Listen for "Hey Watson"** is off unless
you turn it on: it listens on this Mac only (on-device speech recognition, nothing is sent anywhere),
and macOS shows the orange microphone dot while Watson is idle.

Right-click the circle for: dictate, talk live, **Open dashboard**, move or change shape, "Hey Watson",
and Settings.

## How it's built

| Part | What it does |
|---|---|
| `src/main` (Electron, TypeScript) | Window, hotkeys, menu-bar icon, the brain, tools, hand-offs, pinned widgets |
| `src/renderer` (React) | The pill, panel, review editor, widgets, widget windows and Settings |
| `helper/WatsonHelper.swift` | Native helper. On-device speech recognition; the voice, with echo cancellation so you can interrupt; Accessibility, for typing into other apps and reading their answers; EventKit, for Calendar and Reminders |
| `src/shared` | Types shared by both sides |

### The brain (`src/main/brain.ts`)

- **Claude Haiku 5.5** answers most questions, for about $0.0002 each.
- **Claude Sonnet 5.5** is used only for requests that look like they need reasoning.
- Only the last 6 exchanges are sent, as plain text.
- The system prompt stays the same all day, so it can be cached.
- A **daily budget** (default $0.50) stops API calls once it's reached.

| Tool | Source | Cost |
|---|---|---|
| Weather | Open-Meteo | free |
| Stocks | Yahoo Finance chart data, with a Stooq fallback | free |
| Calendar (read, add) | Apple Calendar via EventKit (all your accounts) | free |
| Reminders (read, add, check off) | Apple Reminders via EventKit | free |
| Timers and alarms | Local; a countdown in the pill, a chime, a spoken alert and a notification | free |
| Mac controls | Volume, mute, dark/light mode, sleep the display | free |
| Memory | Facts you ask Watson to remember, kept in `memory.json` on this Mac | free |
| Clipboard | Reads copied text when you ask ("summarize what I copied") | free |
| Find files | Spotlight (`mdfind`) in your home folder | free |
| Notes (recent, search, read, create) | Apple Notes via AppleScript | free |
| World clock | Time zones from Open-Meteo | free |
| Battery | `pmset` | free |
| Music | Spotify or Apple Music via AppleScript | free |
| Open apps, sites and files | macOS `open` | free |
| `show_panel` | Cards, lists, tables, stats and charts | — |
| `pin_widget` | Floating widget windows on any screen | — |
| `delegate` | Hands a request to one of your AI agents | — |
| Web search | Claude's web search tool | about $0.01 per search; can be turned off |

### Widgets

Apple doesn't let other apps embed macOS widgets. Watson reads the same data (EventKit,
Notes, pmset, Spotify or Music) and draws its own widgets in the same style.

- Say "pin my calendar", "put the weather on my other screen", or hover any widget and click 📌.
- A pinned widget floats above other windows, can be dragged anywhere on any display,
  remembers where it is, and refreshes itself.
- Hover a pinned widget and click × to remove it.

### Safety

- Anything that sends, deletes, buys, posts, merges or deploys shows the full request and waits
  for you to say "send" or click **Send**.
- Text you dictated, edited and sent yourself in review mode doesn't ask again.
- Watson only opens web links and documents. It refuses to open scripts or installers. It can't
  delete events, reminders or notes.
- Keys are typed into Settings and encrypted with macOS Keychain.

## Developing on your Mac (Apple Silicon)

You need Node 20+ and the Swift compiler. If you don't have Xcode, run `xcode-select --install`.

Keep the project **outside** iCloud-synced folders (Desktop and Documents when "Desktop & Documents
Folders" is on). With "Optimize Mac Storage", iCloud offloads files in `node_modules` and the app
hangs at launch while reading them. `~/Developer/Watson` is a good place.

```bash
git clone https://github.com/<you>/Watson.git && cd Watson
npm install
npm run helper     # builds the Swift helper into helper/build/
npm run dev        # runs Watson in development
```

The first run opens Settings:

1. Paste your **Anthropic API key** (console.anthropic.com → API keys).
2. Allow **Microphone**, **Speech Recognition**, **Calendars** and **Reminders** when macOS asks.
3. Turn on **Accessibility** for hand-offs and dictation: System Settings → Privacy & Security →
   Accessibility. In development the entry is "Electron"; in the built app it's "Watson".
4. Under **Agents**, turn on the AIs you use. Watson lists the AI apps it finds on your Mac
   (Claude, ChatGPT, Codex, Grok, Perplexity, Gemini, Copilot…) with an **Add** button; any other app
   can be picked from a list, and any chat website added by URL. An app takes over the name of a
   website agent ("ask Grok" goes to the Grok app once it's added).
5. Optional: download a **Premium voice** (System Settings → Accessibility → Spoken Content →
   System Voice → Manage Voices) and pick it under Voice.

### Build the app

```bash
npm run dist
```

This builds `release/mac-arm64/Watson.app` with its icon, signed for your Mac only
(`scripts/sign-identity.sh` picks the certificate). Drag it to Applications.

## Things to say

- "Good morning" (weather, calendar and reminders in one short briefing)
- "Set a pasta timer for 9 minutes" · "Wake me up at 7" · "Cancel the pasta timer"
- "Turn the volume down" · "Mute" · "Switch to dark mode"
- "Remember I parked on level 3, spot B12" · "Where did I park?" · "What do you remember?"
- "Summarize what I copied" · "Translate this to Spanish"
- "Find my tax return PDF" · "Mark *buy milk* as done"
- "What's the weather this weekend?" · "How's Tesla doing this month?"
- "What's on my calendar today?" · "Add lunch with Ana tomorrow at 1"
- "Remind me to call Mom at 6" · "Show my reminders"
- "Show my recent notes" · "Make a note: ideas for the launch…"
- "What time is it in Tokyo and London?" · "How's my battery?"
- "Play Midnight City" · "next song" · "pause"
- "Pin the weather to my other screen" · "Remove the pinned widgets"
- "Ask Grok what people on X are saying about the new iPhone"
- "Ask Claude and Grok which of these two flights is the better deal" · "Ask everyone…" (compared side by side)
- "Send that to Claude and turn it into a short email" (passes the last answer along)
- "Ask Claude to make the hero headline on my website shorter and open a PR"
- "Have Claude draft an email to Sarah that the launch moved to Friday" (asks before sending)

## How hand-offs work

1. The brain picks the agent and writes a clean prompt, or you write it yourself in review mode.
2. Requests that send, delete, buy or publish need your OK first.
3. The helper sends the text:
   - **App agents:** it brings the app forward, opens a new chat through the app's own menu
     ("New Chat"; for Claude it first picks Go → Claude, because ⌘N in Claude's Code view starts a
     coding session), focuses the message box, pastes and presses Return. If it can't find the
     message box it sends nothing and says so.
   - **Website agents:** it opens the chat URL in your default browser, waits for the message box, pastes and presses Return.
   - Then it puts your clipboard back and returns you to the app you were in.
4. Watson reads the app's windows through Accessibility. It finds the window holding your prompt
   and takes what comes after it. When the text stops changing and the Stop button is gone,
   the answer is done.
5. Haiku turns the answer into 1–3 spoken sentences, plus a panel for code, steps or data.
   The full answer is one click away.

**Several at once** ("ask Claude and Grok…"): Watson types into one app at a time, then waits for
all of them side by side. When they're in, one Haiku call compares them (each answer clipped) into
a spoken verdict and one line per AI; the panel and the Watson window show them in columns with the
full answers a click away. If one AI fails, the others are still compared.

**Passing an answer along** ("send that to Claude…"): the last answer (or every answer from the last
comparison) is pasted after your request. Only your own words decide whether Watson asks before
sending; the passed-along answer doesn't.

Every hand-off starts with something you asked for. Watson never loops on its own.

## Tests

```bash
npm run typecheck
npm test            # reply-extraction unit tests
npm run e2e         # end-to-end scenarios (on Linux: npm run e2e:linux)
```

`npm run e2e` runs the real app against two stand-ins:

- `tests/e2e/fake-helper.mjs` speaks the native helper's exact protocol. It simulates speech,
  the voice, barge-in, a Claude app and a browser running Grok that answer after a delay, and
  Calendar, Reminders, Notes, Spotify and the battery.
- `tests/e2e/mock-api.mjs` plays the Claude API (streaming and tool calls) and the weather and
  stock services.

It clicks through the everyday scenarios and saves screenshots to `screenshots/e2e/`. It does
not cover the Swift layer or real model answers; try those on your Mac.

## Not built yet

- **Screen reading** ("what's on my screen?"): one screenshot on request, sent to Sonnet.
- **Grok as Watson's own brain** through the xAI API. Settings already has the key field. Grok as
  an agent you hand off to already works.
- Using your Claude subscription as the brain: Pro/Max plans can't act as an API key for other
  apps. Hand-offs are the supported way to use your plan from Watson.
