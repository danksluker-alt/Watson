// Hand-offs: Watson types your request into another AI — a Mac app (Claude,
// ChatGPT) or a chat website in your browser (Grok, Gemini, Perplexity…) —
// the way a dictation tool would. It watches that window until the answer
// stops changing, then summarizes it for you. The work runs on that service's
// own account, plan and connectors, so a hand-off costs Watson only the summary.
//
// Every hand-off starts with something you said. Watson never loops on its own.
import type { AgentTarget, DelegationData, Panel } from '@shared/types'
import { replyFromWindows, type WindowSnapshot } from './extract'
import type { Helper } from './helper'
import { getSettings } from './settings'
import type { Store } from './store'

type Deps = {
  helper: Helper
  store: Store
  confirm: (title: string, body: string, actionLabel: string) => Promise<boolean>
  summarize: (agentName: string, prompt: string, reply: string) => Promise<{ spoken: string; panel: Panel | null }>
  announce: (spoken: string, panel: Panel | null) => void
}

export type StartOptions = {
  /** The user read the exact text and pressed Send, so no second confirmation. */
  reviewed?: boolean
  /** Start a new conversation instead of continuing the current one. */
  newChat?: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const RISKY = /\b(send|reply|forward|post|publish|tweet|delete|remove|trash|cancel|buy|purchase|order|pay|transfer|merge|deploy|push)\b/i

export function findAgent(idOrName: string): AgentTarget | undefined {
  const q = idOrName.trim().toLowerCase()
  const agents = getSettings().agents.filter((a) => a.enabled)
  return agents.find((a) => a.id === q) ?? agents.find((a) => a.name.toLowerCase() === q) ?? agents.find((a) => a.name.toLowerCase().startsWith(q))
}

export class Delegations {
  private seq = 0

  constructor(private deps: Deps) {}

  private update(jobId: string, patch: Partial<DelegationData>) {
    const { store } = this.deps
    store.set({ jobs: store.state.jobs.map((j) => (j.jobId === jobId ? { ...j, ...patch } : j)) })
    // Keep a delegation card in the panel in sync too.
    const panel = store.state.panel
    if (panel?.blocks.some((b) => b.type === 'delegation' && b.data.jobId === jobId)) {
      const job = store.state.jobs.find((j) => j.jobId === jobId)
      if (job) {
        store.set({
          panel: { ...panel, blocks: panel.blocks.map((b) => (b.type === 'delegation' && b.data.jobId === jobId ? { type: 'delegation', data: job } : b)) },
        })
      }
    }
  }

  /** Returns a short note for the model; the job continues in the background. */
  async start(agentId: string, prompt: string, sensitive: boolean, opts: StartOptions = {}): Promise<{ note: string; job: DelegationData }> {
    const settings = getSettings()
    const agent = findAgent(agentId)
    if (!agent) throw new Error(`No enabled agent called ${agentId}. Turn it on in Settings → Agents.`)
    if (!this.deps.helper.ready) throw new Error('Hand-offs need the voice helper running (npm run helper).')

    const jobId = `job${++this.seq}`
    const needsConfirm = !opts.reviewed && (sensitive || RISKY.test(prompt) || settings.confirmHandoffs)
    const job: DelegationData = { jobId, agentId: agent.id, agent: agent.name, prompt, status: needsConfirm ? 'confirming' : 'sending' }
    this.deps.store.set({ jobs: [...this.deps.store.state.jobs.slice(-4), job] })
    void this.run(jobId, agent, prompt, needsConfirm, opts.newChat ?? true)
    const note = needsConfirm
      ? `Waiting for the user to confirm before sending to ${agent.name}. Ask them to say "send" or press Send.`
      : `Sent to ${agent.name}. Its answer will be summarized for the user when it arrives. Just tell them you've handed it to ${agent.name}.`
    return { note, job }
  }

  private async snapshot(bundleId: string): Promise<WindowSnapshot[]> {
    const r = await this.deps.helper.request<{ windows: WindowSnapshot[] }>('ax.snapshot', { bundleId }, 12_000)
    return r.windows ?? []
  }

  private async run(jobId: string, agent: AgentTarget, prompt: string, needsConfirm: boolean, newChat: boolean) {
    const { helper, store } = this.deps
    const settings = getSettings()
    try {
      if (needsConfirm) {
        const ok = await this.deps.confirm(`Send this to ${agent.name}?`, prompt, 'Send')
        if (!ok) {
          this.update(jobId, { status: 'failed', error: 'Cancelled' })
          return
        }
        this.update(jobId, { status: 'sending' })
      }

      const act = store.activity(agent.kind === 'web' ? `Opening ${agent.name} in your browser` : `Typing your request into ${agent.name}`)
      // What was on screen before, so the reply can be told apart from old text.
      let readFrom = agent.bundleId ?? ''
      if (agent.kind === 'web') {
        readFrom = settings.browserBundleId || (await helper.request<{ bundleId: string }>('browser.default').then((r) => r.bundleId).catch(() => ''))
      }
      const before = readFrom ? await this.snapshot(readFrom).catch(() => [] as WindowSnapshot[]) : []

      let sentTo: string
      try {
        const r = await helper.request<{ bundleId: string }>(
          'ax.send',
          {
            bundleId: agent.kind === 'app' ? agent.bundleId : undefined,
            url: agent.kind === 'web' ? agent.url : undefined,
            browser: settings.browserBundleId,
            newChat,
            text: prompt,
            submit: true,
            returnFocus: settings.returnFocusAfterHandoff,
          },
          60_000,
        )
        sentTo = r.bundleId || readFrom
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(/front/i.test(msg) && agent.kind === 'app' ? `Couldn't open ${agent.name}. Is the app installed?` : msg)
      }
      store.finishActivity(act, 'done', `Sent to ${agent.name}`)
      this.update(jobId, { status: 'waiting' })

      const reply = await this.waitForReply(jobId, sentTo, before, prompt, agent.name)
      this.update(jobId, { status: 'reading', reply })
      const read = store.activity(`Reading ${agent.name}'s answer`)
      const { spoken, panel } = await this.deps.summarize(agent.name, prompt, reply)
      store.finishActivity(read, 'done')
      this.update(jobId, { status: 'done', summary: spoken })
      const job = store.state.jobs.find((j) => j.jobId === jobId)
      const blocks = [...(job ? [{ type: 'delegation' as const, data: job }] : []), ...(panel?.blocks ?? [])]
      this.deps.announce(`${agent.name} answered. ${spoken}`, { title: panel?.title ?? `From ${agent.name}`, subtitle: panel?.subtitle, blocks })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.update(jobId, { status: 'failed', error: message })
      this.deps.announce(`The hand-off to ${agent.name} didn't work. ${message}`, null)
    }
  }

  private async waitForReply(jobId: string, bundleId: string, before: WindowSnapshot[], prompt: string, agentName: string): Promise<string> {
    const started = Date.now()
    let last = ''
    let stableSince = Date.now()
    let failures = 0
    const poll = Number(process.env.WATSON_POLL_MS) || 2000
    while (Date.now() - started < 20 * 60_000) {
      await sleep(poll)
      let windows: WindowSnapshot[]
      try {
        windows = await this.snapshot(bundleId)
        failures = 0
      } catch (e) {
        if (++failures > 5) throw e
        continue
      }
      const { reply, busy } = replyFromWindows(before, windows, prompt)
      if (reply !== last) {
        last = reply
        stableSince = Date.now()
        if (reply) this.update(jobId, { status: 'waiting', reply: reply.slice(-600) })
        continue
      }
      const stableFor = Date.now() - stableSince
      if (reply && !busy && stableFor >= Math.max(2.5 * poll, 4000)) return reply
      if (reply && stableFor >= 60_000) return reply // the "Stop" button never went away
    }
    if (last) return last
    throw new Error(`${agentName} didn't answer within 20 minutes.`)
  }
}
