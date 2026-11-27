# Watson

A voice assistant for your Mac that lives in a small black pill at the top of the screen.
Press **⌥ Space** (or click the pill) from any app and talk. Watson answers out loud. When
an answer is better seen, the pill opens into a panel with live widgets: weather, stocks,
your calendar, reminders, notes, world clocks, battery and what's playing. You can pin any
of those widgets to any screen.

Watson is also an orchestrator. When a request needs one of your other AIs, it types the
request in for you: Claude or ChatGPT on your Mac, or Grok, Gemini, Perplexity or any chat
website in your browser. That covers coding, changing your website, or anything that uses
their Gmail, Calendar or Drive connectors. Watson watches for the answer and reads you a short
summary. The work runs on that service's own plan, not on Watson's API key.

## Install (no terminal needed)

1. Open this repository's **Releases** page and download **Watson-mac.zip** from "Watson — latest build".
   GitHub builds it automatically on a Mac every time the code changes.
2. Open the zip and drag **Watson** into **Applications**.
3. Open Watson. macOS blocks apps from outside the App Store the first time: go to **System Settings →
   Privacy & Security**, scroll down, and click **Open Anyway** next to Watson.
4. Watson opens Settings: paste your Anthropic API key and allow the permissions it asks for.
   Its icon lives in the menu bar; the pill sits at the top of your screen.

Each new build has a new signature, so macOS may ask for permissions again after an update.
(A paid Apple Developer account would remove that and the "Open Anyway" step.)

## Two ways to talk

| | How | What happens |
|---|---|---|
| **Live** | ⌥ Space, then talk | Watson answers as soon as you stop. Talk over it to interrupt. It keeps listening for a few seconds for a follow-up. |
| **Dictate & review** | ⌥⇧ Space, or tap **Review** while listening | Your words appear in an editor. Fix them, then send them to Watson, Claude, Grok or any agent, or type them into the app you were in, like a dictation tool. |

Settings → Voice decides which of the two ⌥ Space does.

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
| Reminders (read, add) | Apple Reminders via EventKit | free |
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
4. Under **Agents**, turn on the AIs you use. Claude (Mac app) and Grok (grok.com) are on by default.
   You can add any running app, or any chat website by URL. Sign in to the websites once in
   your browser.
5. Optional: download a **Premium voice** (System Settings → Accessibility → Spoken Content →
   System Voice → Manage Voices) and pick it under Voice.

### Build the app

```bash
npm run dist
```

This builds `release/mac-arm64/Watson.app` with its icon, signed for your Mac only. Drag it
to Applications. macOS asks for permissions again for the built app, and again after each
rebuild, because each build has a new signature.

## Things to say

- "What's the weather this weekend?" · "How's Tesla doing this month?"
- "What's on my calendar today?" · "Add lunch with Ana tomorrow at 1"
- "Remind me to call Mom at 6" · "Show my reminders"
- "Show my recent notes" · "Make a note: ideas for the launch…"
- "What time is it in Tokyo and London?" · "How's my battery?"
- "Play Midnight City" · "next song" · "pause"
- "Pin the weather to my other screen" · "Remove the pinned widgets"
- "Ask Grok what people on X are saying about the new iPhone"
- "Ask Claude to make the hero headline on my website shorter and open a PR"
- "Have Claude draft an email to Sarah that the launch moved to Friday" (asks before sending)

## How hand-offs work

1. The brain picks the agent and writes a clean prompt, or you write it yourself in review mode.
2. Requests that send, delete, buy or publish need your OK first.
3. The helper sends the text:
   - **App agents:** it brings the app forward, optionally presses ⌘N for a new chat, focuses the message box, pastes and presses Return.
   - **Website agents:** it opens the chat URL in your default browser, waits for the message box, pastes and presses Return.
   - Then it puts your clipboard back and returns you to the app you were in.
4. Watson reads the app's windows through Accessibility. It finds the window holding your prompt
   and takes what comes after it. When the text stops changing and the Stop button is gone,
   the answer is done.
5. Haiku turns the answer into 1–3 spoken sentences, plus a panel for code, steps or data.
   The full answer is one click away.

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
