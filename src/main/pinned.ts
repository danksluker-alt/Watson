// Pinned widgets: small floating windows you can put on any screen and drag
// anywhere. They remember where they are and refresh themselves.
import { BrowserWindow, screen, type Display } from 'electron'
import type { Block, PinnedWidget, WidgetKind } from '@shared/types'
import type { Helper } from './helper'
import { getSettings, updateSettings } from './settings'
import { buildWidget, REFRESH, type WidgetParams } from './widgets'

export type ScreenChoice = 'this' | 'main' | 'other' | number

type Entry = { widget: PinnedWidget; win: BrowserWindow; block: Block | null; updated: number }

const WIDTH = 380
const GAP = 16

export class PinnedWidgets {
  private entries = new Map<string, Entry>()
  private seq = 0
  private timer: NodeJS.Timeout | null = null

  constructor(
    private helper: Helper,
    private createWindow: (hash: string, opts: Electron.BrowserWindowConstructorOptions) => BrowserWindow,
  ) {}

  restore() {
    for (const w of getSettings().pinned) this.open(w)
    this.timer = setInterval(() => this.tick(), 5000)
  }

  list(): PinnedWidget[] {
    return [...this.entries.values()].map((e) => e.widget)
  }

  private persist() {
    updateSettings({ pinned: this.list() })
  }

  private pickDisplay(choice: ScreenChoice): Display {
    const all = screen.getAllDisplays()
    const cursor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const primary = screen.getPrimaryDisplay()
    if (typeof choice === 'number') return all[Math.max(0, Math.min(all.length - 1, choice - 1))] ?? cursor
    if (choice === 'main') return primary
    if (choice === 'other') return all.find((d) => d.id !== cursor.id) ?? cursor
    return cursor
  }

  async add(kind: WidgetKind, params: WidgetParams, choice: ScreenChoice = 'this'): Promise<string> {
    const display = this.pickDisplay(choice)
    // Pinning the same widget again moves it instead of duplicating it.
    for (const e of this.entries.values()) {
      if (e.widget.kind === kind && JSON.stringify(e.widget.params) === JSON.stringify(params)) {
        const { x, y } = this.slot(display, e.widget.id)
        e.win.setPosition(x, y, true)
        e.win.showInactive()
        this.savePosition(e)
        return e.widget.id
      }
    }
    const id = `w${Date.now().toString(36)}${++this.seq}`
    const { x, y } = this.slot(display)
    const widget: PinnedWidget = { id, kind, params, displayId: display.id, x, y }
    this.open(widget)
    this.persist()
    return id
  }

  /** The next free spot down the right edge of a display. */
  private slot(display: Display, ignore?: string) {
    const wa = display.workArea
    const taken = [...this.entries.values()].filter((e) => e.widget.id !== ignore && e.widget.displayId === display.id)
    const bottom = taken.reduce((max, e) => Math.max(max, e.win.getBounds().y + e.win.getBounds().height), wa.y)
    const y = taken.length ? bottom + GAP : wa.y + 24
    return { x: wa.x + wa.width - WIDTH - 24, y: Math.min(y, wa.y + wa.height - 200) }
  }

  private open(widget: PinnedWidget) {
    const displays = screen.getAllDisplays()
    const onScreen = displays.some((d) => {
      const b = d.workArea
      return widget.x !== undefined && widget.y !== undefined && widget.x >= b.x - 50 && widget.x < b.x + b.width && widget.y >= b.y - 50 && widget.y < b.y + b.height
    })
    const pos = onScreen ? { x: widget.x!, y: widget.y! } : this.slot(screen.getPrimaryDisplay())
    const win = this.createWindow(`widget=${widget.id}`, {
      ...pos,
      width: WIDTH,
      height: 220,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      type: 'panel',
      show: false,
    })
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    const entry: Entry = { widget, win, block: null, updated: 0 }
    this.entries.set(widget.id, entry)
    win.once('ready-to-show', () => win.showInactive())
    win.on('moved', () => this.savePosition(entry))
    win.on('closed', () => {
      if (this.entries.get(widget.id)?.win === win) {
        this.entries.delete(widget.id)
        this.persist()
      }
    })
    void this.refresh(entry)
  }

  private savePosition(e: Entry) {
    const b = e.win.getBounds()
    e.widget.x = b.x
    e.widget.y = b.y
    e.widget.displayId = screen.getDisplayMatching(b).id
    this.persist()
  }

  remove(id: string) {
    const e = this.entries.get(id)
    if (!e) return
    this.entries.delete(id)
    e.win.destroy()
    this.persist()
  }

  removeKind(kind: WidgetKind | 'all') {
    for (const e of [...this.entries.values()]) if (kind === 'all' || e.widget.kind === kind) this.remove(e.widget.id)
  }

  /** The renderer asks for data once it has loaded. */
  ready(id: string) {
    const e = this.entries.get(id)
    if (e) this.send(e)
  }

  resize(id: string, height: number) {
    const e = this.entries.get(id)
    if (!e) return
    const b = e.win.getBounds()
    if (Math.abs(b.height - height) > 1) e.win.setBounds({ ...b, height: Math.ceil(height) })
  }

  /** Replace matching blocks (after a control such as a stock range or play/pause). */
  update(match: (b: Block) => boolean, next: Block, params?: WidgetParams) {
    for (const e of this.entries.values()) {
      if (e.block && match(e.block)) {
        e.block = next
        if (params) {
          e.widget.params = { ...e.widget.params, ...params }
          this.persist()
        }
        this.send(e)
      }
    }
  }

  private send(e: Entry) {
    if (!e.win.isDestroyed()) e.win.webContents.send('widget', { id: e.widget.id, block: e.block })
  }

  private async refresh(e: Entry) {
    e.updated = Date.now()
    try {
      e.block = await buildWidget(this.helper, e.widget.kind, e.widget.params)
      this.send(e)
    } catch (err) {
      console.warn(`[watson] widget ${e.widget.kind}:`, err instanceof Error ? err.message : err)
    }
  }

  private tick() {
    const now = Date.now()
    for (const e of this.entries.values()) {
      if (now - e.updated >= REFRESH[e.widget.kind] * 1000) void this.refresh(e)
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }
}
