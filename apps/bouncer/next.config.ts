import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const config: NextConfig = {
  // The club runs in Vercel's functions (D32): its pages, its API, and its verifier, @knock-dev/verify
  transpilePackages: ['@knock-dev/door-sdk', '@knock-dev/protocol', '@knock-dev/verify'],
  serverExternalPackages: ['@libsql/client'],
  turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
  // next dev writes an AGENTS.md otherwise
  agentRules: false,
}

export default config
