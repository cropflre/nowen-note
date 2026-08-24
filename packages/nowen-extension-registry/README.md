# Nowen Extension Registry

Standalone Marketplace backend for Publisher identities, Ed25519 keys, immutable artifacts, signed V2 index metadata, automated package scanning, reviews and reports. It is intentionally separate from `backend/`, which remains the user's personal knowledge service.

Production requires explicit Registry URL/origin, GitHub OAuth, session, trusted-proxy and Ed25519 signer configuration. The signer configuration includes `REGISTRY_SIGNING_PRIVATE_KEY`, `REGISTRY_SIGNER_KEY_ID`, `REGISTRY_SIGNER_SEQUENCE`, `REGISTRY_SIGNER_VALID_FROM` and `REGISTRY_SIGNER_VALID_UNTIL`; local defaults are enabled only by `REGISTRY_ENV=development`. Publisher private keys never enter this service: `nowen-plugin sign` signs on the developer machine or in CI.

Root rotation is two-phase. An authenticated administrator with current TOTP calls `POST /v2/admin/root-rotations` with the next root's `keyId`, Ed25519 `publicKey`, `validFrom` and `validUntil` to persist a parent-signed pending envelope. Deployment then supplies the new private-key signer fields and the complete forward chain in `REGISTRY_ROOT_ROTATIONS_JSON`. Startup activates the chain transactionally only when every parent signature and the final signer match; otherwise it leaves the persisted active signer unchanged and fails closed.

## Production runtime

Production artifact storage is S3-compatible (`REGISTRY_ARTIFACT_STORE=s3`) and works with AWS S3, Cloudflare R2, MinIO, OSS/COS S3-compatible gateways, or other compatible endpoints. Configure `REGISTRY_ARTIFACT_CDN_BASE_URL` when artifacts are delivered through a CDN/mirror. Artifact coordinates are content-addressed by SHA-256 and immutable; the client still verifies Registry metadata, Publisher Ed25519 signature, and SHA-256, so a CDN is only an untrusted transport layer.

Health probes are split for orchestration:

- `GET /health/live` — process liveness only; does not depend on SQLite, object storage, or the signer.
- `GET /health/ready` (and legacy `GET /health`) — SQLite + artifact-store + Ed25519 signer readiness.
- `GET /health/status` — safe aggregate runtime/catalog counters. It never returns private keys, OAuth/session secrets, storage credentials, IPs, plugin payloads, or backend error strings.

The Registry applies persistent SQLite token buckets globally and per client IP/account/publisher. Authentication, publish, admin-write, community-write and telemetry routes additionally receive fixed-cardinality abuse budgets. Health probes and CORS preflight are exempt so load balancers cannot accidentally take the service out of rotation because of user traffic.

Run local verification with:

```bash
npm ci
npm run check
```

`Extension Registry Production` CI runs the Registry TypeScript check and production-hardening regression suite independently from the main Nowen backend.
