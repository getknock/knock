import type { Metadata } from 'next'

const picture = {
  url: '/preview.png',
  width: 1200,
  height: 630,
  alt: 'The Human Club: an H drawn as a door knocker, its brass ring hung from the crossbar, on a bottle-green door. Petitions only humans can sign, and fundraisers only humans can start.',
}

/** A page's link preview: its own title and words, with the club's picture (brand/logo.py). Each page that sets
 *  one sets all of it, since Next replaces a parent's openGraph whole. */
export function preview(title: string, description: string): Metadata {
  return {
    description,
    openGraph: { type: 'website', siteName: 'The Human Club', title, description, images: [picture] },
    twitter: { card: 'summary_large_image', title, description, images: [picture] },
  }
}
