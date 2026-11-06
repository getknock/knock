# knock-verifier

The service that decides whether a [Knock](https://docs.getknock.dev) gets in. Run it beside your site. It gives out challenges and checks knocks (V1 to V8, with [`knock-verify`](https://crates.io/crates/knock-verify)) for one origin, yours, and keeps what it has seen in a SQLite file. It reads ENS on Ethereum mainnet and bindings on World Chain over RPC. It needs no keys and never calls Knock.

```bash
cargo install knock-verifier
VERIFIER_ORIGIN=https://club.example knock-verifier
```

Your server asks it two things: `POST /challenge` for a knock's challenge, and `POST /verify` with the knock the page sent back. Everything is set from the environment, and `VERIFIER_ORIGIN` is usually the only setting you need. [Run a verifier](https://docs.getknock.dev/guides/verifier) lists the rest, and [the verifier's API](https://docs.getknock.dev/reference/verifier-api) has every request and answer.

If your server runs JavaScript or TypeScript, you don't need the service: [`@knock-dev/verify`](https://www.npmjs.com/package/@knock-dev/verify) runs the same checks inside it.

MIT licensed.
