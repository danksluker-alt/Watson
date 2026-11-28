// The single UI state object. Every change is pushed to the renderer.
import { EventEmitter } from 'node:events'
import type { Activity, UIState } from '@shared/types'

export class Store extends EventEmitter {
  state: UIState = {
    phase: 'idle',
    expanded: false,
    transcript: '',
    reply: '',
    activity: [],
    panel: null,
    jobs: [],
    confirm: null,
    error: null,
    notice: null,
    helperReady: false,
    hasApiKey: false,
    usageTodayUsd: 0,
    capture: 'live',
    draft: null,
    insertTarget: null,
    insertTargetName: null,
    agents: [],
    sounds: true,
    timers: [],
    ringing: null,
    layout: { centerX: 380, dir: 'down' },
    pillShape: 'pill',
    glance: {},
    arranging: false,
  }

  set(patch: Partial<UIState>) {
    this.state = { ...this.state, ...patch }
    this.emit('change', this.state)
  }

  private seq = 0

  activity(text: string): string {
    const id = `a${++this.seq}`
    const list: Activity[] = [...this.state.activity.slice(-3), { id, text, status: 'running' }]
    this.set({ activity: list })
    return id
  }

  removeActivity(id: string) {
    this.set({ activity: this.state.activity.filter((a) => a.id !== id) })
  }

  finishActivity(id: string, status: Activity['status'] = 'done', text?: string) {
    this.set({
      activity: this.state.activity.map((a) => (a.id === id ? { ...a, status, text: text ?? a.text } : a)),
    })
  }
}
