/**
 * A Wedgie's name in ENSv2 on Ethereum mainnet (PLAN.md D1, D9, D20, D21). `<label>.<parent>` gets Knock's records
 * in the user's own Permissioned Resolver, and a place in a UserRegistry under the parent. The records go in first
 * and the name last, so it never resolves half made. Every write is a transaction the user's wallet sends; this
 * file only works out which, from what the chain says now, so a step that's done is never sent twice.
 *
 * The kill switch undoes it: the name unregistered (it stops resolving at once), then its records unlinked, so
 * registering the label again later can't bring them back.
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  isAddressEqual,
  keccak256,
  labelhash,
  namehash,
  parseAbi,
  stringToBytes,
  stringToHex,
  toHex,
  zeroAddress,
} from 'viem'
import { normalize } from 'viem/ens'

/** ENSv2 on mainnet (contracts-v2, tag v2-mainnet-deployment-1; docs.ens.domains/learn/deployments), checked on
 *  chain on 2026-11-06: the root's `eth` is the v2 ETH Registry, and the Universal Resolver walks this root. */
export const ENS = {
  chainId: 1,
  root: '0x2553c09bE6447BeFfdB86FA622ad41fB8f77A91e',
  factory: '0x77510ba162dfeA3d8989E3f0928a691B345730D2',
  /** The factory's proxyLogic(): every proxy it makes delegates to it. */
  proxyLogic: '0x8E77da0dAb32EfCc1C75e0Bd0e17680EBe0b1414',
  userRegistryImpl: '0xFAA23592ACA10A6d8875b18eA86954e8EB6d8d72',
  resolverImpl: '0x565b0F456a04Ac9b48758190e90030623Cff57C5',
} as const satisfies Record<string, Address | number>

export const registryAbi = parseAbi([
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))',
  'function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setResolver(uint256 anyId, address resolver)',
  'function unregister(uint256 anyId)',
])

export const factoryAbi = parseAbi([
  'function deployProxy(address implementation, uint256 salt, bytes data) returns (address)',
  'function verifyContract(address proxy) view returns (address)',
])

const userRegistryAbi = parseAbi(['function initialize((address account, uint256 roleBitmap)[] grants)'])

export const resolverAbi = parseAbi([
  'function initialize((address account, uint256 roleBitmap)[] grants, bytes[] calls)',
  'function multicall(bytes[] data) returns (bytes[])',
  'function setAddress(bytes name, uint256 coinType, bytes addressBytes)',
  'function setText(bytes name, string key, string value)',
  'function linkToRecord(bytes name, uint256 recordId)',
  'function getRecordId(bytes32 node) view returns (uint256)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
])

/** Every role and its admin, as ENS's own examples grant them: the user's registry and resolver are all theirs. */
export const ALL_ROLES = BigInt(`0x${'1'.repeat(64)}`)

// Registry roles (RegistryRolesLib): one nybble each, admins 128 bits up
const REGISTRAR = 1n << 0n
const UNREGISTER = 1n << 12n
const RENEW = 1n << 16n
const SET_SUBREGISTRY = 1n << 20n
const SET_RESOLVER = 1n << 24n
const admin = (role: bigint) => role << 128n

/** The name's own token: what a .eth registrant gets (ETHRegistrar's REGISTRATION_ROLE_BITMAP), plus unregister
 *  and renew, so the kill switch also works from the token. The wallet holds every root role anyway. */
export const NAME_ROLES =
  SET_SUBREGISTRY |
  admin(SET_SUBREGISTRY) |
  SET_RESOLVER |
  admin(SET_RESOLVER) |
  admin(1n << 28n) | // CAN_TRANSFER_ADMIN
  UNREGISTER |
  RENEW

/** What the wallet needs on a resolver to write Knock's records and, for the kill switch, unlink them. */
export const RESOLVER_ROLES = (1n << 0n) | (1n << 4n) | (1n << 28n) // SET_ADDRESS | SET_TEXT | LINK

/** A name that never expires on its own: it lives as long as its parent does. */
export const FOREVER = 2n ** 64n - 1n

/** A Status from PermissionedRegistry.getState. */
const REGISTERED = 2

/** The Wedgie's own rule for names (knock_knock.ok_name): it hashes them itself, so they're ASCII, normalized. */
export const NAME_MAX = 64

