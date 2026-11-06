import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { me } from '../lib/server'
import { sign, text } from './fonts'
import { Mark } from './Mark'
import { preview } from './preview'
import { KnockIn, SignOut } from './Session'
import { VisitorIs } from './Visitor'
import './globals.css'

const about =
  'Petitions only humans can sign, and fundraisers only humans can start: one signature per human, with one press on their Wedgie or a proof in World App, and no real names.'

export const metadata: Metadata = {
  // Link previews need whole URLs; CLUB_ORIGIN can give a copy of the club its own
  metadataBase: new URL(process.env.CLUB_ORIGIN ?? 'https://club.getknock.dev'),
  title: { default: 'The Human Club', template: '%s | The Human Club' },
  ...preview('The Human Club', about),
}

export const viewport: Viewport = { themeColor: '#0b271f' }

export default async function RootLayout({ children }: { children: ReactNode }) {
  const who = await me()
  return (
    <html lang="en" className={`${sign.variable} ${text.variable}`}>
      <body>
        <VisitorIs who={who ? { name: who.name, world: Boolean(who.world) } : null}>
          <header className="bar">
            <a className="club-name" href="/">
              <Mark />
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
              USB device bound to one human with World ID and named in ENS. Without one, World ID and a wallet let you
              in, and the club counts you as the same human. It checks each knock and proof itself, and asks for nothing
              else: no email, no real name, no password.
            </p>
          </footer>
        </VisitorIs>
      </body>
    </html>
  )
}
