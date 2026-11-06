# @knock-dev/verify

A site's check of a [Knock](https://docs.getknock.dev), inside its own server: a press on a Wedgie, a USB device bound to one human with World ID and named in ENS. It runs the checks V1 to V8 in order and fails closed. It reads the name's records from ENS on Ethereum mainnet, the human's binding from World Chain, and the press from the Wedgie's P-256 signature under the key ENS holds. What a knock uses up is written all at once, once every check has passed.

```bash
bun add @knock-dev/verify
```

```ts
import { Refusal, Verifier, memoryStore } from '@knock-dev/verify'

const verifier = new Verifier({ origin: 'https://club.example', store: memoryStore() })

// POST /knock/challenge: its challenge goes to door-sdk's knock() on the page
const { challenge } = await verifier.challenge()

// POST /knock/verify, with the knock the page sent back
try {
  const knocked = await verifier.verify(assertion, { action: 'enter' })
  console.log(`in: ${knocked.name}, human ${knocked.nullifier}`)
} catch (e) {
  if (e instanceof Refusal) console.log(`refused at check ${e.check}: ${e.why} (${e.error})`)
  else throw e
}
```

`memoryStore()` keeps the challenges, each Wedgie's counter and each human's entries in the process's memory, which does for one process. `libsqlStore()` keeps them in SQLite or Turso, with a client from `@libsql/client`. It reads the chains over public RPCs unless you pass your own. It runs in your server, never in the visitor's browser.

The page's side is [`@knock-dev/door-sdk`](https://www.npmjs.com/package/@knock-dev/door-sdk). For a server in another language, [`knock-verifier`](https://crates.io/crates/knock-verifier) runs the same checks as a service.

[Check knocks in your server](https://docs.getknock.dev/guides/verify-in-your-server) shows it in use, with every setting. [The reference](https://docs.getknock.dev/reference/verify) has every export, and [the checks reference](https://docs.getknock.dev/reference/checks) each refusal.

MIT licensed.