/** Why `<label>.<parent>` can't be a Wedgie's name, or null. */
export function nameProblem(label: string, parent: string): string | null {
  const name = `${label}.${parent}`
  if (!label || label.includes('.')) return 'The label is one word: the part before the parent.'
  for (const l of name.split('.'))
    if (!/^[a-z0-9-]+$/.test(l) || l.slice(2, 4) === '--') return 'Names here are a-z, 0-9 and "-", with dots between.'
  if (name.length > NAME_MAX) return `The whole name has to fit in ${NAME_MAX} characters, for the Wedgie.`
  if (parent.split('.').length < 2) return 'The parent is a name you own, like itzraj.eth.'
  try {
    if (normalize(name) !== name) return "ENS writes this name another way: use that."
  } catch {
    return "ENS doesn't take this name."
  }
  return null
}

/** A name as ENS's setters take it (DNS wire format): each label after its length, then a zero. */
export function dnsEncode(name: string): Hex {
  const out: number[] = []
  for (const l of name.split('.')) {
    const b = stringToBytes(l)
    if (b.length === 0 || b.length > 63) throw new Error(`label "${l}" can't be DNS-encoded`)
    out.push(b.length, ...b)
  }
  out.push(0)
  return toHex(Uint8Array.from(out))
}

/** The salt ENS's own tools use for a name's UserRegistry: one per name. */
export function userRegistrySalt(parentNode: Hex): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }],
        [keccak256(stringToHex('UserRegistry')), parentNode, 0n],
      ),
    ),
  )
}

/** The salt ENS's own tools use for an account's Permissioned Resolver: one per account. */
export function resolverSalt(owner: Address): bigint {
  return BigInt(
    keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
        [keccak256(stringToHex('OwnedResolver')), owner, 0n],
      ),
    ),
  )
}

/** Where the factory puts deployer's proxy for salt: CREATE2 over a 77-byte proxy that carries its salt. */
export function predictProxy(deployer: Address, salt: bigint): Address {
  const outerSalt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [deployer, salt]))
  const initCode = concat([
    '0x3d604d80600a3d3981f3363d3d373d3d3d363d73',
    ENS.proxyLogic,
    '0x5af43d82803e903d91602b57fd5bf3',
    outerSalt,
  ])
  return getCreate2Address({ from: ENS.factory, salt: outerSalt, bytecodeHash: keccak256(initCode) })
}

/** What goes on the name (PLAN.md §3): the wallet as its address (D9), then Knock's records. */
export type Records = { wallet: Address; key: Hex; nullifier: Hex; poh: string; sc: string }

export function recordTexts(r: Records): [string, string][] {
  return [
    ['knock.v', '1'],
    ['knock.key', r.key.toLowerCase()],
    ['knock.status', 'active'],
    ['knock.nullifier', r.nullifier.toLowerCase()],
    ['knock.poh', r.poh.toLowerCase()],
    ['knock.sc', r.sc],
  ]
}

export function recordCalls(name: string, r: Records): Hex[] {
  const dns = dnsEncode(name)
  return [
    encodeFunctionData({ abi: resolverAbi, functionName: 'setAddress', args: [dns, 60n, r.wallet] }),
    ...recordTexts(r).map(([k, v]) =>
      encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dns, k, v] }),
    ),
  ]
}

/** Where a name stands on chain, for this wallet. */
export type NameState = {
  name: string
  label: string
  parent: string
  node: Hex
  wallet: Address
  /** The registry that holds the parent, and whether this wallet may point the parent at a subregistry. */
  parentRegistry: Address
  canLink: boolean
  /** The parent's subregistry now (zero: none), and the one names go in: it, or the wallet's to be. */
  subregistry: Address
  userRegistry: Address
  registryExists: boolean
  /** The label in that registry: free, this wallet's, or someone else's. */
  held: 'free' | 'yours' | 'taken'
  /** The name's resolver now (zero: none). */
  nameResolver: Address
  /** The resolver Knock's records go in: the parent's when it's this wallet's Permissioned Resolver, else the
   *  wallet's own, made with the records in it if it doesn't exist yet. */
  resolver: Address
  resolverExists: boolean
  /** The record the name has in that resolver (0: none). */
  recordId: bigint
}

/** Something that stops the naming before any transaction, said for people. */
export class NotYours extends Error {}

