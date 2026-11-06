'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { canKnock, useKnock, waiting } from './Knock'

/** Knock in from the bar: the club remembers this human for two weeks */
export function KnockIn() {
  const k = useKnock()
  const [able, setAble] = useState(true)
  useEffect(() => setAble(canKnock()), [])
  const why =
    k.answer && k.answer.kind !== 'in' && !(k.answer.kind === 'no-knock' && ['closed', 'rejected'].includes(k.answer.code))
      ? k.answer.why
      : null
  return (
    <span className="knock-in">
      <button type="button" className="knocker small" onClick={() => k.run({ act: 'in' })} disabled={k.busy || !able}>
        {waiting(k.phase) ?? 'Knock in'}
      </button>
      {!able ? <span className="hint">Knocking needs Chrome or Edge on a computer.</span> : null}
      {why ? (
        <span className="hint out" role="status">
          {why}
        </span>
      ) : null}
    </span>
  )
}

export function SignOut() {
  const router = useRouter()
  return (
    <button
      type="button"
      className="text-btn"
      onClick={async () => {
        await fetch('/api/signout', { method: 'POST' })
        router.refresh()
      }}
    >
      Leave
    </button>
  )
}
