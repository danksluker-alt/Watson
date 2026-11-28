// Fetch with a time limit and one quiet retry, for the free data services (weather, stocks).
// A brief network hiccup shouldn't turn into "I couldn't get the weather".

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function fetchRetry(url: string, init: RequestInit = {}, { timeoutMs = 7000, tries = 2 } = {}): Promise<Response> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      // Server hiccups are worth one more try too; "not found" and the like are not.
      if (res.status >= 500 && i < tries - 1) {
        last = new Error(`HTTP ${res.status}`)
      } else return res
    } catch (e) {
      last = e
    }
    if (i < tries - 1) await sleep(600)
  }
  const offline = last instanceof Error && /fetch failed|ENOTFOUND|ENETUNREACH|ECONNREFUSED|EAI_AGAIN|timeout|aborted/i.test(`${last.message} ${(last as { cause?: Error }).cause?.message ?? ''}`)
  throw new Error(offline ? 'I can’t reach the internet right now. Check your Wi-Fi and try again.' : last instanceof Error ? last.message : String(last))
}
