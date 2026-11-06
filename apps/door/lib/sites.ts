/**
 * Knock's sites (D29): the Console at getknock.dev, the docs at docs.getknock.dev, the Door at door.getknock.dev and
 * the Human Club at club.getknock.dev. Run from a checkout, each has its own port on localhost, so a Console on
 * localhost links to those. NEXT_PUBLIC_DOCS and NEXT_PUBLIC_CLUB, when set, win.
 */
import { useEffect, useState } from 'react'

const SITES = {
  docs: { live: 'https://docs.getknock.dev', port: 3002, set: process.env.NEXT_PUBLIC_DOCS },
  club: { live: 'https://club.getknock.dev', port: 3001, set: process.env.NEXT_PUBLIC_CLUB },
}

export type Site = keyof typeof SITES

/** Where a site is, from a page at `host` */
export function siteFrom(which: Site, host: string | null): string {
  const s = SITES[which]
  if (s.set) return s.set
  return host === 'localhost' || host === '127.0.0.1' ? `http://${host}:${s.port}` : s.live
}

/** Where a site is, from this page: the live address until the page knows its own host. */
export function useSite(which: Site): string {
  const [at, setAt] = useState(() => siteFrom(which, null))
  useEffect(() => setAt(siteFrom(which, location.hostname)), [which])
  return at
}
