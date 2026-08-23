# Nowen Extension Registry

Standalone Marketplace backend for Publisher identities, Ed25519 keys, immutable artifacts, signed V2 index metadata, automated package scanning, reviews and reports. It is intentionally separate from `backend/`, which remains the user's personal knowledge service.

Production requires `REGISTRY_SIGNING_PRIVATE_KEY`, `REGISTRY_SESSION_SECRET`, `REGISTRY_PUBLIC_URL`, `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET`. Publisher private keys never enter this service: `nowen-plugin sign` signs on the developer machine or in CI.
