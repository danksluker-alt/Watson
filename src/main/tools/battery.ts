// Battery from `pmset -g batt`.
import type { BatteryData } from '@shared/types'
import { runOs } from './os'

export async function battery(): Promise<BatteryData> {
  const out = await runOs('/usr/bin/pmset', ['-g', 'batt'])
  const onAC = /AC Power/.test(out)
  const m = out.match(/(\d+)%;\s*([^;]+);\s*([^\n]*)/)
  if (!m) return { percent: null, charging: false, onAC, state: onAC ? 'Power adapter' : 'Unknown' }
  const state = m[2].trim()
  const remaining = m[3].match(/(\d+:\d+) remaining/)?.[1]
  return {
    percent: Number(m[1]),
    charging: /charging|finishing/.test(state) && !/discharging/.test(state),
    onAC,
    state: state.replace(/^./, (c) => c.toUpperCase()),
    timeRemaining: remaining && remaining !== '0:00' ? remaining : undefined,
  }
}
