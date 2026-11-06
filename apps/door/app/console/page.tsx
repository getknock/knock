'use client'
import { useEffect } from 'react'

/** The Console's old address: it's the home page now, at getknock.dev. */
export default function Moved() {
  useEffect(() => location.replace('/'), [])
  return (
    <main className="moved">
      <p>
        The Console is at <a href="/">the home page</a> now.
      </p>
    </main>
  )
}
