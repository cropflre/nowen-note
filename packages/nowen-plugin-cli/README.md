# nowen-plugin CLI

Use `npx nowen-plugin create|dev|validate|doctor|test|pack|sign|login|publish` in a V1 or V2 plugin project.
`pack` emits `.nowen-plugin` and `.sha256`; `sign` creates an Ed25519 signature over the SHA-256 digest. Publisher private keys remain local or in CI secrets.
