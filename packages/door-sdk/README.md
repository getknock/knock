# @knock-dev/door-sdk

The browser side of [Knock](https://docs.getknock.dev). A Wedgie is a USB device bound to one human with World ID and named in ENS, and a knock is one press of its green button. `knock()` opens the Door, Knock's popup, which asks the visitor's Wedgie over USB and hands the knock back to your page. One file, no dependencies.

```bash
bun add @knock-dev/door-sdk
```

```ts
import { KnockError, knock } from '@knock-dev/door-sdk'

button.onclick = async () => {
  // Your verifier's challenge: the Door opens at once, and gets it when it arrives
  const challenge = fetch('/knock/challenge', { method: 'POST' })
    .then((r) => r.json())
    .then((c) => c.challenge)
  try {
    const assertion = await knock({ challenge })
    await fetch('/knock/verify', { method: 'POST', body: JSON.stringify(assertion) })
  } catch (e) {
    if (e instanceof KnockError) console.log(e.code, e.message) // blocked, closed, timeout, rejected…
  }
}
```

Call it from a click: it opens a popup, which browsers allow only then. The Door talks to the Wedgie through Web Serial, so knocking needs a desktop Chromium browser, such as Chrome, Edge, Brave or Arc.

Trust nothing in a knock until your verifier says it's good. [`@knock-dev/verify`](https://www.npmjs.com/package/@knock-dev/verify) checks it inside your server, and [`knock-verifier`](https://crates.io/crates/knock-verifier) beside it.

[The reference](https://docs.getknock.dev/reference/door-sdk) has every export, the knock field by field, and each error. [The quickstart](https://docs.getknock.dev/quickstart) puts a knock on a page.

MIT licensed.
