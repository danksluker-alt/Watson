import { useState } from 'react'
import type { DelegationData } from '@shared/types'
import { Check, Chevron, Warning } from '../components/Icons'
import { Markdown } from '../components/Markdown'

const STATUS: Record<DelegationData['status'], string> = {
  confirming: 'Waiting for your OK',
  sending: 'Typing your request',
  waiting: 'Working on it',
  reading: 'Reading the answer',
  done: 'Answered',
  failed: 'Didn’t finish',
}

export function AgentMark({ name, small }: { name: string; small?: boolean }) {
  const key = name.toLowerCase().split(/[\s(]/)[0]
  return (
    <span className={small ? 'agent-mark small' : 'agent-mark'} data-agent={key}>
      {name.slice(0, 1)}
    </span>
  )
}

export function DelegationCard({ data }: { data: DelegationData }) {
  const [open, setOpen] = useState(false)
  const busy = !['done', 'failed'].includes(data.status)
  return (
    <div className="card delegation">
      <div className="delegation-head">
        <AgentMark name={data.agent} />
        <div className="delegation-title">
          <strong>{data.agent}</strong>
          <span className={`status ${data.status}`}>
            {busy ? <span className="spinner" /> : data.status === 'done' ? <Check size={12} /> : <Warning size={12} />}
            {STATUS[data.status]}
          </span>
        </div>
      </div>
      <div className="delegation-prompt">
        “{data.prompt}”{data.attachedFrom && <span className="delegation-attached"> + {data.attachedFrom}’s answer</span>}
      </div>
      {busy && data.status === 'waiting' && data.reply && <div className="delegation-live">{data.reply.trim().split('\n').filter(Boolean).pop()?.slice(-140)}</div>}
      {data.error && <div className="delegation-error">{data.error}</div>}
      {data.reply && data.status === 'done' && (
        <>
          <button className="disclosure" onClick={() => setOpen(!open)}>
            <Chevron size={12} open={open} /> {open ? 'Hide' : 'Show'} full answer
          </button>
          {open && (
            <div className="delegation-reply">
              <Markdown text={data.reply} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
