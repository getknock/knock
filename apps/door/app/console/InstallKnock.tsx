'use client'
import { useEffect, useRef, useState } from 'react'
import { type Progress, installKnock } from '../../lib/install'
import { type KnockApp, REPO, type Shelf, latestKnock, shelfOf } from '../../lib/knock-app'
import type { Wedgie } from '../../lib/wedgie'
import type { View } from './Screen'

/** getknock/wedgie's Knock now, and wedgie.dev's shelf: what the Console installs, and the names of what it replaces */
export type Latest =
  | { state: 'reading' }
  | { state: 'ready'; app: KnockApp; shelf: Shelf | null }
  | { state: 'failed'; why: string }

// Read once a visit, when a Wedgie first needs it; Try again reads it afresh
let reading: Promise<{ app: KnockApp; shelf: Shelf | null }> | null = null

export function useLatestKnock(wanted: boolean): [Latest, () => void] {
  const [latest, setLatest] = useState<Latest>({ state: 'reading' })
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!wanted) return
    let gone = false
    reading ??= shelfOf().then(async (shelf) => ({ app: await latestKnock(shelf), shelf }))
    reading.then(
      (r) => !gone && setLatest({ state: 'ready', ...r }),
      (e) => {
        reading = null
        if (!gone) setLatest({ state: 'failed', why: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => {
      gone = true
    }
  }, [wanted, round])
  const again = () => {
    reading = null
    setLatest({ state: 'reading' })
    setRound((n) => n + 1)
  }
  return [latest, again]
}

type Phase = 'idle' | 'running' | 'stopped'

/** An app's name on wedgie.dev's shelf, else its module's */
export function appName(mod: string | null, shelf: Shelf | null): string | null {
  return mod ? (shelf?.carts.find((c) => c.mod === mod)?.name ?? mod) : null
}

/** Knock onto the connected Wedgie, for one that runs another app or none (install.ts), or a newer Knock for one whose
 *  Knock is older than getknock/wedgie's (update). */
export function InstallKnock(props: {
  wedgie: Wedgie
  latest: Latest
  onAgain: () => void
  /** The app it runs: another's module, or null for none. For an update, Knock's number. */
  from: { mod: string | null } | { knock: number }
  onView: (v: View | null) => void
  onBusy: (busy: boolean) => void
  /** Knock is on it, and it restarted */
  onDone: (w: Wedgie) => void
  /** It stopped: the Console keeps why, since a Wedgie that restarts takes this panel with it until it's back */
  onStopped: (w: Wedgie, e: unknown) => void
  problem: string | null
  busy: boolean
}) {
  const { latest, problem } = props
  const [phase, setPhase] = useState<Phase>('idle')
  const [at, setAt] = useState(-1)
  const [what, setWhat] = useState<string | null>(null)
  // The step it's on, kept through the restart's: where a stop happened
  const reached = useRef(-1)

  if (latest.state === 'reading') return <p className="muted">Reading Knock from {REPO}…</p>
  if (latest.state === 'failed')
    return (
      <>
        <p className="callout bad">The Console couldn't read Knock from {REPO}: {latest.why}</p>
        <div className="actions">
          <button type="button" className="btn small" onClick={props.onAgain}>
            Try again
          </button>
        </div>
      </>
    )

  const { app, shelf } = latest
  const update = 'knock' in props.from
  const from = 'mod' in props.from ? appName(props.from.mod, shelf) : null
  const version = app.version ? `Knock ${app.version}` : 'Knock'
  const rail = [
    'Your Wedgie asks FULL CONTROL? in red, and you press green',
    update ? `${version}'s files replace the old ones, each checked on the Wedgie` : "Knock's files go on, each checked on the Wedgie",
    ...(from ? [`${from}'s files come off`] : []),
    'It restarts into Knock, locked again',
  ]
  const title = `${update ? 'Updating' : 'Installing'} ${app.name}`

  function to(i: number) {
    reached.current = i
    setAt(i)
  }

  function step(p: Progress) {
    if (p.step === 'asking') {
      to(0)
      props.onView({ kind: 'full' })
    } else if (p.step === 'writing') {
      to(1)
      setWhat(`${p.file}, ${p.n} of ${p.of}`)
      props.onView({ kind: 'installing', title, what: p.file, p: p.p })
    } else if (p.step === 'tidying') {
      to(from ? 2 : 1)
      setWhat(null)
      props.onView({ kind: 'installing', title, what: '', p: 1 })
    } else if (p.step === 'restarting') {
      setAt(rail.length - 1)
      setWhat(null)
      props.onView(null)
    }
  }

  async function go() {
    setPhase('running')
    to(-1)
    setWhat(null)
    props.onBusy(true)
    const w = props.wedgie
    try {
      await installKnock(w, app, shelf, step)
      props.onDone(w)
    } catch (e) {
      setPhase('stopped')
      setAt(reached.current)
      props.onStopped(w, e)
    } finally {
      props.onView(null)
      props.onBusy(false)
    }
  }

  const running = phase === 'running'
  const state = (i: number) => (i < at ? 'done' : i === at ? (phase === 'stopped' ? 'failed' : 'now') : '')
  const commit = app.sha === 'main' ? 'main' : app.sha.slice(0, 7)
  return (
    <>
      {update ? (
        <p>
          This Wedgie runs Knock {(props.from as { knock: number }).knock}, and {REPO} has {version}. Updating changes
          Knock's files only: its key, its name and its binding stay.
        </p>
      ) : (
        <p>
          {from ? `This Wedgie runs ${from}. ` : 'This Wedgie has no app on it. '}
          Installing Knock puts its {app.files.length} files on it{from ? `, and takes ${from}'s off` : ''}. Its saves
          and the keys in its chip stay{from ? `, and wedgie.dev puts ${from} back whenever you like` : ''}.
        </p>
      )}
      <p className="muted">
        {version}, from{' '}
        <a href={`https://github.com/${REPO}/tree/${app.sha}`} target="_blank" rel="noreferrer">
          {REPO} at {commit}
        </a>
        {app.at ? `, ${new Date(app.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}.
      </p>
      <div className="callout warn">
        <p className="callout-title">It asks FULL CONTROL? in red</p>
        <p>
          Knock isn't on wedgie.dev's shelf, so it goes on the way an app from any repo does: a green press gives this
          page full control of your Wedgie until it restarts. The Console uses it to write Knock's files, then restarts
          the Wedgie, which locks it again. Press green only after pressing {update ? 'Update' : 'Install'} here.
        </p>
      </div>
      <ol className="progress">
        {rail.map((r, i) => (
          <li key={r} className={state(i)}>
            {r}
            {i === 1 && what && at === 1 ? <span className="sub">{what}</span> : null}
          </li>
        ))}
      </ol>
      {problem ? <p className="callout bad">{problem}</p> : null}
      <div className="actions">
        <button type="button" className="btn go" onClick={go} disabled={running || props.busy}>
          {running ? (update ? 'Updating…' : 'Installing…') : update ? `Update to ${version}` : `Install ${version}`}
        </button>
      </div>
      <p className="note">
        Your Wedgie keeps the red border it draws while it runs files wedgie.dev didn't sign, as it does for any app
        from outside its shelf.
      </p>
    </>
  )
}
