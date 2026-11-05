# AI Memory archive API v1

Development API under `/api/ai-memory`. Uses existing Bearer JWT/PAT authentication, server-owned identity, notebook ACL and token resource grants. Personal notebooks only. PAT reads require `notes:read`, writes require `notes:write`; file import additionally requires `export:import` and rechecks the original token each background step.

| Method/path | Contract |
|---|---|
| `GET /capabilities` | Limits, instance-local raw storage and fixture-tested/planned platform distinction |
| `GET /sources`, `GET /sources/:id` | Current authorized sources, `{items}` for collection |
| `POST /sources` | `{provider,accountScope,notebookId,displayName?,permissionState:"granted",captureEnabled?:false}`; binding immutable, automatic capture defaults off |
| `PATCH /sources/:id` | Change displayName, captureEnabled or permissionState; revocation disables capture |
| `DELETE /sources/:id` | Revoke, retain existing copies |
| `POST /conversations/ingest` | `{sourceId,operationId,expectedRevision?,mode:"manual"|"automatic"|"import",snapshot}` |
| `GET /conversations` | `{items,total}`; sourceId, externalConversationId, q(title), offset, limit(max100), includeDeleted |
| `GET /conversations/:id` | Current authorized metadata |
| `GET /conversations/:id/messages` | `{items}` with structured blocks, text, identity and revision |
| `GET /conversations/:id/export` | Atomic `nowen-ai-conversation` v1 snapshot, no credentials |
| `DELETE /conversations/:id` | Trash archive and unchanged projection; preserve edited projection |
| `POST /conversations/:id/restore` | Explicit archive/projection restore |
| `POST /conversations/:id/rebuild-note` | Create a fresh projection copy without overwriting user edits |
| `POST /imports/preview?sourceId=...&filename=...` | Raw file body, streamed upload/private bounded staging, returns preview job |
| `POST /imports` | `{jobId,previewDigest}`, returns202 and job; does not imply completed import |
| `GET /imports`, `GET /imports/:jobId` | Creator-bound job(s), counts, warnings and item results |
| `POST /imports/:jobId/cancel` | Stop future writes, retain successful items |
| `POST /imports/:jobId/retry` | `{previewDigest}`, retry unsaved items with original operation IDs |
| `DELETE /imports/:jobId` | Remove inactive staging data, retain persisted archives |

Snapshot fields: provider, accountScope, externalConversationId, title, sourceUrl, messages, completeness, capturedAt. Each message has optional externalMessageId, localSequence, role, blocks, text, optional contentHash/timestamps, captureState. The server recalculates authoritative hashes; streaming messages are not persisted. Changed existing conversations require exact expectedRevision. Missing messages never imply deletion, and ambiguous ordering is refused.

Receipt: `{operationId,sourceId,conversationId,noteId,revision,status:"applied"|"duplicate",persisted:true,persistedAt,completeness,projectionStatus}`. Operation IDs are bound to exact request payloads. A mismatched replay returns409, and failed transactions produce no receipt. Raw persistence and a projection conflict can coexist; the client must display that distinction.

Important errors: AI_SOURCE_NOT_AUTHORIZED(403), AI_CAPTURE_PAUSED(409), AI_SYNC_VERSION_CONFLICT(409), AI_SYNC_OPERATION_CONFLICT(409), AI_MESSAGE_IDENTITY_AMBIGUOUS(409), AI_MESSAGE_ORDER_CONFLICT(409), AI_CONTEXT_SCOPE_DENIED(403), AI_CAPTURE_TOO_LARGE(413), AI_IMPORT_PREVIEW_CHANGED(409), AI_IMPORT_STAGING_CORRUPTED, AI_IMPORT_DUPLICATE_CONFLICT. Administrative transfer of an account with AI sources returns AI_ARCHIVE_TRANSFER_REQUIRES_EXPORT(409) before modifying data.

See [architecture](../architecture/ai-memory-hub.md), [user limits](../tutorials/ai-memory.md) and [actual validation](../qa/ai-memory-hub-2026-11-05.md). No memory/context APIs are advertised as implemented.
