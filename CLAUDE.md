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
- Before committing: `npm run typecheck`, `npm test`, `npm run build`.
