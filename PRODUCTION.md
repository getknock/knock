# Production checklist

Last checked: **2026-11-07**. This is the release list, in deadline order. `PLAN.md` remains the design and decision record.

## Critical path

- [ ] **Commit and push the code and docs.** The Human Club's World ID + wallet flow (D35), its brand assets, and the docs update must be on their repos' `main` branches before Vercel can serve them.
- [ ] **Let Vercel deploy, then check the deployments.** The Console/Door, docs and Human Club should each finish without a new environment setting. The club creates its new `world_sessions` table itself; there is no manual database migration.
- [ ] **Run the live Human Club smoke test** at `https://club.getknock.dev`, with a wallet and World App:
  1. Come in with World ID and a wallet, making the first Knock binding.
  2. Do a second act, proving the returning World ID session without signing the wallet in again.
  3. Sign one petition with World ID, then try the same petition as the same human with a Wedgie. Check 8 must refuse the second signature.
  4. Start a fundraiser with World ID and check its payout wallet is the wallet that signed in. Send a small gift and check it appears once.
  5. Close that fundraiser with World ID.
- [ ] **Finish M4 with real hardware.** A real Wedgie knock gets into the Human Club; a revoked or killed test name does not. Use a name made for testing.
- [ ] **Try the Console's installer on a real Wedgie** (D37): install or update from `getknock/wedgie`'s latest commit, then run a knock. This has passed only against a pretend Wedgie so far.
- [ ] **Publish the npm packages** when the account's two-factor authentication is available; see below. This does not block the sites.
- [ ] **Submit Knock's prepared World App listing for review**, only after the user's explicit OK. This does not block the sites either.

## Verified locally

- [x] **All TypeScript tests and type-checks pass.** The Human Club has 55 tests, including one human across both ways in, replay refusal, held-step separation and fundraiser payout.
- [x] **Rust passes:** 34 tests across `knock-verify`, `knockd` and `knock-verifier`; the opt-in live verifier test remains separate.
- [x] **Contracts pass:** 30 unit, fuzz and World Chain fork tests.
- [x] **Production builds pass:** Console + Door, Human Club, and the docs.
- [x] **npm staging passes:** `bun scripts/npm.ts --check` packs all three packages, installs them in a new project, imports them in Node and checks their types with tsc.
- [x] **The Wedgie app's offline suite passes.** No hardware result is implied by that.
- [x] **Visual review passes:** Console, docs, Door and Human Club at desktop and 390px phone widths; Console, docs and Door in light and dark; the Door at popup size; the club's sign-in, start and petition pages. No horizontal page overflow or browser errors were reported.
- [x] **The existing public services answer:** the Console, Door, docs and Human Club return HTTP 200; `knockd`'s `/health` is `ok: true` with `signs: true` on chain 480.

## Deploy and verify

1. Push `getknock/knock` and `getknock/docs`. Vercel deploys their configured projects; the Wedgie repo has no change to release.
2. Confirm the intended production deployments are ready, not merely queued or building.
3. Check every public route again:

   ```bash
   curl -fI https://getknock.dev
   curl -fI https://door.getknock.dev/knock
   curl -fI https://docs.getknock.dev
   curl -fI https://club.getknock.dev
   curl -f https://knockd.getknock.dev/health
   ```

4. Check the club's new pages and API exist in production: `/in`, `/api/world/wallet`, `/api/world/ask` and `/api/world/proof`. Do not send a real proof to a route just to see whether it exists.
5. Run the live Human Club and real-hardware smoke tests above. Watch Vercel's function logs and Fly's logs while doing them; do not print tokens, RP keys, gas keys or session secrets.
6. Re-check the docs' Human Club and knockd pages on the deployed docs site.

### Production settings

- **Human Club:** `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `CLUB_ORIGIN` must remain set. D35 needs no new required variable: production defaults to Knock's `knockd` and World ID's production environment. Set `CLUB_KNOCKD` or `CLUB_WORLD_ENV` only to override those. Keep `CLUB_WORLD_ENV=production` for World App.
- **Console + Door:** static export; keep its production knockd and RPC settings as deployed. `frame-ancestors 'none'` must remain on both.
- **Docs:** static export; no secrets.
- **knockd:** keep one always-on machine and its existing RP and gas secrets. Its health answer must keep `ok: true` and `signs: true`.

## npm, when 2FA is ready

The staged packages are in `out/npm/`. Publish in dependency order, supplying the account's one-time code when npm asks:

```bash
npm publish out/npm/protocol --access public
npm publish out/npm/verify --access public
npm publish out/npm/door-sdk --access public
```

Then install each from npm in a fresh directory and check its version is `0.1.0`. Update the docs' "Where Knock is today" note only after all three are publicly installable.

## Not release blockers

- World App review can proceed independently of the code deploy.
- npm publishing can proceed independently of the code deploy.
- Fresh mode (mode 2), attestation display and the other cut-order items stay out of this release.
