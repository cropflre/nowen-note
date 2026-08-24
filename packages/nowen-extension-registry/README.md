# Nowen Extension Registry

Standalone Marketplace backend for Publisher identities, Ed25519 keys, immutable artifacts, signed V2 index metadata, automated package scanning, reviews and reports. It is intentionally separate from `backend/`, which remains the user's personal knowledge service.

Production requires explicit Registry URL/origin, GitHub OAuth, session, trusted-proxy and Ed25519 signer configuration. The signer configuration includes `REGISTRY_SIGNING_PRIVATE_KEY`, `REGISTRY_SIGNER_KEY_ID`, `REGISTRY_SIGNER_SEQUENCE`, `REGISTRY_SIGNER_VALID_FROM` and `REGISTRY_SIGNER_VALID_UNTIL`; local defaults are enabled only by `REGISTRY_ENV=development`. Publisher private keys never enter this service: `nowen-plugin sign` signs on the developer machine or in CI.

Root rotation is two-phase. An authenticated administrator with current TOTP calls `POST /v2/admin/root-rotations` with the next root's `keyId`, Ed25519 `publicKey`, `validFrom` and `validUntil` to persist a parent-signed pending envelope. Deployment then supplies the new private-key signer fields and the complete forward chain in `REGISTRY_ROOT_ROTATIONS_JSON`. Startup activates the chain transactionally only when every parent signature and the final signer match; otherwise it leaves the persisted active signer unchanged and fails closed.
