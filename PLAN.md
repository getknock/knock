# Knock

> Your Wedgie, but it vouches that you're a human. "Wallet address; with humanity."

Status: **planning only** (no code yet). This file is the living plan. It gets updated whenever the user prompts, gives info, or decisions change. See the changelog at the bottom.

Principle: it's fun first. Practicality (testnet faucets, airdrops) is a bonus. Over-engineering is explicitly OK.

---

## 1. Pitch

A Wedgie (Raspberry Pi Pico + 240x240 LCD + Trust M secure chip) becomes a pocket **proof-of-humanity + ENS identity token**.

- **Setup (once)** via *Knock Console* (web app): verify World ID, bind it on World Chain, mint an ENSv2 subname, store everything on the Wedgie.
- **Use (anywhere)**: a dApp has a "Knock" button. The user opens *Knock Door* (a web page that holds the single Web Serial connection), and the dApp's request shows up on the Wedgie screen. The user presses green, and the Wedgie answers with a signed, selective-disclosure response. The dApp verifies the answer against the chain and ENS.

It works like World ID in a tiny device, with its own expiry and a "show only what's asked" model.

## 2. Components

| # | Component | What | Tech (proposed) |
|---|---|---|---|
| A | **Knock app for Wedgie** | MicroPython app, installed from a public GitHub repo via wedgie.dev/connect. Holds the key, displays requests and QR codes, signs. | MicroPython, `optiga` module, `ui`/`lcd`/`keys`/`save` |
| B | **Knock Console** | Web setup wizard. IDKit → bind() on World Chain → ENS subname → write to Wedgie. | TS, Vite/Next, `@worldcoin/idkit` v4, viem, Web Serial |
| C | **Knock Door** | Web page that owns the serial port and relays dApp requests to the Wedgie and responses back. Wedgie supports only one connection, so Door is the only thing that talks to it. | TS, Web Serial, BroadcastChannel / postMessage / popup |
| D | **Knock SDK** (`@knock/sdk`) | dApp-side: `knock.request({...})` opens/pairs with Door; `knock.verify(response)` does all the checks. | TS, viem, WebCrypto (P-256) |
| E | **Contracts** | `KnockBinder` (World Chain mainnet) and `KnockRegistrar` (ENSv2 chain; see risks). | Solidity, Foundry |
| F | **Demo dApp** | A fun faucet / "humans only" page that uses the SDK. | TS |
| G | **Protocol spec** | Message formats, signed payload layout, verification algorithm. Shared by B/C/D/A. | Markdown + shared TS package |

Proposed repo layout (monorepo):

```
knock/
  PLAN.md
  docs/protocol.md
  wedgie-app/        # A: wedgie.json + knock*.py
  apps/console/      # B (+ C as /door route, same origin)
  apps/demo/         # F
  packages/sdk/      # D
  packages/protocol/ # shared types, canonical encoding, verify logic
  contracts/         # E (Foundry)
```

## 3. What the docs gave us (facts that shape the design)

**Wedgie** (wedgie.dev/skill.md, code.md, trustm.md, usb.md)
- One app at a time. Any public GitHub repo with `wedgie.json` can be installed (unsigned, **full device access**, needs a green press on device). Shelf apps are reviewed and signed (email wedgie@buidlguidl.com).
- Secure chip: OPTIGA Trust M (I2C 0x30) or ATECC608. **P-256 only, no secp256k1.** Keys are generated in the chip and never leave it. `c.genkey(optiga.KEY3)` returns the public key once (the app must save it). `c.sign(slot, digest)` signs a digest we supply. KEY2 and DATA[11] belong to Safe Signer, so we use KEY3 or KEY4.
- Factory key (slot E0F0) with an Infineon-signed certificate in `CERT` (E0E0, ~485 B), readable via `c.read(optiga.CERT)`. This is our **attestation root**. The docs do not describe an attestation procedure beyond this.
- Display: 240x240, 16 colors, ST7789, via `lcd.LCD()`. Input: joystick + A (green), B, X, Y (red). `ui.ask`, `ui.page`, etc. exist. **No QR helper is mentioned.**
- Storage: `save.store/load` at `/saves/<mod>/`. Readable by any plugged-in computer, so **public data only**. Survives app updates, not `/reset`.
- Host link: USB serial, JSON lines at 115200 baud, 6 KB max line. Web Serial needs Chrome or Edge. Manifest flag `"usb": true` means the app speaks its own USB protocol and the firmware stops answering USB. The device is sealed, and sensitive operations need a physical green press. The `open` request, `shot` and `press` need an approved `open`.
- Networking is allowlisted in `wedgie.json` `"net"`, with host-relayed TLS and 6 KB response caps. We probably don't need it, since the Console and Door do the chain work.
- Not an audited hardware wallet. A lost device means a lost key, so rebinding must be a first-class flow.

