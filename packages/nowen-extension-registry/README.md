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

## Backup, restore, and artifact GC

Registry metadata is backed up with SQLite `VACUUM INTO`, producing a consistent snapshot even when WAL mode is enabled. Every backup has a sidecar manifest containing the SHA-256, byte size, schema version, index sequence and active root identifier. Verification runs `integrity_check`, `foreign_key_check`, schema compatibility and artifact metadata consistency checks.

```bash
# Online-safe metadata snapshot.
npm run maintenance -- backup --output /backups/nowen-registry

# Verify before moving or restoring a backup.
npm run maintenance -- verify \
  --database /backups/nowen-registry/registry-....sqlite \
  --manifest /backups/nowen-registry/registry-....manifest.json

# Dry-run restore verification. This does not modify registry.db.
npm run maintenance -- restore \
  --database /backups/nowen-registry/registry-....sqlite \
  --manifest /backups/nowen-registry/registry-....manifest.json

# Actual restore. STOP all Registry instances first. The command refuses a target
# with WAL/SHM files and preserves the previous DB as registry.db.pre-restore-*.
npm run maintenance -- restore \
  --database /backups/nowen-registry/registry-....sqlite \
  --manifest /backups/nowen-registry/registry-....manifest.json \
  --apply
```

Artifact binaries live outside the metadata backup when S3-compatible storage is used. Back up the bucket/object-store independently according to the provider's durability policy. The Registry backup contains immutable SHA-256 coordinates needed to validate those objects after recovery.

Artifact garbage collection is conservative and dry-run by default. It preserves every object referenced by `extension_versions`, reports stale staging objects and unreferenced content-addressed objects, and requires `--apply` before deleting anything. The default grace period is 24 hours and deletion is capped per run.

```bash
npm run maintenance -- gc
npm run maintenance -- gc --grace-hours 72 --max-delete 500 --apply
```

GC and publishing are coordinated through cross-process SQLite operation leases. Existing publishes prevent destructive GC from starting, and active GC makes new publishes fail temporarily with `503 REGISTRY_MAINTENANCE_BUSY`. Expired leases are automatically discarded after process crashes.

Run local verification with:

```bash
npm ci
npm run check
```

`Extension Registry Production` CI runs the Registry TypeScript check, production-hardening tests, backup/restore verification and artifact-GC regression suite independently from the main Nowen backend.
