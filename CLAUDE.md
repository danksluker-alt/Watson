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
- Before committing: `npm run typecheck`, `npm test`, `npm run build`, and `npm run e2e:linux`
  (or `npm run e2e` on a Mac) when behaviour changes.
