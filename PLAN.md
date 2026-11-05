# Knock

> Prove you're a human with one press of a button on a device you own. Your Wedgie vouches for "wallet address; with humanity".

Status: **M0 done** (`@knock-dev/protocol`, test vectors, icon); **M1 in progress** (the Wedgie app). This file is the living plan. It gets updated whenever the user prompts, gives info, or decisions change. The changelog is at the bottom.

Principle: fun first. Practicality (testnet faucets, airdrops, humans-only pages) is a bonus. Over-engineering is explicitly OK.

## 1. Summary

A Wedgie (Pico + 240x240 LCD + Trust M secure chip) runs the **Knock app** (Safe Signer + `knock_*` messages).

- **Setup, once**: bind the device key to a World ID 4.0 nullifier through a stateless `KnockBinding` contract on World Chain (it emits `Bound`). Then name the device in ENSv2 (`wedgie.itzraj.eth`) with `knock.*` records pointing at that binding.
- **A knock**: a dApp opens the **Door** popup → the Wedgie shows the origin + KNOCK → green press → a signed `KnockPass`.
- **Verification**: the site's own verifier checks ENS (active, key), the `Bound` receipt on World Chain, the P-256 signature, the counter, and that the nullifier matches across device, ENS and log.
- Nobody sits in the middle, and Knock's server isn't involved at knock time.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | Chain roles: **ENSv2 on Ethereum mainnet, launched** (identity + status; verified live on 2026-11-06, see §4) and **World ID 4.0 + `KnockBinding` on World Chain mainnet (480)** (humanity). Sepolia ENSv2 is the fallback and for rehearsal. |
| D2 | World ID on-chain verification uses World's **`WorldIDVerifier`**: prod `0x00000000009E00F9FE82CfeeBB4556686da094d7`, staging `0x703a6316c975DEabF30b637c155edD53e24657DB` (both chain 480). Confirmed on docs.world.org. |
| D3 | The user has a **physical Wedgie**. The virtual wedgie (`wedgie.dev/virtual`, `/code`) is for fast screen iteration and as a fallback. |
| D4 | Backend in **Rust** (axum, alloy, idkit-core): `knockd` (signer), `server/verifier`, `crates/knock-verify`. |
| D5 | Contracts: **Foundry**, `via_ir = true`. |
| D6 | **User-chosen names, multiple devices.** The user picks the parent (`itzraj.eth`) and the device label (`wedgie`, `spare`, anything ENSIP-15 valid). Several devices can carry one nullifier, each with its own key, ENS name and status. |
| D7 | Frontend: **Next.js** for everything (Door, Console, Revoke page, Bouncer), deployed or local. |
| D8 | IPFS / reproducible Door build is **deferred**. Keep the Door client-only (no server runtime) so a static export stays possible. |
| D9 | **One wallet.** The user's wallet is the ENS controller, the address the device name resolves to (`addr`), and the wallet allowed to revoke. No separate phone wallet or custom role for now. |
| D10 | The Knock app lives in its **own public GitHub repo** (installed via wedgie.dev/connect). This repo is the monorepo for everything else. Locally it's `$HOME/knock-wedgie`: a full-history clone of `clawdbotatg/wedgie-safe` with `origin` renamed to `upstream`. The GitHub repo gets created later, only with the user's OK. |
| D11 | **Bun workspaces** (the user's choice): `bun install` writes `bun.lock`, tests run on `bun test`, and root scripts run `bun run --filter '@knock-dev/*' <script>`. No global installs. |
| D12 | The Knock app is a **fork of Safe Signer that keeps `"mod": "safe"`**, with display name "Knock". It's a drop-in replacement: saves stay in `/saves/safe/`, wedgie.dev/safe keeps working, and the diff stays small for upstream merges. New code goes in `safe_knock.py`, loaded per request like `safe_msg`, and `safe_qr.py`. The manifest requires every file to be `safe.py` or start with `safe_`. |
| D13 | **QR encoded on the device**: pure Python, byte mode, ECC M, version ≤ 13 (69 modules × 3 px), **fixed mask** (no penalty scoring) to save CPU and RAM. Fallback: the host sends the module bitmap. |
| D14 | Rust workspace and Next.js apps are created when first needed (M3/M4). Use the Universal Resolver proxy `0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe`. |
| D15 | Every npm package uses the **`@knock-dev`** scope: `@knock-dev/protocol`, `@knock-dev/door-sdk`, … |
| D16 | **Icon**: a yellow door in a black frame, black knob, white knock lines, on a violet label (`#6e56cf`). The source of truth is the 12×12 cart grid in knock-wedgie's `wedgie.json`. `tools/icon_svg.py` there makes `assets/icon.svg`; `resvg -w N -h N` makes `assets/icon/icon-N.png` for N = 16, 32, 48, 64, 96, 128, 192, 256, 512, 1024 (multiples of 16, so the pixels stay square). |

## 3. Design essentials

**Trust model**: one P-256 key (Safe Signer's locked key, Trust M slot `KEY2`, public key in `DATA[11]`); three independent authorities:
1. **Identity** = ENSv2 records on the device name.
2. **Humanity** = a `Bound` event on World Chain.
3. **Presence** = the device signs the site's fresh challenge after a physical green press.

Knock never touches funds.

**Wire (Wedgie ↔ Door)**: JSON lines over USB serial, ≤ 6 KB each, `id` echoed. Messages: `knock_hello` → `knock_info`; `knock_qr` (draw a URI as QR, no signing); `knock_bind` → `knock_bind_sig` (press); `knock_enroll` → `knock_enrolled` (press); `knock_confirm` (stores name, status, nullifier, expiry, PoH pointer; drives the badge); `knock_pass` → `knock_pass_sig` (press); `knock_cancel`. Errors: `bad_request, busy, rejected, timeout, cancelled, not_enrolled, already_enrolled, too_large, internal`. The app keeps answering the firmware's `hello`/`ping` and adds `"knock": 1`; every `safe_*` request keeps working.

**Device rules**: states IDLE / PROMPT / QR / SIGNING. No signing without a physical green press made after the prompt is fully shown; presses in the first 0.6 s and USB-simulated presses are ignored. Red, 120 s of silence, or `knock_cancel` return to IDLE. The device computes every digest itself from fields it parsed. A monotonic counter is incremented and stored before every `knock_pass` reply. The device has no clock. Screens name the action in words (BECOME, BIND, KNOCK), the device name, and the origin labelled "unverified". Never show button letters.

**Signed structures** (EIP-712, domain `Knock` v`1`): `KnockHello`, `KnockEnroll`, `KnockBind`, `KnockPass(challenge, origin, deviceNode, counter, mode, nullifier, humanRef)`. Signatures are P-256 `r||s`, 64 bytes, low-s, over the digest as given (no re-hash).

**ENS records** on `<label>.<parent>`: `addr` (60), `knock.v=1`, `knock.key` (33-byte compressed P-256), `knock.status` (`active|revoked`), `knock.nullifier`, `knock.poh` (`eip155:480:tx:<hash>`), `knock.sc` (`S1|S2`), optional `knock.att`. The device name sits in a `UserRegistry` subregistry of the parent with a Permissioned Resolver. The device key holds no role.

**`KnockBinding`** (stateless, ownerless, no upgrade path): `bind(nullifier, nonce, expiresAtMin, issuerSchemaId, genesisIssuedAtMin, proof[5], x, y, r, s)`. It computes the compressed key `K` and `signalHash = keccak256(K) >> 8`, calls `WorldIDVerifier.verify(...)` with action `keccak256("knock-bind") >> 8` (reverts on failure), verifies the device's P-256 signature over `KnockBind` via `P256VERIFY` at `0x100`, and emits `Bound(nullifier, keyHash, expiresAtMin)`. It writes no storage. Anyone may submit it.

**World ID request**: IDKit v4, preset `proofOfHuman`, action `knock-bind`, signal = `0x` + the 66 hex digits of the device's compressed key. `knockd` signs the RP context. The Console shows `connectorURI` on the Wedgie via `knock_qr`.

**Door protocol**: the dApp opens `<door-origin>/knock`; the popup posts `knock/ready`; the dApp posts `knock/request {challenge, mode}`; the Door takes the origin from `event.origin` (never from the message) and checks `event.source`; the result goes back with `knock/result` to that origin only. Modes: **1 Bound** (humanity from the binding) and **2 Fresh** (a World ID proof per knock, `humanRef = keccak256(IDKit result)`).

**Verifier (V1–V8, in order, fail closed)**:
1. Parse (low-s).
2. The challenge is ours, unexpired (≤ 2 min), unconsumed, and the origin is ours.
3. Resolve the name and check validity: not expired, `knock.v`, `status=active` seen ≥ 3 blocks deep, `revoked` honoured from the latest block, cache ≤ 60 s; a key seen revoked is invalid forever.
4. Recompute the `KnockPass` digest from our own challenge and origin; verify the signature under `knock.key`.
5. The counter is above the highest stored for this key.
6. Mode 1: `humanRef` is zero; the signed nullifier equals `knock.nullifier`; the receipt named by `knock.poh` succeeded on an accepted `KnockBinding`, with a `Bound` log whose `keyHash` and `nullifier` match, not expired, final.
7. Mode 2: forward the IDKit result bytes to World's verify API and check `humanRef`, the action, and `signal_hash(challenge)`.
8. Optionally enforce one entry per (site action, nullifier).

Then commit atomically: consume the challenge, store the counter, insert the nullifier. A rejected knock consumes nothing.

**Revocation**: the user's wallet sets `knock.status = revoked` (one mainnet tx). A revoked key never returns; a new device needs a new chip. Binding a new device does not cut off the old one, only revoking does.

## 4. Facts verified (2026-11-05/06)

- **World ID 4.0 on-chain**: `IWorldIDVerifier.verify(nullifier, action, rpId, nonce, signalHash, expiresAtMin, issuerSchemaId, credentialGenesisIssuedAtMin, uint256[5] proof) external view`; it reverts on failure. `action = uint256(keccak256(bytes(action))) >> 8`. Docs recommend an upgradeable proxy for the consumer. `world-id-protocol` `contracts/deployments/core/production.json` lists `worldIDVerifier` proxy `0x…09E00F9F…94d7`, `worldIDRegistry` `0x0000000000aE079e…67d4`, `rpRegistry` `0xD9A213A9…5BbC`. The docs do not define a proof validity window; only `expires_at_min` is passed through. Proofs must be bound soon after they're made, because Merkle roots age.
- **ENSv2 mainnet contracts** (docs.ens.domains/learn/deployments): ETH Registry `0xf60aba43…85e2`, Root Registry `0x2553c09b…a91e`, ETH Registrar `0xd6d8369e…cc81`, Universal Resolver V2 `0x06fdd07f…cfd5`, Verifiable Factory `0x77510ba1…30d2`, Permissioned Resolver impl `0x565b0f45…57c5`, User Registry impl `0xfaa23592…8d72`. Sepolia equivalents are on the same page. That page said resolution stays on ENSv1 "until the launch completes"; the user says the launch is done (R1).
- **ENSv2 EAC**: `grantRoles/revokeRoles` per name, `grantRootRoles/revokeRootRoles` contract-wide; `ROLE_REGISTRAR = 1<<0`, `ROLE_RENEW = 1<<16`; fuses are replaced by roles. Subname creation is `register(label, owner, subregistry, resolver, roleBitmap, expiry)` on the parent's `UserRegistry` (deployed through the Verifiable Factory; `initialize` must include `ROLE_REGISTRAR_ADMIN` and `ROLE_RENEW_ADMIN`), then `setSubregistry(parentLabelhash, userRegistry)` on the parent's registry. Permissioned Resolver setters take DNS-encoded names. Never cache token IDs or resolvers (`findTokenId` at write time). Min libs: viem ≥ 2.35.0, ENSjs ≥ 5.2.5 for ENSv2 writes.
- **Wedgie**: Trust M is P-256 only. `c.sign(slot, digest)` signs a digest as given. The factory key's Infineon cert is readable via `c.read(optiga.CERT)`. Apps need `"usb": true` for their own protocol. Saves are readable by any plugged-in computer (public data only). A GitHub-installed app is unsigned with full device access, and any app can use the chip. Web Serial: Chrome/Edge only, one holder of the port at a time.
- **IDKit v4**: the connect URL is exposed as `connectorURI`. Production actions work only with the real World App; staging only with the Simulator.
- **Checked on chain (2026-11-06)**:
  - **ENSv2 is live**: the root registry's `eth` points at the v2 ETH Registry `0xf60a…85e2`. `ur.integration-tests.eth` returns `0x2222…` through both the UR proxy and `0x06fd…cfd5`.
  - **`itzraj.eth`**: not in the v1 registry. In v2 it has resolver `0x5516Dd167987b425942e49541BB0e5cc17CCeBDa`, resolves to `0xdffbfc54c6863e6e5ba271e2f0e15fb5d1efe499`, and has **no subregistry yet**.
  - **World**: both `WorldIDVerifier` proxies have code on chain 480. The relayer (gas key) holds ~0.001 ETH; gas is ~0.0015 gwei.
- **The user's Wedgie**: firmware 0.3.76, MicroPython 1.29.0, RP2040, OPTIGA Trust M. Runs Safe Signer `safe-59` with its key locked. Sealed. **~74 KB RAM free** at idle.
- **Safe Signer** (`clawdbotatg/wedgie-safe`, upstream `safe-63`):
  - `safe.py` `handle(m)` dispatches on `type`. Rare features are modules imported per request and dropped after (`safe_msg`). Big modules ship as `.mpy`, built by `tools/mpy.sh` (`uv` + `mpy-cross==1.29.0.post2`).
  - Reusable: `sign(digest)` (chip, low-s); `_screen(...)` (question page: ignores presses for 600 ms, times out at 120 s, physical keys only); `W.send`, `W.hello`, `draw_home()`, `save.*`, `safe_keccak.keccak256`.
  - `safe_msg.prove` gives the factory-key signature over `sha256("wedgie safe key\0" + X + Y)` plus the Infineon cert: the future `knock.att`.
- **Dev loop** (wedgie-dev `public/wedgie.py`, served at wedgie.dev/wedgie.py): `hello`, `install .` (installs the app in the current folder through full access; a red question, then a green press), `run file.py`, `debug`. Recovery: hold both grey buttons while plugging in to boot with no app, then reinstall Safe Signer from wedgie.dev/connect.
- **Not yet read**: docs.world.org RP-signature pages (needed for M3).

## 5. Components and stack

| Package | What | Stack |
|---|---|---|
| `knock-wedgie` (separate repo) | Knock app: Safe Signer fork + `knock_*`, screens, pure-Python QR encoder, Human badge, activity dot | MicroPython, `wedgie.json` (`usb: true`) |
| `packages/protocol` | `@knock-dev/protocol`: EIP-712 types and digests, key, signal, action and namehash helpers, P-256 verify; generates `spec/vectors/v1.json` (`bun run vectors`) | TypeScript, viem, @noble/curves, Bun (`bun test`) |
| `apps/door` | Door + Console + Revoke page (client-only) | TypeScript, Next.js, Web Serial, viem |
| `apps/bouncer` | Demo dApp: humans-only claim, live checklist, bot script | TypeScript, Next.js |
| `packages/door-sdk` | `knock({challenge, mode})`: opens the Door popup, returns the assertion | TypeScript |
| `server/knockd` | Signs World ID RP contexts and `bind()` txs; no RPC, no IP logs | Rust (axum, idkit-core, alloy) |
| `server/verifier`, `crates/knock-verify` | Each site's verifier: `/challenge`, `/verify`, SQLite | Rust (alloy) |
| `contracts/` | `KnockBinding`, staging and prod deploy scripts | Solidity, Foundry |
| `spec/` | Protocol spec (CC0), JSON schemas, test vectors, written in M0 | Markdown |

Secrets (RP key, gas key) live in `.env` / a local key file, both **gitignored**; they're read only by `knockd`. They never go in the repo, the browser, or this file.

## 6. Plan for the 36-hour window

T0 = when the deadline was given (2026-11-05). Commit at the end of each block. Hours are cumulative and tentative.

| Hours | Block | Done when |
|---|---|---|
| 0–2 | **M0 Setup**: Bun workspace and `@knock-dev/protocol` (Foundry, Cargo and Next.js come when first needed, D14), read the Safe Signer source, ENS day-one check (R1), check the RP and gas keys, test vectors for the 4 EIP-712 digests in `spec/vectors/v1.json` | tests pass, vectors agree in TS (viem + a hand-rolled encoder) |
| 2–10 | **M1 Wedgie app**: fork Safe Signer; `knock_hello`, `knock_pass` with press/counter/state machine, screens, QR encoder, then `knock_enroll`/`knock_bind`/`knock_confirm`, Human badge. Real hardware | `wedgie.py` shows a signed `knock_pass` after a green press; Safe Signer still works |
| 6–12 | **M2 `KnockBinding`** (parallel): Foundry tests, fork test with a Simulator proof, deploy staging (then prod), measure gas | `bind()` emits `Bound` on chain 480 staging |
| 10–18 | **M3 `knockd` + Console**: `/rp-context`, `/sign-bind`, IDKit with the QR on the Wedgie, bind tx, ENS subname + records (Sepolia first, then mainnet) | one real enrollment end to end, Human badge on device |
| 18–26 | **M4 Door + `door-sdk` + verifier**: popup protocol, V1–V8, atomic commit, revoke path | a site accepts a knock and rejects a revoked one |
| 26–32 | **M5 Bouncer + demo**: checklist UI, bot script, spare device, demo script, reset procedure | full demo runs twice without edits |
| 32–36 | **Buffer**: README (with honest limits), recording, deploy | submitted |

**Cut order if behind** (first to go → last): Fresh mode, `knock.att` attestation, Helios, local bridge, Anon-RPC, "send it yourself". Anon-RPC and IPFS are **stretch**. Anon-RPC goes in only if M5 finishes with 4+ hours to spare. Mainnet ENS writes: rehearse on Sepolia, and keep Sepolia as the demo fallback.

## 7. Risks

- **R1 (resolved 2026-11-06) – ENSv2 live status.** Verified on chain: ENSv2 is live and `itzraj.eth` is in the v2 registry (facts in §4). Both Universal Resolver addresses answer correctly; we use the proxy (D14). The verifier's chain config still supports Sepolia as a fallback.
- **R2 (corrected) – Expiry units.** World's `expires_at_min` / `expiresAtMin` is a **Unix-seconds lower bound**: "min" means minimum, not minutes (World's own example is `1756166400`). The `Bound` expiry check ("zero or later than now") compares seconds with no conversion. Tests should still cover the boundary.
- **R3 – Built on Safe Signer.** The app must keep every `safe_*` request working and pin a Safe Signer version. Forks drift. First task in M1: read the source.
- **R4 – World production vs staging.** Real World App users need a production action. Develop against staging + Simulator. Never accept staging deployments in a production verifier.
- **R5 – 36 hours.** The core loop (M1–M5) comes first; see the cut order.
- **R6 – Gas key balance is ~$2.** Fine for staging binds (a fraction of a cent each), but watch it; rate limits in `knockd` bound the damage if it leaks.
- **R7 – Honest limits (keep in the README)**: no PIN on the Wedgie (a thief can knock until revoked); proof farming is not solved; the shared public nullifier is linkable across sites in Bound mode; installed apps can use the chip (S1 vs S2); the origin is "unverified" on the device; the Wedgie is not an audited hardware wallet.
- **R8 – Door origin.** Web Serial permission is per origin, and the port is exclusive (the Door and `wedgie.dev/safe` can't run together).
- **R9 – One wallet for controller and revoker** (D9) means a compromised wallet can both rename and revoke, and there's no separate low-power revoke key. Acceptable for now; revisit with a status-only role if time allows.
- **R10 – Wedgie RAM.** Only ~74 KB is free at idle. Knock code goes in per-request modules shipped as `.mpy` (the `safe_msg` pattern), and the QR uses a fixed mask (D13). Check free RAM with `wedgie.py debug` after each new message.

## 8. Inputs and status

- World RP signing key: **provided** in a local JSON key file (gitignored). It holds only the key (`privateKey` + its address), **not** the `app_id` or `rp_id`. Those still need to go in `.env` as `WORLD_APP_ID` / `WORLD_RP_ID` (names in `.env.example`) before M2, because `rp_id` is baked into `KnockBinding` at deploy. The `knock-bind` action in staging + prod: still to confirm.
- Gas key for `knockd` on World Chain: **funded** (~0.001 ETH, checked on chain), key in `.env` (gitignored).
- Wallet: one wallet is controller, `addr` target, and revoker (D9).
- Parent name: `itzraj.eth`, on ENSv2, available.
- Wedgie app repo: separate public repo (D10), local at `$HOME/knock-wedgie`; the GitHub name is TBD (`knock-wedgie` proposed).

## 9. Sources

- https://wedgie.dev/skill.md, /code.md, /trustm.md, /usb.md
- https://docs.world.org/world-id/SKILL.md, /world-id/idkit/integrate, /world-id/idkit/onchain-verification; github.com/worldcoin/world-id-protocol `contracts/deployments/core/production.json`
- https://docs.ens.domains/llms-full.txt (first 100k of ~1.8M chars), /ensv2/enhanced-access-control, /ensv2/tutorial-contract-developers, /learn/deployments

## 10. Changelog (prompts and decisions)

- **2026-11-05** – Initial prompt: Knock concept (Console, SDK, Door, bind() on World Chain, ENSv2 subname, Wedgie attestation, selective disclosure, fun-first). Rules: keep PLAN.md updated; git repo with frequent commits; plan only.
- **2026-11-05** – User answers: ENSv2 launched; World ID has an on-chain verifier (confirmed, D2); physical Wedgie; Rust backend, Foundry, Next.js; user-chosen names and multiple devices. Added the detailed design (§3), risks, and a first schedule.
- **2026-11-05** – IPFS deferred, Next.js everywhere (D7/D8); `itzraj.eth` available on ENSv2; deadline 36 hours; Anon-RPC demoted to stretch; 36-hour schedule and cut order added.
- **2026-11-06** – User: World RP keys are in a local JSON file; gas key funded (~$2) in `.env`; one wallet is controller, `addr` target and revoker (D9); Wedgie app gets its own repo (D10). Cleaned the repo and its history; secrets are gitignored and never committed.
- **2026-11-06** – M0: added `@knock-dev/protocol` (EIP-712 digests, helpers, P-256 verify) and `spec/vectors/v1.json`; viem and a hand-rolled encoder agree, 13 tests pass. Verified ENSv2 live and `itzraj.eth` in v2 (R1 resolved). Corrected R2 (`expires_at_min` is a seconds lower bound). Read the Wedgie and Safe Signer; decided the fork approach (D10–D14) and added R10 (RAM). User: use the `@knock-dev` npm scope (D15).
- **2026-11-06** – User: make the app's icon as an SVG, then PNGs at several sizes. Door with knock lines, picked over two door-knocker versions (D16).
- **2026-11-06** – User: use Bun. Bun workspaces, `bun test` and `bun.lock` replace npm, vitest and tsx (D11). Same 13 tests pass; vectors unchanged.
