# Editor Agent API (P0)

All paths begin with `/api/agent` and use the existing login session Authorization header. Personal API tokens are denied. New APIs do not change `/api/ai` or `/api/user-preferences/ai-reliable`.

| Method/path | Contract |
| --- | --- |
| `GET /capabilities` | Feature switch, observed model capabilities or `unverified`, formats and context limit. No capability inferred from model names. |
| `POST /runs` | `{noteId,instruction,content,format,version,selectedText?}`; strict schema. `format`: `markdown` or `tiptap-json`. Returns `202 {id}`; asynchronously executes registered tools. |
| `GET /runs?noteId=...` | Latest authorized run for this user and note, or null. |
| `GET /runs/:id` | Run status, ordered steps; pending in-memory proposal includes edits, original/result, format and one-use approval token. Terminal runs have metadata only. |
| `GET /runs/:id/events` | Finite SSE replay of persisted events after `Last-Event-ID` (or numeric `after`). Event `agent_event`, ID is step sequence. Client reconnects/polls; replay never executes a model/tool call. Authentication stays in headers. |
| `POST /runs/:id/approve` | `{token,snapshot}`. Rechecks scope/version/digest/expiry, consumes approval once, returns the exact proposal to the editor and sets `applying`. Does not write note rows. |
| `POST /runs/:id/receipt` | Confirms exact persisted content and a non-regressing version; returns `completed` only on a match. Completed receipt calls are idempotent. |
| `POST /runs/:id/reject` | Rejects pending proposal and cancels execution. |
| `POST /runs/:id/cancel` | Aborts future execution. An authorized but uncertain editor write becomes `interrupted`, with `CHECK_EDITOR_SAVE`. |

Errors use `{code,error}`. Relevant codes: `NOTE_ACCESS_DENIED`, `PROTECTED_DOCUMENT`, `AGENT_DISABLED`, `RUN_ALREADY_ACTIVE`, `VERSION_CONFLICT`, `APPROVAL_INVALID`, `APPROVAL_NOT_PENDING`, `SAVE_NOT_CONFIRMED`, `TOOL_CALLING_UNSUPPORTED`, `INVALID_TOOL_ARGUMENTS`, `TOOL_NOT_ALLOWED`, `REPEATED_TOOL_CALL`, `MODEL_TIMEOUT`, `SERVER_RESTARTED`. Conflict/approval errors are 409; access errors 403; missing owned runs 404. Upstream failures are recorded in the run, without leaking provider bodies.

Approval is not safe to auto-retry after an uncertain response: retrieve the run, inspect the editor, and never dispatch again solely because the response was lost. `completed` confirms this server's persisted note, not downstream device synchronization. Stopping after application cannot imply rollback.

An edit normally replaces one exact, non-empty `before` match. Empty-note drafting allows exactly one edit with `before: ""` and non-blank `after`, only when Markdown is `""` or rich text contains exactly one empty paragraph. Attachments, whitespace-only Markdown, other blocks, multiple insertions and mixed edits are rejected. Rich-text drafts add one plain text node while preserving paragraph attributes. This exception retains snapshot/version validation, one-use approval, editor application and save receipts.
