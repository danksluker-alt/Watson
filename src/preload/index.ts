import { contextBridge, ipcRenderer } from 'electron'
import type { WatsonAPI } from '@shared/types'

const api: WatsonAPI = {
  onState: (cb) => {
    const h = (_: unknown, s: Parameters<typeof cb>[0]) => cb(s)
    ipcRenderer.on('state', h)
    return () => ipcRenderer.removeListener('state', h)
  },
  getState: () => ipcRenderer.invoke('ui:getState'),
  onLevel: (cb) => {
    const h = (_: unknown, v: number) => cb(v)
    ipcRenderer.on('level', h)
    return () => ipcRenderer.removeListener('level', h)
  },
  setInteractive: (v) => ipcRenderer.send('ui:interactive', v),
  focus: () => ipcRenderer.send('ui:focus'),
  toggleListen: () => ipcRenderer.send('ui:toggleListen'),
  talkLive: (draft?: string) => ipcRenderer.send('ui:talkLive', draft ?? ''),
  pillMenu: () => ipcRenderer.send('pill:menu'),
  replyToAgent: (agentId: string, text: string) => ipcRenderer.send('agent:reply', agentId, text),
  openVoiceSettings: () => ipcRenderer.send('ui:openVoiceSettings'),
  ask: (text) => ipcRenderer.send('ui:ask', text),
  cancel: () => ipcRenderer.send('ui:cancel'),
  dismiss: () => ipcRenderer.send('ui:dismiss'),
  answerConfirm: (id, ok) => ipcRenderer.send('ui:confirm', id, ok),
  stockRange: (symbol, range) => ipcRenderer.send('widget:stockRange', symbol, range),
  music: (app, action) => ipcRenderer.send('widget:music', app, action),
  setCapture: (mode) => ipcRenderer.send('ui:setCapture', mode),
  dictate: (text) => ipcRenderer.send('ui:dictate', text),
  takeOver: (text) => ipcRenderer.send('ui:takeOver', text),
  draftText: (text) => ipcRenderer.send('ui:draftText', text),
  openDraft: () => ipcRenderer.send('ui:openDraft'),
  setMuted: (muted) => ipcRenderer.send('ui:setMuted', muted),
  removeAutomation: (id) => ipcRenderer.send('automation:remove', id),
  setAutomationEnabled: (id, enabled) => ipcRenderer.send('automation:enabled', id, enabled),
  submitDraft: (text, target) => ipcRenderer.send('ui:submitDraft', text, target),
  cancelDraft: () => ipcRenderer.send('ui:cancelDraft'),
  pin: (block) => ipcRenderer.send('ui:pin', block),
  onWidget: (cb) => {
    const h = (_: unknown, m: Parameters<typeof cb>[0]) => cb(m)
    ipcRenderer.on('widget', h)
    return () => ipcRenderer.removeListener('widget', h)
  },
  widgetReady: (id) => ipcRenderer.send('widget:ready', id),
  widgetSize: (id, w, h) => ipcRenderer.send('widget:size', id, w, h),
  closeWidget: (id) => ipcRenderer.send('widget:close', id),
  openSettings: () => ipcRenderer.send('ui:openSettings'),
  openExternal: (url) => ipcRenderer.send('ui:openExternal', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  secretStatus: () => ipcRenderer.invoke('secrets:status'),
  setSecret: (name, value) => ipcRenderer.invoke('secrets:set', name, value),
  voices: () => ipcRenderer.invoke('helper:voices'),
  runningApps: () => ipcRenderer.invoke('helper:apps'),
  permissions: () => ipcRenderer.invoke('helper:permissions'),
  requestPermissions: () => ipcRenderer.invoke('helper:requestPermissions'),
  openPrivacyPane: (pane) => ipcRenderer.send('helper:openPrivacy', pane),
  testVoice: (voiceId, gender) => ipcRenderer.send('ui:testVoice', voiceId, gender),
  installedApps: () => ipcRenderer.invoke('apps:installed'),
  openWindow: () => ipcRenderer.send('ui:openWindow'),
  getHistory: () => ipcRenderer.invoke('history:get'),
  onHistory: (cb) => {
    const h = (_: unknown, d: Parameters<typeof cb>[0]) => cb(d)
    ipcRenderer.on('history', h)
    return () => ipcRenderer.removeListener('history', h)
  },
  clearHistory: () => ipcRenderer.send('history:clear'),
  pillDrag: (phase) => ipcRenderer.send('pill:drag', phase),
  setPillShape: (shape) => ipcRenderer.send('pill:shape', shape),
  resetPillPlace: () => ipcRenderer.send('pill:reset'),
  setArranging: (on) => ipcRenderer.send('pill:arranging', on),
  cancelTimer: (id) => ipcRenderer.send('timer:cancel', id),
  stopRinging: () => ipcRenderer.send('timer:stopRinging'),
}

contextBridge.exposeInMainWorld('watson', api)
