'use client'
import { useEffect, useState } from 'react'
import type { Answer } from '../lib/checks'
import { type Intent, readIntent } from '../lib/intent'
import { Bouncer, Said, canKnock, useKnock, waiting } from './Knock'
import { useVisitor } from './Visitor'
import { WorldWay, useWorld } from './World'

/**
 * One act, done with a knock, or with World ID and a wallet (D35): the brass button, then the bouncer's list ticked
 * as the club answers, and what came of it. The act is read as the club's server will read it, so a form that's
 * wrong says so before the Door opens or the wallet asks. Where knocking can't happen, on a phone or in a browser
 * without Web Serial, World ID is the brass button.
 */
export function Act({
  intent,
  label,
  worldLabel = 'Use World ID instead',
  then,
  list = true,
}: {
  intent: () => unknown
  label: string
  /** The brass button's words where knocking can't happen */
  worldLabel?: string
  then?: (a: Answer) => void
  /** Show the bouncer's list once a knock or a proof is on its way */
  list?: boolean
}) {
  const k = useKnock()
  const w = useWorld()
  const visitor = useVisitor()
  const [able, setAble] = useState(true)
  const [wrong, setWrong] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const [way, setWay] = useState<'knock' | 'world'>('knock')
  useEffect(() => setAble(canKnock()), [])

  function read(): Intent | null {
    const i = readIntent(intent())
    if ('why' in i) {
      setWrong(i.why)
      return null
    }
    setWrong(null)
    return i as Intent
  }

  function knock() {
    const i = read()
    if (!i) return
    w.cancel()
    setWay('knock')
    setRound((r) => r + 1)
    k.run(i, then)
  }

  function world() {
    const i = read()
    if (!i) return
    setWay('world')
    setRound((r) => r + 1)
    w.begin(i, then)
  }

  const instead = visitor?.world ? 'Or prove it in World App' : 'Or use World ID and a wallet'
  return (
    <div className="act">
      {able ? (
        <>
          <button type="button" className="knocker" onClick={knock} disabled={k.busy || w.busy}>
            {waiting(k.phase) ?? label}
          </button>
          <button type="button" className="text-btn instead" onClick={world} disabled={k.busy || w.busy}>
            {instead}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="knocker" onClick={world} disabled={w.busy}>
            {worldLabel}
          </button>
          <p className="hint">Or knock with your Wedgie, from Chrome, Edge or another Chromium browser on a computer.</p>
        </>
      )}
      {wrong ? (
        <p className="said" role="alert">
          {wrong}
        </p>
      ) : null}
      {way === 'world' ? (
        <WorldWay w={w} list={list} round={round} />
      ) : (
        <>
          {list && round > 0 ? <Bouncer answer={k.answer} act={k.act} round={round} /> : null}
          <Said answer={k.answer} />
        </>
      )}
    </div>
  )
}
