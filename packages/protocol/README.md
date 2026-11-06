# @knock-dev/protocol

What a Wedgie signs for [Knock](https://docs.getknock.dev), in TypeScript. A Wedgie is a USB device bound to one human with World ID and named in ENS; it signs with a P-256 key that never leaves its secure chip. This package has the EIP-712 messages it signs (`KnockHello`, `KnockEnroll`, `KnockBind` and `KnockPass`), their digests, and the key helpers.

```bash
bun add @knock-dev/protocol
```

```ts
import { digest, verifySignature } from '@knock-dev/protocol'

// The KnockHello digest for a challenge, and whether the Wedgie's (r, s) is its key's signature over it
const d = digest('KnockHello', { challenge })
const ok = verifySignature(d, r, s, key) // key: compressed P-256, as ENS holds it
```

A site doesn't need it to take knocks: [`@knock-dev/door-sdk`](https://www.npmjs.com/package/@knock-dev/door-sdk) gets the knock, and [`@knock-dev/verify`](https://www.npmjs.com/package/@knock-dev/verify), which builds on this package, checks it.

[The protocol reference](https://docs.getknock.dev/reference/protocol) has each message, field by field. The test vectors, a published test key's signatures that the Wedgie's own tests check too, are in [`spec/vectors/v1.json`](https://github.com/getknock/knock/blob/main/spec/vectors/v1.json).

MIT licensed.
