'use client'
import { useSite } from '../../lib/sites'

const CODE = 'https://github.com/getknock/knock'

/** Knock's violet label across the top, as on the docs. */
export function Bar() {
  const docs = useSite('docs')
  return (
    <header className="top">
      <a href="/" className="brand">
        <img src="/icon.svg" alt="" width={28} height={28} />
        Knock
      </a>
      <nav className="links" aria-label="Knock">
        <a href={docs}>Docs</a>
        <a href={CODE}>GitHub</a>
      </nav>
    </header>
  )
}