/** The registry that holds `name` (the walk the Universal Resolver does), or zero if a link is missing. */
async function holder(c: PublicClient, name: string): Promise<Address> {
  const labels = name.split('.')
  let registry: Address = ENS.root
  for (let i = labels.length - 1; i > 0; i--) {
    registry = await c.readContract({
      address: registry,
      abi: registryAbi,
      functionName: 'getSubregistry',
      args: [labels[i]],
    })
    if (isAddressEqual(registry, zeroAddress)) return zeroAddress
  }
  return registry
}

async function hasCode(c: PublicClient, a: Address) {
  return ((await c.getCode({ address: a })) ?? '0x') !== '0x'
}

/** A Permissioned Resolver from the factory that this wallet can write Knock's records in and unlink. */
async function usableResolver(c: PublicClient, resolver: Address, wallet: Address): Promise<boolean> {
  if (isAddressEqual(resolver, zeroAddress) || !(await hasCode(c, resolver))) return false
  try {
    const impl = await c.readContract({
      address: ENS.factory,
      abi: factoryAbi,
      functionName: 'verifyContract',
      args: [resolver],
    })
    if (!isAddressEqual(impl, ENS.resolverImpl)) return false
    return await c.readContract({
      address: resolver,
      abi: resolverAbi,
      functionName: 'hasRootRoles',
      args: [RESOLVER_ROLES, wallet],
    })
  } catch {
    return false // not a factory proxy
  }
}

export async function readName(c: PublicClient, wallet: Address, label: string, parent: string): Promise<NameState> {
  const name = `${label}.${parent}`
  const parentLabel = parent.split('.')[0]
  const parentRegistry = await holder(c, parent)
  if (isAddressEqual(parentRegistry, zeroAddress)) throw new NotYours(`${parent} isn't on ENSv2.`)
  const ps = await c.readContract({
    address: parentRegistry,
    abi: registryAbi,
    functionName: 'getState',
    args: [BigInt(labelhash(parentLabel))],
  })
  if (ps.status !== REGISTERED) throw new NotYours(`${parent} isn't registered.`)
  const canLink = await c.readContract({
    address: parentRegistry,
    abi: registryAbi,
    functionName: 'hasRoles',
    args: [ps.resource, SET_SUBREGISTRY, wallet],
  })

  const subregistry = await c.readContract({
    address: parentRegistry,
    abi: registryAbi,
    functionName: 'getSubregistry',
    args: [parentLabel],
  })
  const ours = predictProxy(wallet, userRegistrySalt(namehash(parent)))
  const userRegistry = isAddressEqual(subregistry, zeroAddress) ? ours : subregistry
  const registryExists = await hasCode(c, userRegistry)
  if (!isAddressEqual(subregistry, userRegistry) && !canLink)
    throw new NotYours(`This wallet can't add names under ${parent}: connect the wallet that owns it.`)

  let held: NameState['held'] = 'free'
  let nameResolver: Address = zeroAddress
  if (registryExists) {
    const canRegister = await c.readContract({
      address: userRegistry,
      abi: registryAbi,
      functionName: 'hasRootRoles',
      args: [REGISTRAR, wallet],
    })
    const s = await c.readContract({
      address: userRegistry,
      abi: registryAbi,
      functionName: 'getState',
      args: [BigInt(labelhash(label))],
    })
    if (s.status === REGISTERED) held = isAddressEqual(s.latestOwner, wallet) ? 'yours' : 'taken'
    else if (s.status !== 0) held = 'taken' // reserved
    if (held === 'yours')
      nameResolver = await c.readContract({
        address: userRegistry,
        abi: registryAbi,
        functionName: 'getResolver',
        args: [label],
      })
    if (held === 'free' && !canRegister)
      throw new NotYours(`${parent}'s names are kept by a registry this wallet can't add to.`)
  }

  // The resolver: the name's own if it's usable, then the parent's, then the wallet's own (made if need be)
  const parentResolver = await c.readContract({
    address: parentRegistry,
    abi: registryAbi,
    functionName: 'getResolver',
    args: [parentLabel],
  })
  let resolver = predictProxy(wallet, resolverSalt(wallet))
  for (const r of [nameResolver, parentResolver])
    if (await usableResolver(c, r, wallet)) {
      resolver = r
      break
    }
  const resolverExists = await hasCode(c, resolver)
  if (resolverExists && !(await usableResolver(c, resolver, wallet)))
    throw new NotYours("This wallet's resolver doesn't let it write Knock's records.")
  const node = namehash(name)
  const recordId = resolverExists
    ? await c.readContract({ address: resolver, abi: resolverAbi, functionName: 'getRecordId', args: [node] })
    : 0n

  return {
    name,
    label,
    parent,
    node,
    wallet,
    parentRegistry,
    canLink,
    subregistry,
    userRegistry,
    registryExists,
    held,
    nameResolver,
    resolver,
    resolverExists,
    recordId,
  }
}

