'use client'
import { useEffect, useState } from 'react'
import type { Answer } from '../lib/checks'
import { type Intent, readIntent } from '../lib/intent'
import { Bouncer, Said, canKnock, useKnock, waiting } from './Knock'

/**
 * One act, done with a knock: the brass button, then the bouncer's list ticked as the verifier answers, and what
 * came of it. The act is read as the club's server will read it, so a form that's wrong says so before the Door
 * opens.
 */
export function Act({
  intent,
  label,
  then,
  list = true,
}: {
  intent: () => unknown
  label: string
  then?: (a: Answer) => void
  /** Show the bouncer's list once a knock is on its way */
  list?: boolean
}) {
  const k = useKnock()
  const [able, setAble] = useState(true)
  const [wrong, setWrong] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => setAble(canKnock()), [])

  function go() {
    const i = readIntent(intent())
    if ('why' in i) return setWrong(i.why)
    setWrong(null)
    setRound((r) => r + 1)
    k.run(i as Intent, then)
  }

  return (
    <div className="act">
      <button type="button" className="knocker" onClick={go} disabled={k.busy || !able}>
        {waiting(k.phase) ?? label}
      </button>
      {!able ? <p className="hint">Knocking needs Chrome, Edge or another Chromium browser on a computer.</p> : null}
      {wrong ? (
        <p className="said" role="alert">
          {wrong}
        </p>
      ) : null}
      {list && round > 0 ? <Bouncer answer={k.answer} act={k.act} round={round} /> : null}
      <Said answer={k.answer} />
    </div>
  )
}
