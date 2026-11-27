# Watson

A voice assistant for your Mac that lives in a small black pill at the top of the screen.
Press **⌥ Space** (or click the pill) from any app, talk, and Watson answers out loud.
When an answer is better seen, the pill opens into a panel with live widgets: weather,
stocks, what's playing on Spotify, tables, charts and dashboards.

Watson is also an orchestrator. When a request needs your other AI apps — coding, changing
your website, anything that uses Claude's Gmail, Calendar or Drive connectors — Watson types
the request into that app for you (like a dictation tool would), watches for the answer, and
reads you a short summary. That work runs on that app's own plan, not on Watson's API key.

## How it's built

| Part | What it does |
|---|---|
| `src/main` (Electron, TypeScript) | Window, hotkey, menu-bar icon, the brain, tools, hand-offs |
| `src/renderer` (React) | The pill, panel, widgets and Settings window |
| `helper/WatsonHelper.swift` | Native helper: on-device speech recognition, the voice (with echo cancellation so you can interrupt), and Accessibility for typing into other apps |
| `src/shared` | Types shared by both sides |

**The brain** (`src/main/brain.ts`) uses the Claude API:

- **Claude Haiku 5.5** answers most questions, for about $0.0002 each.
- **Claude Sonnet 5.5** handles requests that look like they need reasoning ("explain", "compare", "plan", long asks).
- Only the last 6 exchanges are sent, as plain text.
- A **daily budget** (default $0.50) stops API calls once it's reached.

**Tools the brain can use**

| Tool | Source | Cost |
|---|---|---|
| Weather | Open-Meteo | free, no key |
| Stocks | Yahoo Finance chart data, with a Stooq fallback | free, no key |
| Spotify | AppleScript to the Spotify app; optional Web API keys to find a specific song | free |
| Open apps, sites and files | macOS `open` | free |
| `show_panel` | Cards, lists, tables, stats and charts drawn by Watson | — |
| `delegate` | Hands a request to Claude, ChatGPT or any app you add | — |
| Web search | Claude's web search tool | about $0.01 per search; can be turned off |

**Safety.** Anything that sends, deletes, buys, posts, merges or deploys shows the full request
on screen and waits for you to say "send" or click **Send**. Watson only opens web links and
documents. It refuses to open scripts or installers.

**Keys.** Keys are typed into Settings and encrypted with macOS Keychain (Electron
`safeStorage`). They are never written in plain text or kept in the code.

## Setup on your Mac (Apple Silicon)

You need Node 20+ and the Swift compiler. If you don't have Xcode, run
`xcode-select --install` to get the compiler.

```bash
git clone https://github.com/<you>/Watson.git && cd Watson
npm install
npm run helper     # builds the Swift helper into helper/build/
npm run dev        # runs Watson in development
```

The first run opens Settings:

1. Paste your **Anthropic API key** (console.anthropic.com → API keys).
2. Allow **Microphone** and **Speech Recognition** when macOS asks.
3. For hand-offs, turn on **Accessibility**: System Settings → Privacy & Security → Accessibility.
   In development the entry is called "Electron"; in the built app it's "Watson".
4. Optional: download a **Premium voice** and pick it under Voice. To get one, open System Settings →
   Accessibility → Spoken Content → System Voice → Manage Voices. Ava, Zoe and Evan sound best.

### Build the app

```bash
npm run dist
```

This builds `release/mac-arm64/Watson.app`, signed for your Mac only (an "ad-hoc" signature).
Drag it to Applications. macOS asks for permissions again for the built app, and again
after each rebuild, because each build has a new signature.

## Things to say

- "What's the weather this weekend?" → weather widget
- "How's Tesla doing this month?" → stock chart
- "Play Midnight City by M83", "next song", "pause"
- "Open Figma", "open bloom-tracking.com"
- "Compare the iPhone 17 and 17 Pro in a table" → table in the panel
- "Ask Claude to make the hero headline on my website shorter and open a PR" → hand-off to the Claude app
- "Have Claude check my Gmail for anything from Sarah today" → hand-off, then a spoken summary
- Talk over Watson while it's speaking to interrupt it. Press ⌥ Space to stop it.

## How hand-offs work

1. The brain decides a request belongs to another app and writes a clean prompt.
2. If the request sends, deletes, buys or publishes something, Watson asks you first.
3. The helper brings the app forward, focuses its message box, pastes the prompt,
   presses Return and puts your clipboard back. It then returns you to the app you were in.
4. Every 2 seconds Watson reads that app's window text through Accessibility. It finds where
   your prompt appears and takes what comes after. When the text stops changing and the
   app's Stop button is gone, the answer is done.
5. Haiku turns the answer into 1–3 spoken sentences, plus a panel for code, steps or data.
   The full answer is one click away.

Every hand-off starts with something you asked for. Watson never loops on its own.

The reply extraction is in `src/main/extract.ts` and is tested by `npm test`. If a chat app
changes its layout and replies come back wrong, look there first.

## Checks

```bash
npm run typecheck
npm test
npm run build
node scripts/screenshots.mjs   # renders the UI with sample data into screenshots/ (needs Playwright)
```

## Not built yet

- **Screen reading** ("what's on my screen?"): one screenshot on request, sent to Sonnet.
- **Grok** as a second brain: there's already a field in Settings for the xAI key.
- **Native macOS widgets:** Apple doesn't let other apps embed them, so Watson draws its own
  in the same style.
- Using your Claude subscription as the brain: Pro/Max plans can't act as an API key for
  other apps. Hand-offs are the supported way to use your plan from Watson.
