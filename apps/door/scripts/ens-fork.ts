/**
 * Naming a Wedgie and the kill switch, on a fork of mainnet: the Console's own transactions (lib/ens.ts), sent as
 * the parent's owner, then read back through ENS's Universal Resolver as any verifier would. Each set of calls is
 * first run together in one block (eth_simulateV1), as a wallet that batches sends them as one transaction (D25).
 * Nothing reaches mainnet. The owner is read from the registry and never printed.
 *
 *   anvil --fork-url <mainnet RPC> --port 8545      then, from apps/door:
 *   bun run scripts/ens-fork.ts [label] [parent]    (default: a test label under itzraj.eth)
 */
import {
  type Address,
  type Hex,
  createPublicClient,
  createTestClient,
  createWalletClient,
  formatEther,
  formatGwei,
  http,
  isAddressEqual,
  labelhash,
  parseGwei,
} from 'viem'
import { mainnet } from 'viem/chains'
import vectors from '../../../spec/vectors/v1.json'
import {
  ENS,
  type Records,
  killTxs,
  namingTxs,
  predictProxy,
  readName,
  recordTexts,
  registryAbi,
  resolverSalt,
  userRegistrySalt,
} from '../lib/ens'
import { namehash } from 'viem/ens'

const RPC = process.env.FORK_RPC ?? 'http://127.0.0.1:8545'
const [label = 'knock-fork-check', parent = 'itzraj.eth'] = process.argv.slice(2)
const name = `${label}.${parent}`
const chain = { ...mainnet, rpcUrls: { default: { http: [RPC] } } }
const c = createPublicClient({ chain, transport: http(RPC) })
const anvil = createTestClient({ chain, mode: 'anvil', transport: http(RPC) })

let bad = 0
let owner: Address = '0x0000000000000000000000000000000000000000'
const hide = (s: string) => s.replaceAll(new RegExp(owner.slice(2), 'gi'), '<owner>')
function check(what: string, ok: boolean, why: unknown = '') {
  if (!ok) bad++
  console.log(`${ok ? 'ok ' : 'BAD'}  ${what}${ok ? '' : `: ${hide(String(why))}`}`)
}

// The parent's owner, as its registry has it (a .eth name: the ETH Registry holds it)
const eth = await c.readContract({ address: ENS.root, abi: registryAbi, functionName: 'getSubregistry', args: ['eth'] })
const ps = await c.readContract({
  address: eth,
  abi: registryAbi,
  functionName: 'getState',
  args: [BigInt(labelhash(parent.split('.')[0]))],
})
owner = ps.latestOwner
await anvil.impersonateAccount({ address: owner })
await anvil.setBalance({ address: owner, value: 10n ** 18n })
const wallet = createWalletClient({ account: owner, chain, transport: http(RPC) })

const records: Records = {
  wallet: owner,
  key: vectors.key.compressed as Hex,
  nullifier: `0x${'12'.repeat(32)}`,
  poh: `eip155:480:tx:0x${'ab'.repeat(32)}`,
  sc: 'S1',
}

const gas: Record<string, bigint> = {}
async function send(txs: { id: string; to: Address; data: Hex }[]) {
  for (const t of txs) {
    try {
      const hash = await wallet.sendTransaction({ to: t.to, data: t.data })
      const r = await c.waitForTransactionReceipt({ hash })
      check(`${t.id}: sent and succeeded`, r.status === 'success', r.status)
      gas[t.id] = r.gasUsed
    } catch (e) {
      check(`${t.id}: sent and succeeded`, false, (e as Error).message.split('\n')[0])
    }
  }
}

