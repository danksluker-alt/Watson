// Everyday Mac controls: volume, mute, dark mode, sleeping the display. All reversible.
import { osascript, runOs } from './os'

export type MacAction = 'volume' | 'volume_up' | 'volume_down' | 'mute' | 'unmute' | 'dark_mode' | 'light_mode' | 'toggle_appearance' | 'sleep_display'

async function volume(): Promise<{ level: number; muted: boolean }> {
  const out = await osascript('set s to get volume settings\nreturn (output volume of s as text) & "," & (output muted of s as text)')
  const [level, muted] = out.split(',')
  return { level: Number(level) || 0, muted: muted?.trim() === 'true' }
}

export async function macControl(action: MacAction, level?: number): Promise<string> {
  switch (action) {
    case 'volume': {
      const v = Math.max(0, Math.min(100, Math.round(level ?? 50)))
      await osascript(`set volume output volume ${v} without output muted`)
      return `Volume set to ${v}%.`
    }
    case 'volume_up':
    case 'volume_down': {
      const cur = await volume()
      const v = Math.max(0, Math.min(100, cur.level + (action === 'volume_up' ? 1 : -1) * (level ?? 15)))
      await osascript(`set volume output volume ${v} without output muted`)
      return `Volume ${action === 'volume_up' ? 'up' : 'down'} to ${v}%.`
    }
    case 'mute':
      await osascript('set volume with output muted')
      return 'Muted.'
    case 'unmute': {
      await osascript('set volume without output muted')
      return `Unmuted. Volume is ${(await volume()).level}%.`
    }
    case 'dark_mode':
    case 'light_mode':
    case 'toggle_appearance': {
      const value = action === 'toggle_appearance' ? 'not dark mode' : action === 'dark_mode' ? 'true' : 'false'
      const out = await osascript(`tell application "System Events" to tell appearance preferences\nset dark mode to ${value}\nreturn dark mode as text\nend tell`)
      return out.trim() === 'true' ? 'Dark mode is on.' : 'Light mode is on.'
    }
    case 'sleep_display':
      await runOs('/usr/bin/pmset', ['displaysleepnow'])
      return 'Display is going to sleep. If your Mac asks for a password on wake, that also locks it.'
  }
}
