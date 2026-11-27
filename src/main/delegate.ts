// Hand-offs: Watson types your request into another AI app (Claude, ChatGPT, ...)
// the way a dictation tool would, watches that app's window until the answer
// stops changing, then summarizes it for you. It uses that app's own account,
// plan and connectors, so a hand-off costs Watson only the short summary.
//
// Every hand-off starts with something you said. Watson never loops on its own.
import type { DelegationData, Panel } from '@shared/types'
import { extractReply } from './extract'
import type { Helper } from './helper'
import { getSettings } from './settings'
import type { Store } from './store'

type Snapshot = { lines: string[]; busy: boolean }

type Deps = {
  helper: Helper
  store: Store
  confirm: (title: string, body: string, actionLabel: string) => Promise<boolean>
  summarize: (agentName: string, prompt: string, reply: string) => Promise<{ spoken: string; panel: Panel | null }>
  announce: (spoken: string, panel: Panel | null) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RISKY = /\b(send|reply|forward|post|publish|tweet|delete|remove|trash|cancel|buy|purchase|order|pay|transfer|merge|deploy|push)\b/i

export class Delegations {
  private seq = 0

  constructor(private deps: Deps) {}

  private update(jobId: string, patch: Partial<DelegationData>) {
    const { store } = this.deps
    store.set({ jobs: store.state.jobs.map((j) => (j.jobId === jobId ? { ...j, ...patch } : j)) })
  }

  /** Called from the brain's tool. Returns a short note for the model; the job continues in the background. */
  async start(agentId: string, prompt: string, sensitive: boolean): Promise<string> {
    const settings = getSettings()
    const agent = settings.agents.find((a) => a.id === agentId && a.enabled)
    if (!agent) throw new Error(`No enabled agent called ${agentId}. Enable it in Settings → Agents.`)
    if (!this.deps.helper.ready) throw new Error('Hand-offs need the voice helper running (npm run helper).')

    const jobId = `job${++this.seq}`
    const needsConfirm = sensitive || RISKY.test(prompt) || settings.confirmHandoffs
    const job: DelegationData = { jobId, agent: agent.name, prompt, status: needsConfirm ? 'confirming' : 'sending' }
    this.deps.store.set({ jobs: [...this.deps.store.state.jobs.slice(-4), job] })
    void this.run(jobId, agent.name, agent.bundleId, prompt, needsConfirm)
    return needsConfirm
      ? `Waiting for the user to confirm before sending to ${agent.name}. Ask them to say "send" or press Send.`
      : `Sent to ${agent.name}. Its answer will be summarized for the user when it arrives. Just tell them you've handed it to ${agent.name}.`
  }

  private async run(jobId: string, agentName: string, bundleId: string, prompt: string, needsConfirm: boolean) {
    const { helper, store } = this.deps
    const settings = getSettings()
    try {
      if (needsConfirm) {
        const ok = await this.deps.confirm(`Send this to ${agentName}?`, prompt, 'Send')
        if (!ok) {
          this.update(jobId, { status: 'failed', error: 'Cancelled' })
          return
        }
        this.update(jobId, { status: 'sending' })
      }

      const act = store.activity(`Typing your request into ${agentName}`)
      const before = await helper
        .request<Snapshot>('ax.snapshot', { bundleId }, 8000)
        .then((s) => s.lines)
        .catch(() => [] as string[])
      await helper.request('ax.send', { bundleId, text: prompt, submit: true, returnFocus: settings.returnFocusAfterHandoff }, 30_000)
      store.finishActivity(act, 'done', `Sent to ${agentName}`)
      this.update(jobId, { status: 'waiting' })

      const reply = await this.waitForReply(jobId, bundleId, before, prompt, agentName)
      this.update(jobId, { status: 'reading', reply })
      const read = store.activity(`Reading ${agentName}'s answer`)
      const { spoken, panel } = await this.deps.summarize(agentName, prompt, reply)
      store.finishActivity(read, 'done')
      this.update(jobId, { status: 'done', summary: spoken })
      const job = store.state.jobs.find((j) => j.jobId === jobId)
      const blocks = [...(panel?.blocks ?? []), ...(job ? [{ type: 'delegation' as const, data: job }] : [])]
      this.deps.announce(`${agentName} answered. ${spoken}`, { title: panel?.title ?? `From ${agentName}`, subtitle: panel?.subtitle, blocks })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.update(jobId, { status: 'failed', error: message })
      this.deps.announce(`The hand-off to ${agentName} didn't work. ${message}`, null)
    }
  }

  private async waitForReply(jobId: string, bundleId: string, before: string[], prompt: string, agentName: string): Promise<string> {
    const { helper } = this.deps
    const started = Date.now()
    let last = ''
    let stableSince = Date.now()
    let failures = 0
    while (Date.now() - started < 20 * 60_000) {
      await sleep(2000)
      let snap: Snapshot
      try {
        snap = await helper.request<Snapshot>('ax.snapshot', { bundleId }, 10_000)
        failures = 0
      } catch (e) {
        if (++failures > 5) throw e
        continue
      }
      const reply = extractReply(before, snap.lines, prompt)
      if (reply !== last) {
        last = reply
        stableSince = Date.now()
        if (reply) this.update(jobId, { status: 'waiting', reply: reply.slice(-600) })
        continue
      }
      const stableFor = Date.now() - stableSince
      if (reply && !snap.busy && stableFor >= 5000) return reply
      if (reply && stableFor >= 60_000) return reply // the "Stop" button never went away
    }
    if (last) return last
    throw new Error(`${agentName} didn't answer within 20 minutes.`)
  }
}
