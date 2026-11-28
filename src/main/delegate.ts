// Hand-offs: Watson types your request into another AI — a Mac app (Claude,
// ChatGPT) or a chat website in your browser (Grok, Gemini, Perplexity…) —
// the way a dictation tool would. It watches that window until the answer
// stops changing, then summarizes it for you. The work runs on that service's
// own account, plan and connectors, so a hand-off costs Watson only the summary.
//
// Every hand-off starts with something you said. Watson never loops on its own.
import type { AgentTarget, CompareData, DelegationData, Panel } from '@shared/types'
import { replyFromWindows, type WindowSnapshot } from './extract'
import { joinNames, withAttachment, type Attachment } from './handoffText'

export { joinNames }
import type { Helper } from './helper'
import { getSettings } from './settings'
import type { Store } from './store'

type Deps = {
  helper: Helper
  store: Store
  confirm: (title: string, body: string, actionLabel: string) => Promise<boolean>
  summarize: (agentName: string, prompt: string, reply: string) => Promise<{ spoken: string; panel: Panel | null }>
  compare: (prompt: string, answers: { agent: string; reply: string }[]) => Promise<{ spoken: string; takeaways: { agent: string; text: string }[] }>
  /** A finished comparison, for the history. */
  compared: (c: CompareData) => void
  announce: (spoken: string, panel: Panel | null) => void
  /** An AI's answer came back: kept in the chat history and in Watson's short memory. */
  answered: (a: { agent: string; prompt: string; reply: string; spoken: string; panel: Panel | null }) => void
}