// The calls in order, from the owner, in one block: as an atomic batch runs them (D25), and as the Console checks them
async function together(what: string, txs: { id: string; to: Address; data: Hex }[]) {
  try {
    const { results } = await c.simulateCalls({ account: owner, calls: txs.map(({ to, data }) => ({ to, data })) })
    const i = results.findIndex((r) => r.status !== 'success')
    check(`${what} as one batch: ${txs.map((t) => t.id).join(', ')}`, i < 0, i < 0 ? '' : `${txs[i].id} ${results[i].status}`)
  } catch (e) {
    check(`${what} as one batch`, false, (e as Error).message.split('\n')[0])
  }
}

// FRESH_RESOLVER=1: the parent loses its resolver first (on the fork), so the naming makes the wallet its own
if (process.env.FRESH_RESOLVER) {
  const hash = await wallet.writeContract({
    address: eth,
    abi: registryAbi,
    functionName: 'setResolver',
    args: [BigInt(labelhash(parent.split('.')[0])), '0x0000000000000000000000000000000000000000'],
  })
  await c.waitForTransactionReceipt({ hash })
}

console.log(`On a mainnet fork, as ${parent}'s owner: ${name}`)
const before = await readName(c, owner, label, parent)
check(`${name} is free to start with`, before.held === 'free', before.held)
const naming = namingTxs(before, records)
console.log(`  ${naming.map((t) => t.id).join(', ')}`)
await together('naming', naming)
await send(naming)

const after = await readName(c, owner, label, parent)
check("the parent's subregistry is the one predicted for it", isAddressEqual(after.subregistry, after.userRegistry))
if (!before.registryExists)
  check(
    'the new registry is where predictProxy said',
    isAddressEqual(after.userRegistry, predictProxy(owner, userRegistrySalt(namehash(parent)))),
  )
if (!before.resolverExists)
  check('the new resolver is where predictProxy said', isAddressEqual(after.resolver, predictProxy(owner, resolverSalt(owner))))
check(`${name} is the wallet's now, with the records' resolver`, after.held === 'yours' && isAddressEqual(after.nameResolver, after.resolver))

// What a verifier sees: the Universal Resolver
const addr = await c.getEnsAddress({ name })
check(`${name} resolves to the wallet (addr, D9)`, !!addr && isAddressEqual(addr, owner))
for (const [k, v] of recordTexts(records)) {
  const got = await c.getEnsText({ name, key: k })
  check(`${k} = ${v.length > 24 ? `${v.slice(0, 20)}…` : v}`, got === v, got)
}
check('running the naming again would only rewrite the records', namingTxs(after, records).map((t) => t.id).join() === 'records')

// The kill switch
const kill = killTxs(after)
console.log(`  kill switch: ${kill.map((t) => t.id).join(', ')}`)
await together('the kill switch', kill)
await send(kill)
check(`${name} no longer resolves`, (await c.getEnsAddress({ name })) === null)
check('knock.key is gone through the Universal Resolver', (await c.getEnsText({ name, key: 'knock.key' })) === null)
const dead = await readName(c, owner, label, parent)
check('the label is free again and has no record', dead.held === 'free' && dead.recordId === 0n, `${dead.held} ${dead.recordId}`)
check('a second kill has nothing left to do', killTxs(dead).length === 0)
const parentAddr = await c.getEnsAddress({ name: parent })
if (!process.env.FRESH_RESOLVER)
  check(`${parent} still resolves as before`, !!parentAddr && !!(await c.getEnsResolver({ name: parent })))

const price = parseGwei(process.env.GWEI ?? '1')
console.log('gas:', Object.entries(gas).map(([k, g]) => `${k} ${g}`).join(', '))
const setup = naming.reduce((n, t) => n + (gas[t.id] ?? 0n), 0n)
const killed = kill.reduce((n, t) => n + (gas[t.id] ?? 0n), 0n)
console.log(`naming ${setup} gas, kill ${killed} gas: ${formatEther(setup * price)} and ${formatEther(killed * price)} ETH at ${formatGwei(price)} gwei`)
console.log(bad ? `${bad} BAD` : 'all good')
process.exit(bad ? 1 : 0)
