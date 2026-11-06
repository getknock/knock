/**
 * Knock's npm packages, staged for publishing in out/npm/<package>. In this repo each package exports its
 * TypeScript, which the apps build from; npm gets it built to JavaScript (dist), with its README, the licence, its
 * source for the source maps, and a package.json that points at dist, with no workspace versions left in it.
 *
 *   bun scripts/npm.ts           build and stage them
 *   bun scripts/npm.ts --check   then install the staged packages in a new project, and import them in Node and tsc
 *   npm publish out/npm/<package> --access public, in the order below
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '..')
const OUT = path.join(ROOT, 'out', 'npm')

// In publishing order: a package's dependencies go before it
const PACKAGES: Record<string, { description: string; keywords: string[]; homepage: string }> = {
  protocol: {
    description: 'What a Wedgie signs for Knock: the EIP-712 messages, their digests, and P-256 key helpers',
    keywords: ['knock', 'wedgie', 'eip-712', 'p256', 'world-id', 'ens'],
    homepage: 'https://docs.getknock.dev/reference/protocol',
  },
  verify: {
    description: "A site's check of a Knock in its own server: V1–V8, with ENS on mainnet and the human's binding on World Chain",
    keywords: ['knock', 'world-id', 'ens', 'proof-of-human', 'verifier'],
    homepage: 'https://docs.getknock.dev/reference/verify',
  },
  'door-sdk': {
    description: "The browser side of Knock: knock() opens the Door, which asks the visitor's Wedgie for a press",
    keywords: ['knock', 'wedgie', 'web-serial', 'world-id', 'proof-of-human', 'ens'],
    homepage: 'https://docs.getknock.dev/reference/door-sdk',
  },
}

type Manifest = { name: string; version: string; dependencies?: Record<string, string> }
const manifest = (p: string): Manifest => JSON.parse(readFileSync(path.join(ROOT, 'packages', p, 'package.json'), 'utf8'))
const versions = new Map(Object.keys(PACKAGES).map((p) => [manifest(p).name, manifest(p).version]))

function run(cmd: string[], cwd = ROOT) {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')}: exit ${r.exitCode}`)
}

function tsc(dir: string) {
  const bin = [path.join(dir, 'node_modules/.bin/tsc'), path.join(ROOT, 'node_modules/.bin/tsc')].find(existsSync)
  if (!bin) throw new Error(`no tsc for ${dir}: bun install first`)
  return bin
}

function stage(p: string) {
  const dir = path.join(ROOT, 'packages', p)
  const m = manifest(p)
  rmSync(path.join(dir, 'dist'), { recursive: true, force: true })
  run([tsc(dir), '-p', path.join(dir, 'tsconfig.build.json')])
  const js = readFileSync(path.join(dir, 'dist/index.js'), 'utf8')
  // One file each: what it imports is a dependency, never a file of its own or TypeScript
  for (const [, spec] of js.matchAll(/^(?:import|export)[^'"]*from ['"]([^'"]+)['"]/gm)) {
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (spec.startsWith('.') || spec.endsWith('.ts') || !m.dependencies?.[pkg]) throw new Error(`${m.name} imports ${spec}`)
  }

  const to = path.join(OUT, p)
  rmSync(to, { recursive: true, force: true })
  mkdirSync(path.join(to, 'src'), { recursive: true })
  cpSync(path.join(dir, 'dist'), path.join(to, 'dist'), { recursive: true })
  cpSync(path.join(dir, 'src/index.ts'), path.join(to, 'src/index.ts'))
  cpSync(path.join(dir, 'README.md'), path.join(to, 'README.md'))
  cpSync(path.join(ROOT, 'LICENSE'), path.join(to, 'LICENSE'))
  const dependencies = Object.fromEntries(
    Object.entries(m.dependencies ?? {}).map(([n, v]) => {
      if (!v.startsWith('workspace:')) return [n, v]
      const at = versions.get(n)
      if (!at) throw new Error(`${m.name}: ${n} isn't one of these packages`)
      return [n, `^${at}`]
    }),
  )
  const out = {
    name: m.name,
    version: m.version,
    description: PACKAGES[p].description,
    keywords: PACKAGES[p].keywords,
    homepage: PACKAGES[p].homepage,
    bugs: 'https://github.com/getknock/knock/issues',
    repository: { type: 'git', url: 'git+https://github.com/getknock/knock.git', directory: `packages/${p}` },
    license: 'MIT',
    type: 'module',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    main: './dist/index.js',
    types: './dist/index.d.ts',
    files: ['dist', 'src/index.ts'],
    sideEffects: false,
    ...(Object.keys(dependencies).length ? { dependencies } : {}),
    publishConfig: { access: 'public' },
  }
  writeFileSync(path.join(to, 'package.json'), `${JSON.stringify(out, null, 2)}\n`)
  console.log(`staged ${m.name}@${m.version} in ${path.relative(ROOT, to)}`)
}

/** The staged packages as npm would give them to someone: packed, installed in a new project, then imported */
function check() {
  const at = mkdtempSync(path.join(tmpdir(), 'knock-npm-'))
  try {
    for (const p of Object.keys(PACKAGES)) run(['npm', 'pack', '--silent', '--pack-destination', at, path.join(OUT, p)], at)
    const tgz = readdirSync(at).filter((f) => f.endsWith('.tgz'))
    const dependencies = Object.fromEntries(
      Object.keys(PACKAGES).map((p) => [manifest(p).name, `file:./${tgz.find((f) => f.startsWith(`knock-dev-${p}-`))}`]),
    )
    writeFileSync(path.join(at, 'package.json'), JSON.stringify({ name: 'check', private: true, type: 'module', dependencies }))
    run(['npm', 'install', '--silent', '--no-audit', '--no-fund'], at)
    writeFileSync(
      path.join(at, 'check.mjs'),
      `import { digest, KINDS } from '@knock-dev/protocol'
import { Verifier, memoryStore, KNOCK_BINDING } from '@knock-dev/verify'
import { knock, DOOR } from '@knock-dev/door-sdk'
const v = new Verifier({ origin: 'https://club.example', store: memoryStore() })
const { challenge } = await v.challenge()
if (!/^0x[0-9a-f]{64}$/.test(challenge) || !/^0x[0-9a-f]{64}$/.test(digest('KnockHello', { challenge }))) throw new Error('digest')
if (typeof knock !== 'function' || !DOOR.startsWith('https://') || !KINDS.length || !KNOCK_BINDING) throw new Error('exports')
console.log('node: imports and runs')
`,
    )
    run(['node', 'check.mjs'], at)
    writeFileSync(
      path.join(at, 'check.ts'),
      `import { digest } from '@knock-dev/protocol'
import { type Knocked, Refusal, Verifier, memoryStore } from '@knock-dev/verify'
import { type Assertion, type Hex, KnockError, knock } from '@knock-dev/door-sdk'
const v = new Verifier({ origin: 'https://club.example', store: memoryStore() })
export async function enter(a: Assertion): Promise<Knocked | string> {
  const d: Hex = digest('KnockHello', { challenge: (await v.challenge()).challenge })
  try {
    return await v.verify(a, { action: 'enter' })
  } catch (e) {
    return e instanceof Refusal ? e.why : e instanceof KnockError ? e.code : d
  }
}
export const go = (challenge: Hex) => knock({ challenge })
`,
    )
    writeFileSync(
      path.join(at, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'es2023', module: 'nodenext', moduleResolution: 'nodenext', strict: true, noEmit: true, types: [] }, files: ['check.ts'] }),
    )
    run([tsc(path.join(ROOT, 'packages/protocol')), '-p', at])
    console.log('tsc: types resolve')
  } finally {
    rmSync(at, { recursive: true, force: true })
  }
}

for (const p of Object.keys(PACKAGES)) stage(p)
if (process.argv.includes('--check')) check()
