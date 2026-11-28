# Watson — working notes

- Two halves: Electron/TypeScript (`src/`) and a Swift helper (`helper/WatsonHelper.swift`) that
  talk over stdin/stdout JSON lines. The helper's command list is the `handle()` switch; the TS
  side of the protocol is `src/main/helper.ts` (`HelperEvent`).
- The Swift helper only builds on macOS (`npm run helper`). On Linux you can typecheck, test,
  build the Electron side and render screenshots, but not run voice or hand-offs.
- Models: `claude-haiku-5-5` by default, `claude-sonnet-5-5` for hard requests (`pickModel` in
  `src/main/brain.ts`). The owner is on a tight budget: keep context short, keep widgets local,
  never send screenshots unless asked.
- Anything that sends, deletes, buys or publishes must go through `confirm()` in `src/main/index.ts`.
- Keys only via `setSecret`/`getSecret` (safeStorage). Never in code, logs or settings.json.
- Agents are `AgentTarget`s: `kind: 'app'` (bundle id) or `kind: 'web'` (chat URL opened in the
  default browser). Reply reading is `replyFromWindows` in `src/main/extract.ts`.
- Widgets: `buildWidget`/`paramsOf` in `src/main/widgets.ts` are the single source for panel blocks
  and pinned widget windows (`src/main/pinned.ts`).
- Test seams (env): `WATSON_HELPER_CMD`, `WATSON_FAKE_OS`, `WATSON_MOCK_DATA`, `WATSON_USER_DATA`,
  `WATSON_POLL_MS`, `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY`. Used by `tests/e2e/run.mjs`.
- Before committing: `npm run typecheck`, `npm test`, `npm run build`, and `npm run e2e`
  (`npm run e2e:linux` on Linux). Playwright is a dev dependency (only its Electron driver is used;
  no browser download).
- Build and test locally. The owner's GitHub Actions budget is limited: the workflows are
  `workflow_dispatch` only, so pushes to main don't start them.
- Keep the checkout out of iCloud Drive (Desktop/Documents sync): offloaded "dataless" files in
  `node_modules` make Node and Electron hang at startup. The owner's checkout is `~/Developer/Watson`.
- Signing: `scripts/sign-identity.sh` picks `$WATSON_SIGN_IDENTITY`, else the owner's free
  "Apple Development" cert, else ad hoc. A stable identity keeps TCC permissions across rebuilds.
- Log: `~/Library/Logs/Watson/watson.log` (tests write into their temp profile instead). Log
  states and errors only, never keys or conversation text.
