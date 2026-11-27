// Pulls the new reply out of an AI app's window text, given the text before
// we sent the prompt and the prompt itself. Pure, so it can be unit-tested.

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

// Buttons and footers that chat apps render around a reply.
const CHROME = [
  /^(copy|retry|edit|share|regenerate|good response|bad response|read aloud|more|stop|stop response)$/i,
  /^claude can make mistakes/i,
  /^chatgpt can make mistakes/i,
  /^grok can make mistakes/i,
  /^(reply to claude|message chatgpt|ask anything|ask grok|how can i help)/i,
  /^(sonnet|opus|haiku|fable) [\d.]+$/i,
  /^\d{1,2}:\d{2}( ?[ap]m)?$/i,
]

export function cleanLines(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter((l) => l && !CHROME.some((re) => re.test(l)))
}

/**
 * Find where our prompt appears in the new snapshot and return what follows.
 * Falls back to "lines that weren't there before".
 */
export function extractReply(before: string[], after: string[], prompt: string): string {
  const lines = cleanLines(after)
  const p = norm(prompt)
  const head = p.slice(0, 60)
  const tail = p.slice(-40)

  // Look for the last line that contains the start of our prompt.
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = norm(lines[i])
    if (l.includes(head) || (head.length > 20 && head.includes(l) && l.length > 20)) {
      start = i
      break
    }
  }
  if (start >= 0) {
    // Long prompts span several lines: skip forward to the line holding its end.
    let end = start
    for (let j = start; j < Math.min(lines.length, start + 40); j++) {
      if (norm(lines[j]).includes(tail)) {
        end = j
        break
      }
    }
    return lines.slice(end + 1).join('\n').trim()
  }

  // Fallback: anything that wasn't on screen before.
  const seen = new Set(cleanLines(before).map(norm))
  const fresh = lines.filter((l) => !seen.has(norm(l)) && !p.includes(norm(l)))
  return fresh.join('\n').trim()
}
