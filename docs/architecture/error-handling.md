# Unified error handling (phase 1)

Applies to the API, web, Electron and native clients. Implemented incrementally
on `release/v1.5.1`; legacy routes remain compatible.

## Public API contract

Error responses for **new and migrated** endpoints:

```json
{
  "error": "用户可理解的提示",
  "code": "ATTACHMENT_STORAGE_NO_SPACE",
  "requestId": "07f2810d-0f26-4da0-b731-a49cd44ba925",
  "retryable": false
}
```

- `error` remains the legacy field used by existing clients.
- `code` is stable `UPPER_SNAKE_CASE`. Prefer a domain prefix for new codes:
  `AUTH_`, `NETWORK_`, `SYNC_`, `NOTE_`, `ATTACHMENT_`,
  `BACKUP_`, `EDITOR_`, `PLUGIN_`, `SYSTEM_`. Historical codes such as
  `VERSION_CONFLICT` and `AUTH_EXPIRED` must not be renamed in-place.
- `X-Request-Id` is emitted on every Hono response and CORS-exposed. The
  normalized response also contains `requestId`. Existing route-level error
  payloads are not rewritten; clients should read the response header.
- `retryable` is a signal for application policy, not blanket permission to
  repeat a non-idempotent mutation. Preserve mutation IDs and Outbox entries.
- `details` is optional and allowlisted. Never include note content, login
  secrets, full filesystem paths, query tokens, URLs with credentials, or SQL.

## Error boundaries

1. Map known errors to `AppError` at the point where their meaning is known.
2. Use the top-level Hono handler for unexpected exceptions only. It emits
   `SYSTEM_INTERNAL_ERROR` without revealing the original exception message.
3. Preserve legacy `{ error, code }` semantics for released clients.
4. Client adapters preserve `status`, `code`, `requestId`, `retryable`,
   and version-conflict fields. Never translate `403` into auth-expiry without
   consulting the returned business code.
5. Local-first invariants: local commit success is not remote sync success;
   failed push/pull must not destroy local data or Outbox items.

## Logging

Structured log fields: UTC timestamp, level, event (`domain.operation.outcome`),
module, requestId, code and HTTP status. Add operation ID when a task spans
requests. Prefer known safe metadata such as stage, retry count, timing and
storage driver. Never print arbitrary `Error.stack` or raw response bodies
into server logs. Follow existing Sync V2 field-allowlist practices.

Severity: DEBUG for development only, INFO for expected transitions, WARN for
recoverable conditions, ERROR for operation failures, FATAL for unrecoverable
process failure. Expected 404 and user-initiated aborts should not be counted
as crashes.

## Rollout

Phase 1: top-level request IDs, safe unhandled response, web error adapter,
JSON parse diagnostic hardening, tests.
Phase 2 (incremental, in PR #806): Sync V2 blob HEAD/PUT/GET honors explicit
server codes and treats bare HTTP 403 as `SCOPE_FORBIDDEN`. Full backup jobs
expose a safe `errorCode`, `retryable` and their existing job `id` as
`operationId`. Backup create/import/restore routes classify known failures
and return `error/code/requestId/retryable`. Unknown exceptions are hidden
behind safe messages; automatic retries of restore are prohibited. Data
manager and full-data transfer views show copyable fault references.
Attachment **write** failures are also migrated: upload, deduplication and
administrator repair preserve legacy `ATTACHMENT_DB_WRITE_FAILED` and
`ATTACHMENT_STORAGE_*` codes, expose `requestId` and `retryable: false`,
and log only safe metadata. Frontend `UploadRequestError` now retains the
server correlation ID and explicit retry policy. Legacy download ACL behavior
is intentionally unchanged: do **not** turn masked 404s into 403s, which
would disclose whether private attachments exist. Attachment upload failures
do not imply loss of an existing note or successful remote persistence.

Error messages in user-facing diagnostic cards are **client-owned allowlisted
text**, even when the server sent a syntactically valid error code. Copy only
the code and correlation ID, not stack traces, request URLs or note content.

Other domains and non-migrated backup endpoints retain legacy responses.
Phase 3: opt-in, user-previewable, redacted diagnostic bundle, including
platform and version. Never silently upload note data.

Recommended tests: 401/403/404/409/429/5xx compatibility, CORS visibility,
proxy compatibility, sync idempotency, URL/token redaction, Electron logging.
