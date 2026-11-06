import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const config: NextConfig = {
  // A site like any other: plain files, a verifier beside it
  output: 'export',
  transpilePackages: ['@knock-dev/door-sdk'],
  turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
  // next dev writes an AGENTS.md otherwise
  agentRules: false,
}

export default config
