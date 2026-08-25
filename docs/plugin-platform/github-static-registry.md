# GitHub Static Registry V2

Nowen Public Beta uses a static, signed Registry hosted by GitHub Pages, with immutable plugin packages hosted in each Publisher's GitHub Releases.

## Official endpoint

`https://cropflre.github.io/nowen-plugin-registry/v2/index.json`

The endpoint is compiled into the client together with the public Ed25519 Registry root. GitHub is only the transport: the client still verifies Registry canonical-JSON signatures, Publisher keys, artifact SHA-256, Publisher signatures, Manifest identity, compatibility, permissions and security advisories.

The source repository is expected at `cropflre/nowen-plugin-registry`. It contains Publisher public keys, immutable version metadata, advisory drafts, public JSON Schemas and protected GitHub Actions for validation and Pages deployment.

## Release operations

Registry private keys never enter this repository or Nowen application builds. The static Registry repository keeps local keys under ignored `.secrets/` and GitHub deployment reads the private PEM from the protected `NOWEN_REGISTRY_SIGNING_PRIVATE_KEY` Secret.

Every metadata change must bump `registry/release.json`. Reusing a sequence with changed content is an equivocation event and clients reject it. The metadata expiry window also requires a periodic signed release bump even when the catalog has not changed.

Publisher packages are signed before submission:

```bash
npx nowen-plugin pack
npx nowen-plugin sign --key publisher.pem --key-id publisher-2026
```

The Registry verifies that the Publisher signature covers the raw 32-byte SHA-256 digest. CI also downloads the GitHub Release artifact and checks that the hosted bytes match the declared digest.

## Mainland mirror

A mirror copies the generated `dist/` directory byte-for-byte to a Chinese CDN or object store. It never receives the Registry or Publisher private keys. A client can pin the same public root for the mirror; any modified metadata or artifact fails signature or digest validation.

Automatic GitHub/mirror failover is intentionally deferred until a mirror endpoint exists and can be monitored. Public Beta starts with the GitHub Pages official source and keeps custom pinned V2 sources available to administrators.
