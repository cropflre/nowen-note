# Nowen Extension Platform V2

V2 turns the V1 Action host and V1.2 Automation engine into an open extension ecosystem. The four stable contracts are Manifest V2, Registry Protocol V2, Ed25519 publisher/registry signing, and the QuickJS/WASM sandbox.

## Compatibility and runtimes

- API V1 remains strict and supported with `node-action`.
- API V2 is parsed separately. IDs are publisher namespaces (`publisher.extension`).
- V2 supports `sandbox-js` and trusted `node-action`. Community Registry packages must use `sandbox-js`.
- Sandbox bundles are browser IIFEs that expose `globalThis.__nowenPluginModule`; they have no `process`, `require`, `fetch`, Node modules, environment, filesystem, raw sockets, or database handles. The only bridge is the permission-checked Host API.
- Each sandbox receives a 64MB heap, 512KB stack, deadline interrupt and 1,000-call Host API ceiling. Existing result-size, input-size, network SSRF and permission limits still apply.

## Trust chain

The client verifies, in order:

1. HTTPS source and configured Registry Ed25519 public key.
2. Registry signature over recursively canonical JSON.
3. Active, time-valid, non-revoked publisher key from that signed index.
4. Artifact SHA-256.
5. Publisher Ed25519 signature over the raw SHA-256 digest.
6. Manifest identity/version/publisher equality and Nowen compatibility.
7. Enterprise policy and security advisory state.

Signed metadata is fail-closed. Version coordinates are immutable; a source that changes a cached version's digest or signature is rejected. Registry installation rejects downgrades; rollback can only select a locally retained, previously verified version.

## Registry protocol

The client accepts any configured HTTPS source with a pinned Registry public key. The standalone reference service lives in `packages/nowen-extension-registry` and exposes:

- `GET /v2/index.json` — signed publishers, versions and security advisories.
- `GET /v2/extensions/:id` and `GET /v2/artifacts/:id/:version`.
- GitHub OAuth developer login, Publisher/key management and revocation.
- `POST /v2/publish` — immutable signed package upload and security scan.
- Versioned reviews, reports, signed kill-switch advisories and aggregate-only telemetry.

The Marketplace service is deliberately not part of the personal Nowen backend.

## Updates and recovery

Installed extensions retain multiple versions, support manual/notify/automatic policies and version pins, and expose permission diffs before update. New permissions, Runtime/API changes or key changes cannot be silent. A new version enters a five-Action probation window; an execution failure rolls it back and disables it for review. Signed `revoked` or `malicious` advisories with `disable` action stop the affected version.

Backup restore never restores trust: extensions return to quarantine, permissions are revoked, and restored automation remains disabled until explicit review.

## Declarative contributions

Manifest V2 supports commands, safe menu locations, generated settings and Automation templates. Contributions are data rendered by Nowen; extensions cannot inject React, edit the Tiptap schema, access native Electron/Android APIs, or mount arbitrary DOM. Secret settings use the encrypted Plugin Secret store. Installing an Automation template creates a disabled workflow.

## Developer workflow

```bash
npx nowen-plugin create
npx nowen-plugin dev
npx nowen-plugin validate
npx nowen-plugin doctor
npx nowen-plugin test
npx nowen-plugin pack
npx nowen-plugin sign --key publisher.pem --key-id publisher-2026
npx nowen-plugin login --registry https://registry.example --token "$TOKEN"
npx nowen-plugin publish
```

See `plugin-publish-action.yml` for tag-driven GitHub Actions publishing. Publisher private keys remain on the developer machine or in CI secrets.

## Privacy and offline behavior

Marketplace telemetry is optional and aggregate-only: extension ID, version, platform, lifecycle event, crash/error code. Note content, titles, attachment names, Action input, secrets and Workflow definitions are never accepted. Marketplace availability is not a startup dependency; already installed extensions continue to work offline.
