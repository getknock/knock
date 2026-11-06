'use client'
import { useState } from 'react'
import { LIMITS } from '../../../lib/intent'
import { Act } from '../../Act'

export function Sign({ petition }: { petition: number }) {
  const [reason, setReason] = useState('')
  const [listed, setListed] = useState(false)
  return (
    <form className="form" onSubmit={(e) => e.preventDefault()}>
      <label>
        <span>Why you're signing, if you'd like to say</span>
        <textarea rows={3} maxLength={LIMITS.reason[1]} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} />
        <span>Show my name on my signature</span>
      </label>
      <Act label="Knock to sign" worldLabel="Sign with World ID" intent={() => ({ act: 'sign', petition, listed, reason })} />
      <p className="fine">Unnamed, your signature counts the same, and the club shows nothing that leads from it to you.</p>
    </form>
  )
}

/** For its starter: close it as won, or just close it */
export function Close({ petition }: { petition: number }) {
  const [outcome, setOutcome] = useState<'won' | 'closed'>('won')
  return (
    <form className="form close" onSubmit={(e) => e.preventDefault()}>
      <fieldset>
        <legend>You started this petition. Close it?</legend>
        <label className="check">
          <input type="radio" name="outcome" checked={outcome === 'won'} onChange={() => setOutcome('won')} />
          <span>It won</span>
        </label>
        <label className="check">
          <input type="radio" name="outcome" checked={outcome === 'closed'} onChange={() => setOutcome('closed')} />
          <span>Just close it</span>
        </label>
      </fieldset>
      <Act label="Knock to close it" worldLabel="Close it with World ID" intent={() => ({ act: 'close', petition, outcome })} list={false} />
    </form>
  )
}
