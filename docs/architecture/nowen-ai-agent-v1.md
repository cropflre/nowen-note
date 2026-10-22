# Nowen AI Agent P0 architecture

Baseline verified on 2026-10-21: `release/v1.5.3` and remote at `9f134f4f1c56656157225d05a272e336ac857a77`. The maintainer selected this baseline; development is isolated on `feat/ai-agent-v1`. The original workspace was clean. `release/v1.6.0` was local only and retained Apps/Workbench/Studio. Latest baseline migration: 135; Agent adds 136. No release or main integration is implied.

## Existing capability audit

| Existing source | Reuse / boundary |
| --- | --- |
| `AIChatPanel.tsx`, `AIChatReliabilityShell.tsx` | Existing chat/history and reliable knowledge/current-note/selection Q&A remain mounted. Agent entry opens the active editor; P0 does not add a second conversation database. |
| `EditorPane.tsx`, editor handles and runtime wrappers | `getSnapshot`, native editor transactions, `flushSave`, existing Block Patch/Yjs/REST/draft/Outbox flows. Agent never updates note rows directly. |
| `frontend/src/lib/api.impl.ts` | Existing authenticated transport; no token in a URL, no separate identity or offline queue. |
| `ai.ts`, `ai-reliable.ts`, `ai-client.ts`, `user-ai-settings.ts` | Existing per-user model settings, AI switch and outbound proxy. Structured calls live in a separate adapter, leaving legacy text extraction unchanged. |
| `aiTaskIntent.ts`, `task-composer.ts`, `tasks.ts` | Existing intent handling, preview/date validation, idempotent task batches and task creation; reserved for P1. |
| `pluginService.ts`, `workflowService.ts` | Existing trust/permissions and workflow revision controls; neither is exposed to the P0 model. |
| MCP `index.ts`, `p1-tools.ts`, `p2-tools.ts` | External authenticated REST protocol adapters, not an internal business-service dependency. No MCP process or self-HTTP loop is introduced. |
| `docs/plugin-platform/README.md` | Plugins have different trust levels. P0 does not run plugin actions, arbitrary URLs, SQL or shell. |

Issue linkage: [#179](https://github.com/cropflre/nowen-note/issues/179) requests editor-side document editing and remained open during audit. [#91](https://github.com/cropflre/nowen-note/issues/91) was closed with MCP delivery. [#578](https://github.com/cropflre/nowen-note/issues/578) was closed after directing users to external MCP/API automation; its status does not prove built-in scheduling exists or is accepted. No Issue comments or status changes were made for this work.

## Execution and ownership

The editor supplies a bounded live snapshot (including unsaved edits), format, selection and current server version. The server authenticates the session and resource before creating a run. The model can call only `get_current_note_context` and `propose_note_edit`; each invocation has a persistent sequence/status event. Tool parameters are strict Zod schemas, not extracted from prose.

A proposal contains unique, non-overlapping exact text replacements. Markdown applies CodeMirror changes as one isolated undo entry (including Yjs undo capture boundaries). Rich text applies ProseMirror replacements inside individual text nodes with original marks. Structural JSON, block attributes, attachments and link destinations are not model-writable. Ambiguous replacements, overlaps, deleting a rich-text node's entire text, changed existing Markdown references/block IDs and output over 48,000 characters fail closed. Structural rewrites/large documents/virtualized rich-text sections can use Q&A drafts; they are not silently converted and overwritten.

The server stores an approval binding user/run/note/action, canonical edit digest, snapshot digest, server-body digest, expected server version, expiry, a hash of a random one-use token, and consumed state. Approval rechecks live ACL, AI switch, authorizing session/token version, server version, server-body digest and editor snapshot. The frontend rechecks the snapshot after the network response and dispatches through the existing editor. A duplicate approval cannot dispatch a second edit.

`applying` means the editor was authorized, not that saving succeeded. `/receipt` verifies the exact persisted result and a compatible version (Yjs can coalesce consecutive saves into one version). Persistence may add previously absent system block IDs; only those additions are normalized, while existing IDs and content remain significant. Failed/queued saves never count as completion. Existing synchronization receipts remain authoritative for other devices (DCC-001/002/003/004/006/010/011).

## State, storage and limits

`queued → running → waiting_approval → applying → completed`; failures and cancellations end in `failed`, `cancelled` or `interrupted`. Stop aborts upstream calls and prevents later tool dispatch. Stopping during `applying` reports an interrupted write requiring inspection; it does not roll back the editor.

Migration 136 adds `agent_runs`, `agent_steps`, `agent_approvals`, user/time and run/sequence indices, plus a unique active-run index per user. No instructions, note bodies, selections, raw model responses or credentials enter these tables. Snapshots/proposals stay in process memory and expire after ten minutes. On first runtime initialization after a backend restart, unfinished runs become `interrupted`; no write resumes automatically. GET run/latest and sequenced event replay recover UI state, never re-execute tools. Lost approval responses require inspection, not automatic application.

Defaults: 8 model rounds, 12 tool calls, 1 active run/user, 120-second execution timeout, 45-second upstream request timeout, 48,000-character snapshot and 4,000-character instruction. Repeated tool requests terminate. Model response reads are bounded at 400,000 bytes; interleaved SSE tool indices/IDs/argument fragments are supported. Usage is recorded only if supplied by the provider. Model capability evidence is tied to effective configuration and expires after one hour; unknown capabilities stay `unverified`.

`NOWEN_AGENT_ENABLED=false` disables the feature. The user's existing AI switch also applies. Metadata retention is 30 days by default; `NOWEN_AGENT_RETENTION_DAYS` is clamped to 1–90 days and pruning happens on runtime initialization. SQLite is the current product runtime. `0136-editor-agent.sql` supplies PostgreSQL storage parity following existing migration conventions; it does not claim PostgreSQL runtime support or live PostgreSQL acceptance.

DeepSeek explicitly uses non-thinking mode for required tool calls, selected by provider or the official endpoint, not model-name heuristics. Real `deepseek-flash`, PostgreSQL schema and independent SQLite sync acceptance are recorded in [the 2026-10-22 report](../qa/agent-p0-2026-10-22.md). These checks do not establish packaged-device or full PostgreSQL runtime support.

## Permission and privacy design

- The normal application authentication middleware supplies identity. PATs, including restricted tokens, are denied for this interactive P0 API.
- Every resource access uses existing note/knowledge-tree/workspace ACL. Viewers cannot generate writable proposals. Trash, locked notes, encrypted notes/blocks and password-protected folders are denied, even if a folder is unlocked in the browser.
- User disablement, token-version changes and original session revocation/expiry are checked between model/tool calls and again on approval.
- Context is only the active authorized note and explicitly supplied user selection/instruction; no RAG, attachment download or whole-library export occurs.
- Documents/tool results are untrusted data. Prompts explain this, but the tool allowlist, schemas and ACL enforce the boundary independently.
- Diff text is React-escaped. No hidden reasoning is rendered or persisted. Provider error bodies and API keys are not logged by the adapter.
- Privacy text tells users exactly what is sent to their configured provider before they submit.

## P1/P2 boundary

P1 remains gated on P0 acceptance. Reuse task composer and note domain services for search, new notes and task batches, with server-side transactional idempotency and partial-result states. Do not expand the P0 editor approval into a generic REST proxy. P2 plugin/automation/external MCP requires a separate trust/network/credential design. No new heavy Agent dependency, telemetry or public SDK is introduced.