/** One transaction for the user's wallet: what it does, in words, and the call. */
export type Tx = { id: 'records' | 'registry' | 'link' | 'name' | 'unregister' | 'unlink'; what: string; to: Address; data: Hex }

/** The transactions that name the Wedgie, in order: records, registry, link, name. Done steps aren't here. */
export function namingTxs(s: NameState, r: Records): Tx[] {
  if (s.held === 'taken') throw new NotYours(`${s.name} is someone else's.`)
  const txs: Tx[] = []
  const calls = recordCalls(s.name, r)
  txs.push(
    s.resolverExists
      ? {
          id: 'records',
          what: `Write Knock's records for ${s.name} in your resolver`,
          to: s.resolver,
          data: encodeFunctionData({ abi: resolverAbi, functionName: 'multicall', args: [calls] }),
        }
      : {
          id: 'records',
          what: `Make your own resolver, with Knock's records for ${s.name} in it`,
          to: ENS.factory,
          data: encodeFunctionData({
            abi: factoryAbi,
            functionName: 'deployProxy',
            args: [
              ENS.resolverImpl,
              resolverSalt(s.wallet),
              encodeFunctionData({
                abi: resolverAbi,
                functionName: 'initialize',
                args: [[{ account: s.wallet, roleBitmap: ALL_ROLES }], calls],
              }),
            ],
          }),
        },
  )
  if (!s.registryExists)
    txs.push({
      id: 'registry',
      what: `Make a registry for names under ${s.parent}`,
      to: ENS.factory,
      data: encodeFunctionData({
        abi: factoryAbi,
        functionName: 'deployProxy',
        args: [
          ENS.userRegistryImpl,
          userRegistrySalt(namehash(s.parent)),
          encodeFunctionData({
            abi: userRegistryAbi,
            functionName: 'initialize',
            args: [[{ account: s.wallet, roleBitmap: ALL_ROLES }]],
          }),
        ],
      }),
    })
  if (!isAddressEqual(s.subregistry, s.userRegistry))
    txs.push({
      id: 'link',
      what: `Point ${s.parent} at that registry`,
      to: s.parentRegistry,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: 'setSubregistry',
        args: [BigInt(labelhash(s.parent.split('.')[0])), s.userRegistry],
      }),
    })
  if (s.held === 'free')
    txs.push({
      id: 'name',
      what: `Register ${s.name}, to you, with those records`,
      to: s.userRegistry,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: 'register',
        args: [s.label, s.wallet, zeroAddress, s.resolver, NAME_ROLES, FOREVER],
      }),
    })
  else if (!isAddressEqual(s.nameResolver, s.resolver))
    txs.push({
      id: 'name',
      what: `Point ${s.name} at those records`,
      to: s.userRegistry,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: 'setResolver',
        args: [BigInt(labelhash(s.label)), s.resolver],
      }),
    })
  return txs
}

/** The kill switch's transactions: the name unregistered, then its records unlinked. Done steps aren't here. */
export function killTxs(s: NameState): Tx[] {
  if (s.held === 'taken') throw new NotYours(`${s.name} is someone else's: this wallet can't kill it.`)
  const txs: Tx[] = []
  if (s.held === 'yours')
    txs.push({
      id: 'unregister',
      what: `Unregister ${s.name}: it stops resolving`,
      to: s.userRegistry,
      data: encodeFunctionData({ abi: registryAbi, functionName: 'unregister', args: [BigInt(labelhash(s.label))] }),
    })
  if (s.recordId !== 0n)
    txs.push({
      id: 'unlink',
      what: `Unlink its records from your resolver`,
      to: s.resolver,
      data: encodeFunctionData({ abi: resolverAbi, functionName: 'linkToRecord', args: [dnsEncode(s.name), 0n] }),
    })
  return txs
}
