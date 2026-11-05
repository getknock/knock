import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const config: NextConfig = {
  // Client-only, so it can be served as plain files (D8).
  output: 'export',
  transpilePackages: ['@knock-dev/protocol'],
  // The monorepo's root: the Console reads contracts/deployments/480.json.
  turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
  // next dev writes an AGENTS.md otherwise
  agentRules: false,
}

export default config