- Audio uses two engines: `engine` (mic, voice processing = echo cancellation) and `outEngine`
  (Watson's voice). On macOS 27/M1, voice processing works on an input-only engine but any output
  on that same engine fails (-10875) or hangs. If voice processing still fails, the helper falls
  back to the plain mic (`voiceProcessingFailed`) and logs it.
- Diagnostics in the helper: `audio.probe` (tries engine set-ups) and `echo.test` (speaks a
  sentence while recognizing the mic, `vp` on/off). Never add a probe set-up that can hang:
  killing a hung `engine.start()` wedged coreaudiod until the Mac was restarted.
- Hand-offs (Claude desktop, checked on the real app): Chromium apps return an empty AX tree on
  the first read after `AXManualAccessibility` is set, so the helper retries. Busy = a "Stop" control
  or status text like "Claude is responding". New chat goes through named menu items
  (`AgentTarget.chatMenu`, then "New Chat"), never a blind ⌘N. No message box found = nothing is
  pasted. Each message also appears as a screen-reader copy ("You said: …"); `extract.ts` drops
  those and rejoins text split at bold words. Fixture: `tests/fixtures/claude-chat-ready.json`.
- `ax.menus` lists an app's menu items and shortcuts; `ax.inputs` lists text boxes and says which one
  `findInput` would pick (both read-only). `findInput` only accepts a text area or a field labelled
  like a chat box, never form fields (name, age, email, password, search): grok.com once showed an
  age form whose "Age" field would otherwise have received the prompt.
- Agent discovery: `src/shared/aiApps.ts` (catalog of AI app bundle ids, `addAppAgent`) and
  `installedApps()` in `src/main/tools/apps.ts`. Grok Bot (`com.anysphere.sand`) has no New Chat menu;
  its assistant labels itself "Atlas". `extract.ts` drops sender labels (names seen in "<name>
  replied" or repeated), times and date separators. Fixture: `tests/fixtures/grok-bot-ready.json`.
- e2e sets `WATSON_INVISIBLE=1`: test windows are transparent and unfocusable, so test runs don't
  flash the purple test wallpaper on the owner's screen.
- Pill placement: `pillPlace` (display id + fractions of its work area) and `pillShape` in settings;
  `overlayPlacement()` keeps the 760×720 overlay on screen and tells the renderer the island's centre
  and whether the panel opens up or down (`UIState.layout`). Hold-to-move: renderer `useHoldToMove`
  → `pill:drag` start/end; main follows the cursor and saves the spot.
- Pill: a circle at rest (`pillShape` default `circle`); `useLive` in `src/renderer/src/pill.tsx` turns it
  into a status pill for active/just-finished hand-offs, comparisons, timers and an event within 10 min.
  `refreshGlance` only reads the next Calendar event each minute (no weather, no API calls).
- Several AIs at once: brain tool `ask_several` → `Delegations.startGroup` (jobs share `groupId`; typing
  is serialized by `oneAtATime`, waiting is parallel) → `brain.compare` (one Haiku call, JSON parsed by
  `parseComparison` in `src/main/handoffText.ts`) → `compare` block and `history.compares`.
  `include_previous_answer` on `delegate`/`ask_several` pastes the last answer (`previousAnswer()` in
  index.ts); `RISKY` checks only the user's request, never the attached answer.
- Watson window (`#home`, `Home.tsx`): history from `src/main/history.ts` (history.json, capped),
  live state, hand-offs, and the pending confirmation. Opens on confirmations if `openWindowOnConfirm`.
- Free data services (weather, stocks) go through `fetchRetry` (`src/main/tools/net.ts`): 7 s limit, one
  retry, and a plain "can't reach the internet" message. A second hotkey press within 1.5 s of the one
  that sent a request is ignored (double press), not treated as cancel.
- Hold-to-move ends on a page-wide pointerup and when the pill turns into the panel mid-press; the main
  process also stops following the cursor after 30 s. (A lost release once left the window glued to
  the mouse.) Code lines in agent answers are never rejoined (`CODE` in `extract.ts`).
- Unprompted speech (heard in a `watch` listen: the follow-up seconds or talking over Watson) is sent with
  a note on the user message (not the system prompt, to keep the cache); the model answers `<silent>`
  when it wasn't meant for Watson, and then nothing is spoken, saved or listened for. At most
  `MAX_UNPROMPTED` (2) unprompted turns in a row re-arm follow-up listening. Barge-in and the hotkey no
  longer drop `announceQueue` (agent answers waiting to be read); only dismiss does.
- `configure` sends the enabled agents' names as `vocabulary`; the helper adds them and "ask X"/"and X"
  phrases to the recognizer's `contextualStrings`.
- Talking: `inputMode` (default `review`) is what a click and the main hotkey do; the second hotkey
  (`reviewHotkey`) does the other mode. `liveTalk` in index.ts is true only for live conversations:
  follow-up listening and listening while Watson speaks (barge-in) happen only then. Dictated requests
  get a spoken answer and the mic goes off. `ui:talkLive` sends the draft (if any) and goes live.
- "Hey Watson" (`wakeWord`, off by default): helper `wake.start`/`wake.stop` run an on-device-only
  recognition session that emits `{ev:"wake"}` and nothing else (no partials, no levels), restarted
  every 50 s, ignored while Watson speaks. `syncWake()` starts it whenever Watson is idle; any real
  listen replaces it. If on-device recognition is missing, the setting turns itself off with a notice.
- Right-click on the pill: native menu (`pill:menu`). Dashboard tabs: Conversation, AI agents, Widgets
  (`recentWidgets` in Home.tsx: newest block per place/symbol/type from history turns).
- Questions from an AI: `brain.summarize` has an extra `offer_choices` tool → `choices` block
  (`ChoicesCard`); `runOne` stamps it with the agent, and `agent:reply` sends the pick with
  `newChat: false`. Every finished hand-off calls `deps.answered`: `brain.noteHandoff` (clipped answer in
  the short conversation memory, so "2" makes sense) and a history turn with `you: ''`.
- `tucked`: true while the dashboard window has focus (and on `openWindow`); the overlay stays a pill when
  idle. Opening the dashboard ends live talk. The hotkey clears `tucked`.
- `ax.send` gives an app that wasn't running more time to launch (30 s to come forward, 15 s for its box).
