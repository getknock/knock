'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { Answer } from '../../lib/checks'
import { GOAL, LIMITS } from '../../lib/intent'
import { formatEther } from 'viem'
import { Act } from '../Act'

/** Where a new petition or fundraiser is, once the knock that started it got in */
function goTo(router: ReturnType<typeof useRouter>) {
  return (a: Answer) => {
    if (a.kind !== 'in') return
    if (a.done.act === 'start') router.push(`/p/${a.done.petition}`)
    if (a.done.act === 'raise') router.push(`/f/${a.done.fundraiser}`)
  }
}

export function StartPetition() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [target, setTarget] = useState('')
  const [body, setBody] = useState('')
  const [listed, setListed] = useState(false)
  return (
    <form className="form big" onSubmit={(e) => e.preventDefault()}>
      <label>
        <span>Title</span>
        <input value={title} maxLength={LIMITS.title[1]} onChange={(e) => setTitle(e.target.value)} placeholder="Keep the library open on Sundays" />
      </label>
      <label>
        <span>Who it's to</span>
        <input value={target} maxLength={LIMITS.target[1]} onChange={(e) => setTarget(e.target.value)} placeholder="The city council" />
      </label>
      <label>
        <span>What it asks, and why</span>
        <textarea rows={9} value={body} maxLength={LIMITS.body[1]} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} />
        <span>Show my Wedgie's name as its starter, and on my signature</span>
      </label>
      <Act label="Knock to start it" intent={() => ({ act: 'start', title, target, body, listed })} then={goTo(router)} />
      <p className="fine">
        It goes up with your signature on it. Each human can start one petition a day, and only you can close it.
      </p>
    </form>
  )
}

export function StartFundraiser() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [story, setStory] = useState('')
  const [goal, setGoal] = useState('')
  return (
    <form className="form big" onSubmit={(e) => e.preventDefault()}>
      <label>
        <span>Title</span>
        <input value={title} maxLength={LIMITS.title[1]} onChange={(e) => setTitle(e.target.value)} placeholder="A new roof for the community garden shed" />
      </label>
      <label>
        <span>What it's for</span>
        <textarea rows={9} value={story} maxLength={LIMITS.story[1]} onChange={(e) => setStory(e.target.value)} />
      </label>
      <label>
        <span>
          Goal, in ETH ({formatEther(GOAL.min)} to {formatEther(GOAL.max)})
        </span>
        <input inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="0.5" />
      </label>
      <Act label="Knock to start it" intent={() => ({ act: 'raise', title, story, goal })} then={goTo(router)} />
      <p className="fine">
        Gifts go to the wallet your Wedgie's ENS name resolves to, and the fundraiser shows that name, so givers know
        whose it is. Each human can start one fundraiser a day.
      </p>
    </form>
  )
}
