// Recent requests and hand-offs, for the Watson window. Kept only on this Mac (history.json in the
// profile), capped in size, and cleared from Settings or the window.
import { app } from 'electron'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { Block, CompareData, DelegationData, HistoryData, HistoryTurn } from '@shared/types'

const MAX_TURNS = 300
const MAX_JOBS = 100
const MAX_COMPARES = 40
const file = () => path.join(app.getPath('userData'), 'history.json')

/** Widgets are rebuilt from live data, so only small blocks are worth keeping. */
function keepable(blocks: Block[] | undefined): Block[] | undefined {
  if (!blocks?.length) return undefined
  const small = blocks.filter((b) => JSON.stringify(b).length < 40_000)
  return small.length ? small : undefined
}

export class History extends EventEmitter {
  private data: HistoryData = { turns: [], jobs: [] }
  private saveTimer: NodeJS.Timeout | null = null

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(file(), 'utf8')) as HistoryData
      this.data = { turns: Array.isArray(d.turns) ? d.turns : [], jobs: Array.isArray(d.jobs) ? d.jobs : [], compares: Array.isArray(d.compares) ? d.compares : [] }
    } catch {
      this.data = { turns: [], jobs: [] }
    }
  }

  get(): HistoryData {
    return this.data
  }

  addTurn(t: Omit<HistoryTurn, 'id' | 'at'>) {
    if (!t.you.trim() && !t.watson.trim()) return
    this.data.turns = [...this.data.turns, { ...t, blocks: keepable(t.blocks), id: `h${Date.now().toString(36)}${this.data.turns.length}`, at: Date.now() }].slice(-MAX_TURNS)
    this.changed()
  }

  /** Hand-offs are updated as they move from sending to done. */
  upsertJob(job: DelegationData) {
    const i = this.data.jobs.findIndex((j) => j.jobId === job.jobId && j.prompt === job.prompt)
    const entry = { ...job, at: i >= 0 ? this.data.jobs[i].at : Date.now() }
    if (i >= 0) {
      if (JSON.stringify(this.data.jobs[i]) === JSON.stringify(entry)) return
      this.data.jobs[i] = entry
    } else this.data.jobs = [...this.data.jobs, entry].slice(-MAX_JOBS)
    this.changed()
  }

  /** A finished comparison. Its jobs are kept as hand-offs too; this adds the verdict. */
  addCompare(c: CompareData) {
    const jobs = c.jobs.map(({ reply: _r, ...j }) => j) // full answers live in the hand-offs already
    this.data.compares = [...(this.data.compares ?? []).filter((x) => x.groupId !== c.groupId), { ...c, jobs, at: Date.now() }].slice(-MAX_COMPARES)
    this.changed()
  }

  clear() {
    this.data = { turns: [], jobs: [], compares: [] }
    this.changed()
  }

  private changed() {
    this.emit('change', this.data)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(file()), { recursive: true })
        fs.writeFileSync(file(), JSON.stringify(this.data), { mode: 0o600 })
      } catch (e) {
        console.warn('[watson] could not save history:', e instanceof Error ? e.message : e)
      }
    }, 500)
  }
}

export const history = new History()
