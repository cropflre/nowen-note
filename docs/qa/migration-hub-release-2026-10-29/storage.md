# Migration Hub — isolated S3-compatible storage acceptance

Date: 2026-10-29. Branch: `codex/ai-migration-hub-v160`, starting at `a254635ab`. Production source was not modified. Tests use a new SQLite database, unique staging/object prefix, synthetic credentials and a loopback-only daemon; no existing Nowen settings or user data are read or changed.

## Results

The production MigrationService and attachment-storage functions performed real HTTP requests against S3rver 3.7.1 with disk-backed objects. Fetch instrumentation records only method/path/status/range and invokes deterministic cancellation/revocation **after a real successful PUT**; it never substitutes a response or object operation.

The opt-in suite passed **5 tests**, with **1 explicit skip**:

| Behavior | Actual result |
|---|---|
| 8MiB PDF attachment import | COMPLETED, one note, correct attachment size and SHA-256, full object readback matches every byte, one attachment reference, no local cached file |
| Production verifier Range GETs | Eight actual ranged GETs verified the 8MiB object before completion |
| Note transaction fails after object PUT | No note imported; real DELETE compensates the uncommitted object and clears its intent |
| User cancels after object PUT | CANCELLED, no note commit; only that uncommitted object is removed |
| Original PAT revoked after object PUT | Item reports MIGRATION_TOKEN_REVOKED, no note commit; object compensated and the earlier committed object's bytes remain present |
| Unknown S3 access key | Daemon returns an authentication rejection; preview fails with MIGRATION_STORAGE_UNAVAILABLE and imports nothing |
| Invalid cryptographic signing secret | **Not verified** with this daemon; test is explicitly skipped by the S3rver runner |

The final run made 40 real requests: 9 PUT, 9 HEAD, 14 GET and 8 DELETE; eight GETs had Range headers and one request was rejected for an unknown access key. Exact machine-readable results: [storage.json](storage.json). The daemon, its disk data and the isolated database/staging files were closed/removed at the end.

Relevant contracts: DCC-002/003 (committed state and failure retention), DCC-006 (live creator token boundary), DCC-008 (failed object/DB work cannot become successful import). These are opt-in integration cases, not new claims that the default CI suite provisions an object-storage service.

## Environment limitations found during execution

MinIO was unavailable in this environment: `quay.io/minio/minio:latest` returned manifest 401, Docker Hub `minio/minio:latest` was denied, and the official Linux arm64 binary URL returned HTTP 410. No MinIO container was started and no existing Docker services were changed.

[S3rver](https://github.com/jamhall/s3rver) is a development S3 emulator, not a production service. A negative signing-secret test initially failed to reject; inspection of its [authentication implementation](https://github.com/jamhall/s3rver/blob/main/lib/middleware/authentication.js) confirmed that it does not calculate V4 signatures. `allowMismatchedSignatures=false` does not change that limitation. The runner therefore marks that cryptographic check unverified and skips it, while retaining a real unknown-access-key rejection test. Neither the daemon nor Nowen signing code was changed to manufacture a pass.

This evidence covers HTTP operations, byte/hash preservation, Range reads and migration compensation with this daemon. It **does not certify MinIO, cloud S3/R2, SigV4 cryptographic compatibility, a physical NAS, disk exhaustion or physical power loss**. The invalid-secret test remains runnable against a properly validating isolated service.

## Reproduce

Install the test daemon explicitly outside the repository (this is not a product dependency):

```sh
npm install --prefix /tmp/nowen-migration-s3rver-acceptance --no-audit --no-fund --package-lock=false s3rver@3.7.1
NOWEN_MIGRATION_S3RVER_MODULE=/tmp/nowen-migration-s3rver-acceptance/node_modules/s3rver \
NOWEN_MIGRATION_TEST_NODE="$PWD/node_modules/.bin/electron" \
NOWEN_MIGRATION_S3_TEST_REPORT="$PWD/docs/qa/migration-hub-release-2026-10-29/storage.json" \
node scripts/migration-object-storage-acceptance.mjs
```

This checkout's SQLite native module uses the Electron ABI, hence the explicit executable. On a checkout built for ordinary Node, omit NOWEN_MIGRATION_TEST_NODE. The runner binds 127.0.0.1 on an OS-selected port, creates its own bucket and temporary directory, and does not install dependencies implicitly.

For an already provisioned **isolated loopback** S3-compatible service, set NOWEN_MIGRATION_S3_TEST_ENDPOINT, NOWEN_MIGRATION_S3_TEST_BUCKET, NOWEN_MIGRATION_S3_TEST_ACCESS_KEY_ID and NOWEN_MIGRATION_S3_TEST_SECRET_ACCESS_KEY, then run `backend/tests/migration-object-storage.integration.test.ts` using the checkout's matching runtime. Leave NOWEN_MIGRATION_S3_TEST_SKIP_SECRET_SIGNATURE unset so invalid-secret rejection runs. Without the endpoint opt-in, all six cases skip before importing database or storage modules.

简要结论：真实本地 HTTP/磁盘对象服务的 5 项附件与失败补偿验收通过；1 项 V4 密钥签名校验因模拟服务自身未实现而明确跳过。未验收 MinIO、真实云 S3、NAS、磁盘耗尽或断电；没有改动生产源码和用户存储配置。