**World ID** (docs.world.org/world-id/SKILL.md; `world.id/SKILL.md` 301s there)
- `@worldcoin/idkit` v4, `IDKitRequestWidget`, preset `proofOfHuman` (Orb). Flow: the server signs an RP context (`@worldcoin/idkit-core/signing`), the widget runs, and the **unmodified** result is POSTed to `https://developer.world.org/api/v4/verify/{rp_id}`. The nullifier is the uniqueness key, unique per (action, nullifier). Staging works only with the simulator, production only with the real World App.
- **Gaps** (the page didn't cover them): on-chain verifier contract on World Chain for v4 proofs, proof expiry, how the connect URL / QR is built. See open questions.

**ENSv2** (docs.ens.domains/llms-full.txt, ensv2 pages)
- Per-name registries. Subnames are minted with `register(label, owner, subregistry, resolver, roleBitmap, expiry)` on the parent's own registry (a `UserRegistry` proxy via the Verifiable Factory), then `setSubregistry` on the parent. Don't build on the Name Wrapper.
- **Enhanced Access Control** replaces fuses. Roles are in a bitmap. `grantRoles/revokeRoles` apply per name, `grantRootRoles/revokeRootRoles` contract-wide. `ROLE_REGISTRAR = 1<<0`, `ROLE_RENEW = 1<<16`. Omit `ROLE_CAN_TRANSFER_ADMIN` to make a subname non-transferable. Expiry is an absolute timestamp. Resolver: a Permissioned Resolver per account, with text records.
- **ENSv2 is deployed on Sepolia only** per the docs. Min libs: viem ≥ 2.35.0, ENSjs ≥ 5.2.5 for writes.

## 4. Architecture

### 4.1 Identity model

Three linked facts form the **Knock Binding**:

1. **Human**: a World ID nullifier `N` (proof of human).
2. **Device**: a P-256 pubkey `P` generated inside the Wedgie's Trust M (+ Infineon cert chain).
3. **Wallet**: an EVM address `W` (the user's connected wallet).

Stored in three places that cross-reference each other (this is what makes revocation work):

- **World Chain, `KnockBinder.bind(...)`**: emits and stores `(N, P_hash, W, expiry)` → `bindTx`. Rebinding the same human replaces the old binding, so one human has one active Wedgie. A `revoke()` is also available (by `W`).
- **ENSv2 subname** `<handle>.<knock-parent>`: owned by `W`, `addr` = `W`, text records `knock.bindTx`, `knock.pubkey`, `knock.chain=480` (World Chain id), and `knock.cert` (hash or pointer to the attestation). Roles are limited: non-transferable, resolver locked, expiring. Revocable by the registrar (details pending the ENSv2 role set).
- **Wedgie `/saves/knock/`**: ENS name, bindTx, pubkey, expiry, and public metadata. Nothing secret is stored there.

### 4.2 Setup flow (Console)

```
0. Prereq: install "Knock" app on Wedgie from GitHub at wedgie.dev/connect.
1. Console connects via Web Serial -> Knock app answers hello {chip, uid, version}.
2. Wedgie generates P-256 key in Trust M (KEY3), returns P + device cert (+ factory-key
   signature over P as attestation, if the chip allows signing with the factory key).
3. IDKit: Console server signs RP context -> IDKitRequestWidget -> user scans the QR
   (QR also shown on the Wedgie screen) -> proof -> verified -> nullifier N.
4. Console sends bind(N, hash(P), W, expiry, proof/attestation) to KnockBinder on World Chain,
   signed by W in the browser wallet. Get bindTx.
5. Console mints ENSv2 subname to W (via KnockRegistrar), sets records incl. bindTx.
6. Console writes {ensName, bindTx, expiry, ...} to the Wedgie. The Wedgie shows green "Knocked in".
```

### 4.3 Request flow (SDK + Door)

```
dApp --knock.request({want:["ens","poh"], origin, nonce, ttl})--> Door (popup / BroadcastChannel)
Door --> Wedgie (serial): {t:"knock", origin, want, nonce, exp}
Wedgie screen: "faucet.xyz knocking. Wants: ENS name, Human. [Green = open] [Red = no]"
              (joystick can untick optional fields = selective disclosure)
Green -> chip signs sha256(canonical(payload)) with P
Wedgie --> Door --> dApp: {ens?, bindTx?, pubkey, sig, cert, claims, nonce, exp}
dApp: knock.verify(resp):
  1. nonce/origin/expiry match what we asked
  2. P-256 sig valid under P (WebCrypto)
  3. cert chain valid -> genuine Trust M (Infineon root) [+ factory-key attestation of P]
  4. World Chain: bindTx / KnockBinder says (N, hash(P), W) active & not expired
  5. ENS: name resolves, addr == W, text knock.bindTx == bindTx, not expired/revoked
  6. => PoH on World Chain + wallet address W from ENS. Done.
```

Any mismatch (revoked, rebound elsewhere, subname moved or expired) → **reject**.

### 4.4 Selective disclosure ("it's like World ID, in a tiny device")

The request lists scopes: `ens`, `poh`, `wallet`, `expiry`. The Wedgie answers only what's asked. Optional scopes can be toggled on the device. Responses are always bound to `origin + nonce`, so they can't be replayed on another site. Per-dApp "visitors" (remembered origins) can show a badge on the screen.

## 5. Fun / over-engineering backlog

Roughly in order of "gives me joy per effort":

- **Knock-knock confirm**: the confirm gesture is a double press (A-A). The screen flashes green with a door animation. Red = door slams.
- **Peephole screen**: shows the origin, favicon-ish glyph, and what it wants.
- **IDKit QR on the Wedgie's own screen** during setup (Console encodes the QR matrix and sends it over serial, and the app draws modules; no MicroPython QR encoder needed).
- **Expiry ring**: the badge visibly counts down on the idle screen. When expired it goes grey and "Knock again" re-verifies.
- **Visitor log**: the last N origins that knocked, stored on the device.
- **Door sounds / button-LED-style flashes** (screen only; the hardware has no buzzer).
- **Demo faucet** gated by Knock, plus a "humans only" guestbook that shows ENS names.
- **Role showcase**: ENS subname variants (a guest pass that is time-limited and non-transferable; a signing-limited one).
- **On-chain P-256 verify** (RIP-7212 / precompile, if World Chain has one) so contracts can check a Wedgie signature directly. This gives us "Knock-gated smart contracts".

## 6. Milestones (each ends in a commit)

- **M0 – Repo + spec**: repo skeleton, `docs/protocol.md` (message formats, canonical payload, verification algorithm).
- **M1 – Wedgie app skeleton**: `wedgie.json`, hello/keygen/sign over serial, screen UI. (Needs a physical Wedgie to test; otherwise use the virtual wedgie `window.wedgie` page.)
- **M2 – Contracts**: `KnockBinder` (Foundry tests + fork tests), `KnockRegistrar` against ENSv2 Sepolia.
- **M3 – Console**: Web Serial, IDKit, bind tx, ENS mint, device write.
- **M4 – Door + SDK**: request/response relay, `verify()` with all 6 checks.
- **M5 – Demo dApp** and polish (knock-knock UX, expiry ring, QR on device).
- **M6 – Hardening**: rebind/rotate/revoke flows, threat-model doc, optional shelf submission to Wedgie.

## 7. Risks, caveats, honest "how stupid is it"

**Verdict**: not stupid. It's a good, fun idea. Parts of it are weaker than they sound, and I'd rather say that up front.

- **"Secure chip attestation" is weaker than it sounds.** The Infineon cert proves *a real Trust M exists*. It doesn't prove *our firmware* is the one asking it to sign. By default, any program on the Wedgie can use `KEY2–4`, and GitHub-installed apps are unsigned with full access. So the attestation proves "a genuine chip holds this key" (good enough for fun and for faucets), but not "only Knock can use it". Mitigations are to lock the slot's metadata (permanent, dangerous), to apply for the signed Shelf, or to treat it as honest-but-limited in the spec.
- **Presence ≠ wallet control.** Per-session signatures prove "the bound device was physically present and a human pressed green". Wallet control was proven once, at bind time. I think that's fine, and the spec should say it clearly.
- **No transfer-resistance beyond the bind.** Someone can sell or lend the Wedgie. Revocation and expiry limit the damage. That's inherent to any PoH token.
- **ENSv2 is Sepolia-only right now** (per the docs I read). World Chain is mainnet (the user's requirement). So the dApp-side verification spans **World Chain mainnet + ENS on Sepolia** until ENSv2 ships on mainnet. Fine for a hackathon-style demo, and bad for real airdrops.
- **World ID on-chain verification is unclear for v4.** The docs say to POST to the developer-portal verify API. The `bind()` contract may therefore not verify a ZK proof itself and would instead trust a Knock verifier signature (a centralization point) unless an on-chain v4 verifier exists. Needs digging.
- **Wedgie is P-256 only**, so it can't sign EVM transactions or messages. It signs Knock payloads only. The wallet stays separate (consistent with the design).
- **Web Serial = Chrome/Edge only**, and a single connection. The Door-as-hub design handles that, but browser extension pairing between Door and dApp tabs needs care (popup vs BroadcastChannel; origin checks).
- **Custom USB protocol trade-off**: `"usb": true` stops the firmware answering USB, so the app must implement hello/keygen/sign itself, or we use the firmware's request channel if possible. To investigate.
- Not audited anywhere in this chain. Treat as a toy until reviewed.

## 8. Open questions (to resolve before/during build)

1. **World ID on-chain**: is there a v4 verifier on World Chain? What is a proof's validity window? How is the IDKit connect URL produced, so we can render it on the device? (`docs.world.org/world-id/idkit/integrate` and the signatures spec are the next reads.)
2. **ENSv2 roles list** (`/ensv2/permissioned-registry`): which roles exist for revoke/unregister and expiry? Can the parent revoke a subname (burn / set expiry to now)? Exact Sepolia deployment addresses (`/learn/deployments#sepolia-ensv2`).
3. **Trust M attestation**: can the factory key (E0F0) sign an arbitrary digest (e.g. over `P`)? Does the cert chain to a published Infineon root we can embed in the SDK?
4. **Wedgie app↔host protocol**: how does a `usb:true` app receive custom requests? How do we render the host's QR matrix efficiently on a 16-color framebuffer? Virtual wedgie (`virtual.md`) for dev without hardware?
5. **Chain for ENS**: stay on Sepolia ENSv2 for the demo, or wait for mainnet? Who owns the parent name (e.g. a `knock.*` name on Sepolia)?
6. **Does the user have a physical Wedgie now**, or do we build against the virtual one first?
7. **Naming**: ENS handle is user-chosen (`alice.knock...`) or derived (nullifier prefix)?
8. **Stack preferences**: Next.js vs Vite; Foundry vs Hardhat. (Defaults: Vite + Foundry.)

## 9. Sources read

- https://wedgie.dev/skill.md, /code.md, /trustm.md, /usb.md
- https://docs.world.org/world-id/SKILL.md (redirect target of world.id/SKILL.md)
- https://docs.ens.domains/llms-full.txt (first 100k chars of ~1.8M), /ensv2/enhanced-access-control, /ensv2/tutorial-contract-developers

## 10. Changelog (prompts and decisions)

- **2026-11-05** – Initial prompt: Knock concept (Console, SDK, Door, bind() on World Chain, ENSv2 subname with limited roles, Wedgie attestation, selective disclosure, fun-first). Ground rules: keep this PLAN.md updated with each prompt; git repo with frequent commits; **plan only for now**. Research done on the 3 docs, plan drafted.
