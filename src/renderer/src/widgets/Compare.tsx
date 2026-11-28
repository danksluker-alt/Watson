// Several AIs asked the same thing, side by side: Watson's read on top, one column per answer.
import { useState } from 'react'
import type { CompareData, DelegationData } from '@shared/types'
import { Check, Chevron, Warning } from '../components/Icons'
import { Markdown } from '../components/Markdown'
import { AgentMark } from './Delegation'

function Column({ job, takeaway, full }: { job: DelegationData; takeaway?: string; full?: string }) {
  const [open, setOpen] = useState(false)
  const ok = job.status === 'done'
  return (
    <div className={ok ? 'compare-col' : 'compare-col failed'}>
      <div className="compare-agent">
        <AgentMark name={job.agent} small />
        <strong>{job.agent}</strong>
        {ok ? <Check size={11} /> : <Warning size={11} />}
      </div>
      <div className="compare-take">{ok ? (takeaway ?? job.summary ?? 'Answered.') : (job.error ?? 'Didn’t answer.')}</div>
      {full && (
        <>
          <button className="disclosure" onClick={() => setOpen(!open)}>
            <Chevron size={12} open={open} /> {open ? 'Hide' : 'Full'} answer
          </button>
          {open && (
            <div className="compare-full">
              <Markdown text={full} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** `answers` supplies full replies when the card's own jobs don't carry them (the history keeps them apart). */
/** In the panel Watson already says the verdict above the card, so only the window shows it (`verdict`). */
export function CompareCard({ data, answers, verdict }: { data: CompareData; answers?: Record<string, string | undefined>; verdict?: boolean }) {
  return (
    <div className="card compare">
      {verdict && data.verdict && <div className="compare-verdict">{data.verdict}</div>}
      <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${Math.min(3, data.jobs.length)}, minmax(0, 1fr))` }}>
        {data.jobs.map((j) => (
          <Column key={j.jobId} job={j} takeaway={data.takeaways?.find((t) => t.agent === j.agent)?.text} full={j.reply ?? answers?.[j.jobId]} />
        ))}
      </div>
    </div>
  )
}
