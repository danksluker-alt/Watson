import { contextBridge, ipcRenderer } from 'electron'
import type { WatsonAPI } from '@shared/types'

const api: WatsonAPI = {
  onState: (cb) => {
    const h = (_: unknown, s: Parameters<typeof cb>[0]) => cb(s)
    ipcRenderer.on('state', h)
    return () => ipcRenderer.removeListener('state', h)
  },
  onLevel: (cb) => {
    const h = (_: unknown, v: number) => cb(v)
    ipcRenderer.on('level', h)
    return () => ipcRenderer.removeListener('level', h)
  },
  setInteractive: (v) => ipcRenderer.send('ui:interactive', v),
  focus: () => ipcRenderer.send('ui:focus'),
  toggleListen: () => ipcRenderer.send('ui:toggleListen'),
  ask: (text) => ipcRenderer.send('ui:ask', text),
  cancel: () => ipcRenderer.send('ui:cancel'),
  dismiss: () => ipcRenderer.send('ui:dismiss'),
  answerConfirm: (id, ok) => ipcRenderer.send('ui:confirm', id, ok),
  stockRange: (symbol, range) => ipcRenderer.send('widget:stockRange', symbol, range),
  spotify: (action) => ipcRenderer.send('widget:spotify', action),
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
  testVoice: () => ipcRenderer.send('ui:testVoice'),
}

contextBridge.exposeInMainWorld('watson', api)
