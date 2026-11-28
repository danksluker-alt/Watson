// A question one of your AIs asked: tap one option (or several), add a note if you like, and send
// it back to that AI in the same conversation. Or press the mic and say it.
import { useState } from 'react'
import type { ChoicesData } from '@shared/types'
import { ArrowUp, Check, Mic } from '../components/Icons'

export function ChoicesCard({ data }: { data: ChoicesData }) {
  const [picked, setPicked] = useState<number[]>([])
  const [note, setNote] = useState('')
  const [sent, setSent] = useState(false)
  const toggle = (i: number) => {
    if (sent) return
    setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : data.multiple ? [...p, i].sort((a, b) => a - b) : [i]))
  }
  const message = () => {
    const chosen = picked.map((i) => `${i + 1}. ${data.options[i].title}`)
    const head = chosen.length ? `${chosen.length > 1 ? 'I choose these' : 'I choose'}: ${chosen.join('; ')}.` : ''
    return [head, note.trim()].filter(Boolean).join(' ')
  }
  const canSend = Boolean(data.agentId) && !sent && (picked.length > 0 || note.trim().length > 0)
  const send = () => {
    if (!canSend || !data.agentId) return
    window.watson.replyToAgent(data.agentId, message())
    setSent(true)
  }

  return (
    <div className="card choices">
      {data.question && <div className="choices-q">{data.question}</div>}
      {sent && <div className="choices-hint">Sent to {data.agent ?? 'the AI'}</div>}
      <div className="choices-list" role={data.multiple ? 'group' : 'radiogroup'}>
        {data.options.map((o, i) => {
          const on = picked.includes(i)
          return (
            <button key={i} className={on ? 'choice on' : 'choice'} onClick={() => toggle(i)} role={data.multiple ? 'checkbox' : 'radio'} aria-checked={on} disabled={sent && !on}>
              <span className="choice-mark">{on ? <Check size={12} /> : i + 1}</span>
              <span className="choice-text">
                <span className="choice-title">{o.title}</span>
                {o.detail && <span className="choice-detail">{o.detail}</span>}
              </span>
            </button>
          )
        })}
      </div>
      {!sent && data.agentId && (
        <div className="choices-send">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            onFocus={() => window.watson.focus()}
            placeholder="Add a note"
            spellCheck
          />
          <button className="icon-btn" onClick={() => window.watson.toggleListen()} aria-label="Say it instead" title="Say it instead">
            <Mic size={15} />
          </button>
          <button className="btn primary" onClick={send} disabled={!canSend}>
            Send to {data.agent ?? 'AI'} <ArrowUp size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