export type StartOptions = {
  /** The user read the exact text and pressed Send, so no second confirmation. */
  reviewed?: boolean
  /** Start a new conversation instead of continuing the current one. */
  newChat?: boolean
  /** An earlier answer to pass along ("send that to Claude and…"). */
  attach?: Attachment
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// "Reply with one word" is an instruction to the AI; "reply to Sarah" sends something.
const RISKY = /\b(send|reply (to|all)|forward|post|publish|tweet|delete|remove|trash|cancel|buy|purchase|order|pay|transfer|merge|deploy|push)\b/i

export function findAgent(idOrName: string): AgentTarget | undefined {
  const q = idOrName.trim().toLowerCase()
  const agents = getSettings().agents.filter((a) => a.enabled)
  return agents.find((a) => a.id === q) ?? agents.find((a) => a.name.toLowerCase() === q) ?? agents.find((a) => a.name.toLowerCase().startsWith(q))
}

export class Delegations {
  private seq = 0
  /** Typing goes into one app at a time; waiting for answers happens side by side. */
  private sending: Promise<unknown> = Promise.resolve()

  constructor(private deps: Deps) {}

  private oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sending.then(fn, fn)
    this.sending = run.catch(() => undefined)
    return run
  }

  private update(jobId: string, patch: Partial<DelegationData>) {
    const { store } = this.deps
    if (patch.status === 'done' || patch.status === 'failed') patch = { endedAt: Date.now(), ...patch }
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

  private job(id: string) {
    return this.deps.store.state.jobs.find((j) => j.jobId === id)
  }

  private newJobs(agents: AgentTarget[], prompt: string, needsConfirm: boolean, extra: Partial<DelegationData>): DelegationData[] {
    const jobs = agents.map(
      (agent): DelegationData => ({
        jobId: `job${Date.now().toString(36)}${++this.seq}`,
        agentId: agent.id,
        agent: agent.name,
        prompt,
        status: needsConfirm ? 'confirming' : 'sending',
        startedAt: Date.now(),
        ...extra,
      }),
    )
    const keep = Math.max(5, jobs.length + 2)
    this.deps.store.set({ jobs: [...this.deps.store.state.jobs, ...jobs].slice(-keep) })
    return jobs
  }

  private preflight(agentId: string): AgentTarget {
    const agent = findAgent(agentId)
    if (!agent) throw new Error(`No enabled agent called ${agentId}. Turn it on in Settings → Agents.`)
    if (!this.deps.helper.ready) throw new Error('Hand-offs need the voice helper running (npm run helper).')
    return agent
  }

  /** Returns a short note for the model; the job continues in the background. */
  async start(agentId: string, prompt: string, sensitive: boolean, opts: StartOptions = {}): Promise<{ note: string; job: DelegationData }> {
    const agent = this.preflight(agentId)
    // Only the user's own words decide whether to ask first, not the answer passed along.
    const needsConfirm = !opts.reviewed && (sensitive || RISKY.test(prompt) || getSettings().confirmHandoffs)
    const [job] = this.newJobs([agent], prompt, needsConfirm, opts.attach ? { attachedFrom: opts.attach.from } : {})
    void this.runOne(job.jobId, agent, withAttachment(prompt, opts.attach), needsConfirm, opts.newChat ?? true)
    const note = needsConfirm
      ? `Not sent yet: nothing has been typed into ${agent.name}. Watson is showing the request with a Send button in its own panel. Ask the user to say "send" or press Send there.`
      : `Sent to ${agent.name}${opts.attach ? ` together with ${opts.attach.from}'s earlier answer` : ''}. Its answer will be summarized for the user when it arrives. Just tell them you've handed it to ${agent.name}.`
    return { note, job }
  }

  /** The same request to several AIs at once; their answers are compared when all are in. */
  async startGroup(agentIds: string[], prompt: string, sensitive: boolean, opts: StartOptions = {}): Promise<{ note: string; jobs: DelegationData[] }> {
    const agents = [...new Map(agentIds.map((id) => this.preflight(id)).map((a) => [a.id, a])).values()]
    if (agents.length < 2) {
      const { note, job } = await this.start(agents[0]?.id ?? agentIds[0], prompt, sensitive, opts)
      return { note, jobs: [job] }
    }
    const needsConfirm = !opts.reviewed && (sensitive || RISKY.test(prompt) || getSettings().confirmHandoffs)
    const groupId = `grp${Date.now().toString(36)}${++this.seq}`
    const jobs = this.newJobs(agents, prompt, needsConfirm, { groupId, ...(opts.attach ? { attachedFrom: opts.attach.from } : {}) })
    void this.runGroup(groupId, jobs, agents, prompt, withAttachment(prompt, opts.attach), needsConfirm)
    const names = joinNames(agents.map((a) => a.name))
    const note = needsConfirm
      ? `Not sent yet: Watson is showing the request with a Send button. Ask the user to say "send" or press Send.`
      : `Sent to ${names}. When they've all answered, Watson compares the answers for the user. Just tell them you've asked ${names} and will compare.`
    return { note, jobs }
  }

  private async snapshot(bundleId: string): Promise<WindowSnapshot[]> {
    const r = await this.deps.helper.request<{ windows: WindowSnapshot[] }>('ax.snapshot', { bundleId }, 12_000)
    return r.windows ?? []
  }

  /** Types the request into the agent and waits for its whole answer. */
  private async handOff(jobId: string, agent: AgentTarget, prompt: string, newChat: boolean): Promise<string> {
    const { helper, store } = this.deps
    const { sentTo, before } = await this.oneAtATime(async () => {
      const settings = getSettings()
      this.update(jobId, { status: 'sending' })
      const act = store.activity(agent.kind === 'web' ? `Opening ${agent.name} in your browser` : `Opening ${agent.name} and typing your request`)
      try {
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
              chatMenu: agent.kind === 'app' ? agent.chatMenu : undefined,
              text: prompt,
              submit: true,
              returnFocus: settings.returnFocusAfterHandoff,
            },
            90_000, // a closed app is launched first
          )
          sentTo = r.bundleId || readFrom
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          throw new Error(/front/i.test(msg) && agent.kind === 'app' ? `Couldn't open ${agent.name}. Is the app installed?` : msg)
        }
        store.finishActivity(act, 'done', `Sent to ${agent.name}`)
        return { sentTo, before }
      } catch (e) {
        store.finishActivity(act, 'error')
        throw e
      }
    })
    this.update(jobId, { status: 'waiting' })
    const reply = await this.waitForReply(jobId, sentTo, before, prompt, agent.name)
    this.update(jobId, { status: 'reading', reply })
    return reply
  }

  private async runOne(jobId: string, agent: AgentTarget, prompt: string, needsConfirm: boolean, newChat: boolean) {
    const { store } = this.deps
    let read: string | null = null
    try {
      if (needsConfirm) {
        const ok = await this.deps.confirm(`Send this to ${agent.name}?`, prompt, 'Send')
        if (!ok) {
          this.update(jobId, { status: 'failed', error: 'Cancelled' })
          return
        }
      }
      const reply = await this.handOff(jobId, agent, prompt, newChat)
      read = store.activity(`Reading ${agent.name}'s answer`)
      const { spoken, panel } = await this.deps.summarize(agent.name, prompt, reply)
      store.finishActivity(read, 'done')
      read = null
      this.update(jobId, { status: 'done', summary: spoken })
      const job = this.job(jobId)
      // Options to tap go back to this agent, in the same conversation.
      const extra = (panel?.blocks ?? []).map((b) => (b.type === 'choices' ? { ...b, data: { ...b.data, agentId: agent.id, agent: agent.name } } : b))
      const blocks = [...(job ? [{ type: 'delegation' as const, data: job }] : []), ...extra]
      const shown: Panel = { title: panel?.title ?? `From ${agent.name}`, subtitle: panel?.subtitle, blocks }
      this.deps.answered({ agent: agent.name, prompt, reply, spoken, panel: shown })
      this.deps.announce(`${agent.name} answered. ${spoken}`, shown)
    } catch (e) {
      if (read) store.finishActivity(read, 'error')
      const message = e instanceof Error ? e.message : String(e)
      this.update(jobId, { status: 'failed', error: message })
      this.deps.announce(`The hand-off to ${agent.name} didn't work. ${message}`, null)
    }
  }

  private async runGroup(groupId: string, jobs: DelegationData[], agents: AgentTarget[], shownPrompt: string, prompt: string, needsConfirm: boolean) {
    const { store } = this.deps
    const names = joinNames(agents.map((a) => a.name))
    if (needsConfirm) {
      const ok = await this.deps.confirm(`Send this to ${names}?`, prompt, 'Send to all')
      if (!ok) {
        for (const j of jobs) this.update(j.jobId, { status: 'failed', error: 'Cancelled' })
        return
      }
    }
    const results = await Promise.all(
      jobs.map((j, i) =>
        this.handOff(j.jobId, agents[i], prompt, true).then(
          (reply) => ({ agent: agents[i].name, jobId: j.jobId, reply }),
          (e: unknown) => {
            this.update(j.jobId, { status: 'failed', error: e instanceof Error ? e.message : String(e) })
            return null
          },
        ),
      ),
    )
    const answered = results.filter((r): r is NonNullable<typeof r> => Boolean(r?.reply.trim()))
    const failed = agents.filter((a) => !answered.some((r) => r.agent === a.name)).map((a) => a.name)
    const missing = failed.length ? ` ${joinNames(failed)} didn't answer.` : ''
    let read: string | null = null
    try {
      if (!answered.length) {
        this.deps.announce(`None of ${names} answered.${failed.length ? ' Check that the apps are open and signed in.' : ''}`, null)
        return
      }
      read = store.activity(answered.length > 1 ? `Comparing ${joinNames(answered.map((r) => r.agent))}` : `Reading ${answered[0].agent}'s answer`)
      const { spoken, takeaways } =
        answered.length > 1
          ? await this.deps.compare(shownPrompt, answered.map(({ agent, reply }) => ({ agent, reply })))
          : await this.deps.summarize(answered[0].agent, shownPrompt, answered[0].reply).then((r) => ({ spoken: r.spoken, takeaways: [{ agent: answered[0].agent, text: r.spoken }] }))
      store.finishActivity(read, 'done')
      read = null
      for (const r of answered) this.update(r.jobId, { status: 'done', summary: takeaways.find((t) => t.agent === r.agent)?.text })
      const data: CompareData = {
        groupId,
        prompt: shownPrompt,
        jobs: jobs.map((j) => this.job(j.jobId) ?? j),
        verdict: spoken,
        takeaways,
      }
      this.deps.compared(data)
      const panel: Panel = { title: `${joinNames(answered.map((r) => r.agent))} compared`, subtitle: shownPrompt, blocks: [{ type: 'compare', data }] }
      this.deps.answered({ agent: joinNames(answered.map((r) => r.agent)), prompt: shownPrompt, reply: answered.map((r) => `${r.agent}: ${r.reply.slice(0, 700)}`).join('\n\n'), spoken, panel })
      this.deps.announce(`${spoken}${missing}`, { title: `${joinNames(answered.map((r) => r.agent))} compared`, subtitle: shownPrompt, blocks: [{ type: 'compare', data }] })
    } catch (e) {
      if (read) store.finishActivity(read, 'error')
      const message = e instanceof Error ? e.message : String(e)
      for (const r of answered) this.update(r.jobId, { status: 'done' })
      this.deps.announce(`The answers are in, but I couldn't compare them. ${message}`, null)
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
