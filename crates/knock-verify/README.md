# knock-verify

A site's check of a [Knock](https://docs.getknock.dev): a press on a Wedgie, a USB device bound to one human with World ID and named in ENS. `knock-verify` runs the checks V1 to V8 in order and fails closed. It reads the name's records from ENS on Ethereum mainnet, the human's binding from World Chain, and the press from the Wedgie's P-256 signature under the key ENS holds. What a knock uses up goes in one SQLite transaction, written only once every check has passed.

It's what [`knock-verifier`](https://crates.io/crates/knock-verifier) runs. Use it when your server is in Rust and you'd rather not run a second service. If your server runs JavaScript or TypeScript, use [`@knock-dev/verify`](https://www.npmjs.com/package/@knock-dev/verify).

```bash
cargo add knock-verify
```

```rust
use knock_verify::{Store, Strict, Verifier, accepted_binding};

let verifier = Verifier::new(
    chain,                              // your Chain: mainnet and World Chain
    Store::open("knock.db")?,           // or ":memory:" for tests
    "https://club.example".to_string(), // the origin knocks must be for
    accepted_binding(),                 // KnockBinding v3, production
    365 * 86_400,                       // the oldest binding it takes, in seconds
)
.strict(Strict::Off);

// For the page: pass challenge.challenge to door-sdk's knock()
let challenge = verifier.challenge(now).map_err(|r| anyhow::anyhow!(r.why))?;

// The knock the page sent back
match verifier.verify(&assertion, Some("enter"), now).await {
    Ok(knocked) => println!("in: {} (human {})", knocked.name, knocked.nullifier),
    Err(no) => println!("refused at check {}: {} ({})", no.check, no.why, no.error),
}
```

Its types are alloy's (`Address`, `B256`, `U256`), from alloy 2.5. It needs Rust 1.88 or later (edition 2024).

The reference, with the `Chain` trait and every public item, is at [docs.getknock.dev/reference/knock-verify](https://docs.getknock.dev/reference/knock-verify). The checks themselves are in [the checks reference](https://docs.getknock.dev/reference/checks).

MIT licensed.
