import type { Metadata } from 'next'
import { me } from '../../lib/server'
import { ComeIn } from './ComeIn'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Come in' }

/** The two ways in (D35): a knock, or World ID and a wallet. Either way the club counts the same human. */
export default async function In() {
  const who = await me()
  return (
    <main className="page narrow">
      <div className="paper">
        <h1>Come in</h1>
        {who ? (
          <p>
            You're in, as {who.name}. <a href="/me">See what's yours</a>.
          </p>
        ) : (
          <>
            <p>The club lets in humans only, and counts each one once, whichever way they come in.</p>
            <div className="ways-in">
              <div>
                <h2>With your Wedgie</h2>
                <p>One press of its green button, from Chrome, Edge or another Chromium browser on a computer.</p>
              </div>
              <div>
                <h2>With World ID and a wallet</h2>
                <p>
                  For when your Wedgie isn't at hand, or you don't have one. Your wallet signs in: it names you here,
                  and takes your fundraisers' gifts. Then World App proves you're the human Knock knows. The first
                  time, Knock binds you for that wallet on World Chain, as it binds a Wedgie.
                </p>
              </div>
            </div>
            <ComeIn />
          </>
        )}
      </div>
    </main>
  )
}
