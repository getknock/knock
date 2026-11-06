import type { ReactNode } from 'react'
import type { StepState } from '../../lib/setup'

/** One step of the setup, on the rail: open while it's the one to do, a line saying what it did once it's done,
 *  and only its name before its turn. */
export function Step(props: {
  id: string
  n: number
  state: StepState
  title: string
  /** What it did, for a done step */
  done?: ReactNode
  children?: ReactNode
}) {
  const { id, n, state } = props
  return (
    <li className={`step ${state}`} aria-current={state === 'now' ? 'step' : undefined}>
      <span className="mark" aria-hidden="true">
        {state === 'done' ? '✓' : n}
      </span>
      <section aria-labelledby={id}>
        <h2 id={id}>
          <span className="sr">{`Step ${n}${state === 'done' ? ', done' : ''}: `}</span>
          {props.title}
        </h2>
        {state === 'done' && props.done ? <div className="did">{props.done}</div> : null}
        {state === 'now' ? <div className="body">{props.children}</div> : null}
      </section>
    </li>
  )
}
