# Knock

Prove you're a human with one press of a button on a device you own. A Wedgie (a Pico with a screen and a Trust M chip) signs a knock; a site checks it against the human's World ID and ENS name, with no server of ours in the middle.

- Console and Door: [getknock.dev](https://getknock.dev) and [door.getknock.dev](https://door.getknock.dev/knock)
- Docs: [docs.getknock.dev](https://docs.getknock.dev), or [the quickstart](https://docs.getknock.dev/quickstart)
- A demo site, the Human Club: [club.getknock.dev](https://club.getknock.dev)

## How it works

1. **Bind, once.** The wedgie's own key is proven to a World ID nullifier through `KnockBinding` on World Chain, then named in ENSv2. A human proves themselves once; later bindings are proofs of that World ID session.
2. **Knock.** A site opens the Door popup. The wedgie shows the origin, you press green, and it returns a signed `KnockPass`.
3. **Verify.** The site's own verifier checks the ENS name, the `Bound` receipt, the P-256 signature, the counter and the nullifier. Knock's server isn't involved at knock time.
4. **Kill.** From the Console, the wallet unregisters the name and unlinks its records, and the wedgie forgets both. It can be bound again later, as the same human.

Both ways into the Human Club count the same nullifier: a knock from a wedgie, or World ID plus a wallet.

## Packages

| Package | What it is |
|---|---|
| `@knock-dev/protocol` | EIP-712 types and digests, keys, signals, P-256 |
| `@knock-dev/door-sdk` | `knock({ challenge })` for a site's front end |
| `@knock-dev/verify` | V1–V8 on a site's own server (Node, Bun, Deno, edge), with memory or libSQL stores |
| `knock-verify`, `knock-verifier` | The same checks in Rust; both 0.1.0 on crates.io |
| `server/knockd` | Signs World ID requests and relays bindings; anyone can run it |
| `apps/door` | The Console and the Door (one static export) |
| `apps/bouncer` | The Human Club, in Vercel's functions with Turso |
| `contracts/` | `KnockBinding`, deployed on World Chain |

The docs live in their own repo, [getknock/docs](https://github.com/getknock/docs), and the wedgie app in [getknock/wedgie](https://github.com/getknock/wedgie).

## Running it

```bash
bun install
bun test          # TypeScript: 181 tests
bun run typecheck

cargo test        # Rust: 34 tests
forge test        # contracts: 30 tests (from contracts/)

cd apps/door && bun run dev      # Console + Door, port 3000
cd apps/bouncer && bun run dev   # Human Club, port 3001
```

The club needs `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` (or a SQLite file) and its other settings in `apps/bouncer/lib/server.ts`. `knockd` needs a World RP key to sign World ID requests; without one it still relays bindings and answers lookups. Self-hosting each part is covered in [the docs](https://docs.getknock.dev/self-host/overview).

## Honest limits

- There is no PIN on the wedgie: a thief can knock until the name is killed.
- Proof farming is not solved: a human can still be paid to knock.
- The public nullifier is linkable across sites in Bound mode.
- Any installed app can use the chip, and the origin on the wedgie's screen is unverified.
- The wedgie is not an audited hardware wallet.
- The Human Club is centralized for now, in Turso, with proofs checked in its functions; the verifier keeps humans from signing twice, not the server from lying.

## CROPS

- **Censorship resistant.** A knock needs nothing from Knock: the site opens a static Door and its own verifier reads ENS and World Chain directly. If getknock.dev, door.getknock.dev or `knockd` disappear or refuse a visitor, a site can self-host the Door and verifier from this repo and keep accepting knocks. Binding and naming are the only steps that need Knock's RP or the user's wallet. A site sets its own RPCs, and a failing one fails closed.
- **Open source.** MIT. The wedgie app, contracts, `knockd`, both verifiers, the Console and Door, the Human Club and the plans build from this repo alone; the docs are a second public repo.
- **Private.** No accounts, analytics or third-party trackers in the client. The device keeps its key, and the club shows an ENS name or wallet only when the signer asks. A site's RPC providers see which name it checks, and the club's Vercel functions and Turso keep the session and the public nullifier; that nullifier is linkable across sites in Bound mode, as the limits above say.
- **Secure.** The key stays in the Trust M chip and signs P-256 over an EIP-712 digest; the verifier checks the ENS records, the World Chain `Bound` receipt, the counter and one-human-once. Trust assumptions: the Trust M chip, World ID's verifier contract, ENS's resolvers and the RPCs. There is no PIN, and the Wedgie is not an audited hardware wallet.

## Licence

MIT. See [LICENSE](LICENSE). `PLAN.md` is the design and decision record; `PRODUCTION.md` is the release checklist.
