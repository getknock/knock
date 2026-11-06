'use client'
import { nameProblem } from '../../lib/ens'

/** The name the Wedgie will have: a label of the user's own under a parent their wallet owns (D6). The binding is
 *  made for it (D22), so it comes first. */
export function NameField(props: {
  label: string
  parent: string
  onChange: (label: string, parent: string) => void
  disabled: boolean
}) {
  const { label, parent } = props
  const problem = label && parent ? nameProblem(label, parent) : null
  return (
    <div className="field">
      <h3>Its name</h3>
      <div className="name-row">
        <input
          value={label}
          onChange={(e) => props.onChange(e.target.value.trim().toLowerCase(), parent)}
          placeholder="wedgie"
          aria-label="The Wedgie's own label"
          spellCheck={false}
          disabled={props.disabled}
        />
        <span>.</span>
        <input
          value={parent}
          onChange={(e) => props.onChange(label, e.target.value.trim().toLowerCase())}
          placeholder="itzraj.eth"
          aria-label="A name your wallet owns"
          spellCheck={false}
          disabled={props.disabled}
        />
      </div>
      <p className="hint">
        For example wedgie.itzraj.eth: the parent is a name your wallet owns, and the label is yours to pick. The
        binding is for this name only, so a lost Wedgie is no use under any other.
      </p>
      {problem ? <p className="problem">{problem}</p> : null}
    </div>
  )
}
