// Turns streamed text into whole sentences for the voice, so Watson starts
// talking after the first sentence instead of waiting for the full answer.

export function forSpeech(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/[*_~>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export class Speaker {
  private buf = ''

  constructor(private say: (sentence: string) => void) {}

  push(delta: string) {
    this.buf += delta
    for (;;) {
      const re = /[.!?…:;](?=\s)|\n/g
      let cut = -1
      let m: RegExpExecArray | null
      while ((m = re.exec(this.buf))) {
        if (m[0] === '\n' || m.index + 1 >= 24) {
          cut = m.index + 1
          break
        }
      }
      if (cut < 0) return
      const sentence = this.buf.slice(0, cut)
      this.buf = this.buf.slice(cut)
      this.out(sentence)
    }
  }

  flush() {
    const rest = this.buf
    this.buf = ''
    this.out(rest)
  }

  private out(s: string) {
    const clean = forSpeech(s)
    if (/[\p{L}\p{N}]/u.test(clean)) this.say(clean)
  }
}
