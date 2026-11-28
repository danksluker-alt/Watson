// Text helpers for hand-offs, kept free of Electron so they can be unit-tested.

/** An earlier answer passed along with a request ("send that to Claude"). */
export type Attachment = { from: string; text: string }

const ATTACH_MAX = 12_000

/** "Claude and Grok", "Claude, Grok and Codex". */
export const joinNames = (names: string[]) => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/** The prompt actually typed: the request, then the earlier answer it refers to. */
export function withAttachment(prompt: string, attach?: Attachment): string {
  if (!attach?.text.trim()) return prompt
  const text = attach.text.length > ATTACH_MAX ? `${attach.text.slice(0, ATTACH_MAX)}\n[…cut for length]` : attach.text
  return `${prompt}\n\n---\nHere is the earlier answer from ${attach.from}:\n\n${text}`
}

/** Reads the comparison JSON; if the model didn't follow the format, its text is still used. */
export function parseComparison(raw: string, agents: string[]): { spoken: string; takeaways: { agent: string; text: string }[] } {
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)
  try {
    const d = JSON.parse(json) as { spoken?: unknown; takeaways?: unknown }
    const takeaways = Array.isArray(d.takeaways)
      ? d.takeaways
          .filter((t): t is { agent: string; text: string } => typeof t?.agent === 'string' && typeof t?.text === 'string')
          .map((t) => ({ agent: agents.find((a) => a.toLowerCase() === t.agent.toLowerCase()) ?? t.agent, text: t.text.trim() }))
      : []
    if (typeof d.spoken === 'string' && d.spoken.trim()) return { spoken: d.spoken.trim(), takeaways }
  } catch {
    /* not JSON: fall through */
  }
  return { spoken: raw.replace(/[{}"]/g, '').trim() || `${agents.join(' and ')} both answered. The answers are side by side.`, takeaways: [] }
}
