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
  /^(claude )?(sonnet|opus|haiku|fable) [\d.]+( (low|medium|high|max|extended))?$/i,
  /^(chat mode|this computer|loading\.*|navigation)$/i,
  /^claude is ai and can make mistakes/i,
  /^\w+ (finished|stopped) the response$/i,
  /^newest document available to open/i,
  /^use the up and down arrow keys/i,
  /^((today|yesterday|mon|tue|wed|thu|fri|sat|sun)\w*,? )?\d{1,2}:\d{2}( ?[ap]m)?$/i,
  /^[\w .'-]{1,24} (replied|responded|is typing…?)$/i,
]

// Screen-reader copies of each message ("You said: …", "Claude responded: …"); the visible copy follows.
const SPOKEN_COPY = /^(you said|claude responded|chatgpt said|grok said|assistant said):\s/i

/**
 * Chat apps put a sender label over each message ("You", "Atlas"). A label is a short name that
 * the app also uses in "<name> replied", or that repeats on its own line.
 */
function speakerLabels(lines: string[]): Set<string> {
  const labels = new Set<string>(['you'])
  const counts = new Map<string, number>()
  for (const raw of lines) {
    const l = raw.trim()
    const m = /^([\w .'-]{1,24}) (replied|responded)$/i.exec(l)
    if (m) labels.add(m[1].toLowerCase())
    if (/^[A-Z][\w'-]*( [A-Z][\w'-]*)?$/.test(l)) counts.set(l.toLowerCase(), (counts.get(l.toLowerCase()) ?? 0) + 1)
  }
  for (const [name, n] of counts) if (n >= 3) labels.add(name)
  return labels
}

export function cleanLines(lines: string[]): string[] {
  const labels = speakerLabels(lines)
  return lines.map((l) => l.trim()).filter((l) => l && !SPOKEN_COPY.test(l) && !labels.has(l.toLowerCase()) && !CHROME.some((re) => re.test(l)))
}

/**
 * Apps split a paragraph at bold words and links ("Click" / "Open Settings" / "."). Join pieces back
 * into sentences: punctuation-only pieces always attach; other pieces attach when the line before
 * doesn't end a sentence and either side is a short fragment or the piece starts in lowercase.
 */
/** Lines that are code, which must keep their own line: fences, tags, braces, statements. */
const CODE = /^(```|~~~)|^\s{2,}\S|^[<{}[\]]|[;{}]$|=>|^(const|let|var|function|import|export|return|def|class|if|for|while|async|await|#include|SELECT|FROM)\b/

export function joinInline(lines: string[]): string[] {
  const out: string[] = []
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length
  let fenced = false
  let prevCode = false
  for (const line of lines) {
    const prev = out[out.length - 1]
    // Code stays exactly as it is, line by line.
    const fence = /^(```|~~~)/.test(line.trim())
    const code = fence || fenced || CODE.test(line)
    if (fence) fenced = !fenced
    if (code || prevCode) {
      out.push(line)
      prevCode = code
      continue
    }
    prevCode = false
    if (prev !== undefined) {
      if (/^[.,;:!?)\]”’"'…]+$/.test(line)) {
        out[out.length - 1] = prev + line
        continue
      }
      const open = !/[.!?:…]["”’)]?$/.test(prev) && !/^(#|[-*•]|\d+[.)])\s/.test(line)
      if (open && (/^[a-z,;)]/.test(line) || words(line) <= 3 || words(prev) <= 3)) {
        out[out.length - 1] = `${prev}${/^[,;:.)]/.test(line) ? '' : ' '}${line}`
        continue
      }
    }
    out.push(line)
  }
  return out
}

/**
 * Find where our prompt appears in the new snapshot and return what follows.
 * `found` says whether the prompt itself was on screen (used to pick the right window).
 */
export function findReply(before: string[], after: string[], prompt: string): { found: boolean; reply: string } {
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
    return { found: true, reply: joinInline(lines.slice(end + 1)).join('\n').trim() }
  }

  // Fallback: anything that wasn't on screen before.
  const seen = new Set(cleanLines(before).map(norm))
  const fresh = lines.filter((l) => !seen.has(norm(l)) && !p.includes(norm(l)))
  return { found: false, reply: joinInline(fresh).join('\n').trim() }
}

export function extractReply(before: string[], after: string[], prompt: string): string {
  return findReply(before, after, prompt).reply
}

export type WindowSnapshot = { title: string; lines: string[]; busy: boolean }

/** Pick the window that holds our conversation (browsers can have several) and read the reply from it. */
export function replyFromWindows(before: WindowSnapshot[], after: WindowSnapshot[], prompt: string): { reply: string; busy: boolean; found: boolean } {
  const beforeLines = (title: string) => before.find((w) => w.title === title)?.lines ?? before.flatMap((w) => w.lines)
  let fallback: { reply: string; busy: boolean; found: boolean } | null = null
  for (const w of after) {
    const r = findReply(beforeLines(w.title), w.lines, prompt)
    if (r.found) return { reply: r.reply, busy: w.busy, found: true }
    if (!fallback) fallback = { reply: r.reply, busy: w.busy, found: false }
  }
  return fallback ?? { reply: '', busy: false, found: false }
}
