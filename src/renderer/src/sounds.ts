// Interface sounds, synthesized with Web Audio so there are no audio files.
// Soft and short, in the spirit of macOS system sounds.
let ctx: AudioContext | null = null

function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

function tone(freq: number, start: number, dur: number, gain = 0.07, type: OscillatorType = 'sine', glideTo?: number) {
  const a = audio()
  const t = a.currentTime + start
  const osc = a.createOscillator()
  const g = a.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur)
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(gain, t + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
  // A touch of shimmer: a quiet octave above.
  const osc2 = a.createOscillator()
  const g2 = a.createGain()
  osc2.type = 'sine'
  osc2.frequency.setValueAtTime(freq * 2, t)
  g2.gain.setValueAtTime(0, t)
  g2.gain.linearRampToValueAtTime(gain * 0.18, t + 0.01)
  g2.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.7)
  osc.connect(g).connect(a.destination)
  osc2.connect(g2).connect(a.destination)
  osc.start(t)
  osc2.start(t)
  osc.stop(t + dur + 0.05)
  osc2.stop(t + dur + 0.05)
}

export type Sound = 'listen' | 'done-listening' | 'sent' | 'arrived' | 'error' | 'ring'

export function play(sound: Sound) {
  try {
    switch (sound) {
      case 'listen':
        tone(880, 0, 0.16)
        tone(1318.5, 0.085, 0.22)
        break
      case 'done-listening':
        tone(1174.7, 0, 0.14, 0.05)
        tone(784, 0.07, 0.2, 0.05)
        break
      case 'sent':
        tone(660, 0, 0.22, 0.05, 'sine', 1320)
        break
      case 'arrived':
        tone(784, 0, 0.18, 0.06)
        tone(988, 0.09, 0.18, 0.06)
        tone(1318.5, 0.18, 0.32, 0.06)
        break
      case 'ring':
        // A bright three-note bell, like the Clock app's "Radial" but shorter.
        for (const [i, f] of [1046.5, 1318.5, 1568].entries()) tone(f, i * 0.16, 0.55, 0.09)
        tone(2093, 0.48, 0.7, 0.05)
        break
      case 'error':
        tone(330, 0, 0.18, 0.06, 'triangle')
        tone(262, 0.12, 0.26, 0.06, 'triangle')
        break
    }
  } catch {
    /* audio unavailable */
  }
}
