import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { me } from '../lib/server'
import { sign, text } from './fonts'
import { KnockIn, SignOut } from './Session'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'The Human Club', template: '%s | The Human Club' },
  description:
    'Petitions only humans can sign, and fundraisers only humans can start: one signature per human, with one press on their Wedgie, and no real names.',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const who = await me()
  return (
    <html lang="en" className={`${sign.variable} ${text.variable}`}>
      <body>
        <header className="bar">
          <a className="club-name" href="/">
            The Human Club
          </a>
          <nav aria-label="The club">
            <a href="/">Petitions</a>
            <a href="/fundraisers">Fundraisers</a>
            <a href="/start">Start one</a>
            {who ? (
              <>
                <a href="/me" className="me">
                  {who.name}
                </a>
                <SignOut />
              </>
            ) : (
              <KnockIn />
            )}
          </nav>
        </header>
        {children}
        <footer className="foot">
          <p>
            The Human Club runs on <a href="https://docs.getknock.dev">Knock</a>: a knock is a press on a Wedgie, a
            USB device bound to one human with World ID and named in ENS. The club checks each one with its own
            verifier, and asks for nothing else: no email, no real name, no password.
          </p>
        </footer>
      </body>
    </html>
  )
}
