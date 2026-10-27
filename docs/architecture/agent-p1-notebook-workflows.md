# Notebook Agent P1 architecture

Implementation date: 2026-10-23. Worktree branch: `codex/ai-agent-p1`, based on `cab1d96b737326e00dcd97def2e9a07f1092c8a3`. The maintainer explicitly requested P1 implementation while the P0 device gates remain open. The earlier local-only workflow-permission patch on `feat/ai-agent-v1` is not part of this branch. This work does not imply merge, release or device acceptance.

## Product flow and reuse

The AI Chat Agent tab now opens a notebook workflow. Existing Q&A stays mounted when changing tabs, and the current-note Editor Agent remains available. Notebook workflows read saved server content; unsaved editor changes belong to the P0 editor proposal flow.

| P1 requirement | Implementation |
| --- | --- |
| Notebook retrieval | Explicit notebook and optional descendants; `workflowScope` and the existing reliable RAG ranking/context builder |
| Multi-note summary | Bounded retrieved evidence and source links, with truncation disclosure |
| New notes | Markdown proposal, then approved `createKnowledgeChild` with existing block, link and Yjs normalization |
| Task drafts | Existing `generateTaskPreview`, date/timezone validation and duplicate warnings |
| Confirm batch | One approval binds the exact note and task drafts; existing `createComposerBatch` and `createTaskRecord` |
| Individual draft review | Edit title, description, priority, dates and recurrence; exclude/reinclude existing candidates; server validation rotates approval before any creation |
| Note/task association | Tasks link to the new note when present, otherwise the explicitly selected existing note, otherwise no note |
| Cross-module execution | Search → cited proposal → task draft generation → approval → note → task batch |
| Partial recovery | Successful action IDs retained; explicit retry creates new approval for unfinished actions only |
| History/navigation | Last 30 scoped workflows, ordered tool steps, source versions and links to real note/task results |
| Languages | Chinese and English UI, errors and model language preference |

No second task generator, synchronization queue, conversation store or external MCP loop is introduced. This is an internal interactive API, not a public extension SDK. P2 plugins, scheduling, arbitrary tools and external writes remain outside scope.

## Files and ownership

- `backend/src/agent/workflowRuntime.ts`: scope/ACL checks, bounded execution, approval, transactional actions and recovery.
- `backend/src/agent/workflowTools.ts`: strict input/plan schemas and the two model tools.
- `backend/src/routes/agent.ts`: session-only workflow API beside P0 runs.
- `backend/src/routes/ai-reliable.ts`: shares RAG with an internal, preauthorized notebook scope and removes protected content before context construction.
- `backend/src/routes/tasks.ts`: exports the existing task business writer without changing its behavior.
- `frontend/src/components/agent/NotebookAgentPanel.tsx`: scope selection, status, review, confirmation, partial results and history.
- `frontend/src/lib/agentWorkflow.ts`: API types; existing authenticated API/cache/navigation modules handle transport and result navigation.

## Tool registry and permissions

| Tool | Parameters | Authority |
| --- | --- | --- |
| `search_notebook` | `{query}` | Read only, fixed server-authorized scope; never accepts user/workspace/notebook IDs from the model |
| `propose_workflow` | `{summary,sourceNoteIds,note?,taskRequest?}` | Produces drafts only; source IDs must have been retrieved in this run |

The task composer is called by the server after a valid proposal, not exposed as an arbitrary model endpoint. Write operations are not model tools. Unknown tools, unknown properties, forged citations and repeated tool calls fail closed. At least one search is mandatory. A proposal must cite a source when search returned sources.

Every run and approval checks the existing AI switch, user status, workspace membership, notebook/note ACL, original session expiry/revocation and token version. New note creation requires notebook write permission. Task creation requires the existing task feature to be enabled. All selected and retrieved sources are checked again before writes, including title/content/format digests and versions. Foreign, trashed, locked, encrypted and password-protected content is excluded or rejected. Personal API tokens, including restricted tokens, cannot call this interactive API.

Documents and model output are untrusted. Only structured allowlisted calls execute. React renders summaries and note drafts as text, without inserting model HTML. Model/provider bodies, instructions, note bodies and credentials are not persisted in Agent tables; P1 retrieval failure logs contain a fixed diagnostic code. Normal configured-provider/outbound networking is reused.

## Approval, transactions and recovery

`queued → running → waiting_approval → applying → completed`. Summary-only runs finish without a write approval. Terminal states also include `failed`, `partial`, `cancelled` and `interrupted`.

A random one-use approval token is stored as a hash, bound to the canonical plan, generated tasks and original input. Approval consumes it before applying. Each action commits its business entities, trigger-captured synchronization Outbox rows, action result IDs and completed step in one database transaction (DCC-002). A failure in any of those writes rolls back that action. New-note and task-batch actions are deliberately separate transactions: a task failure must not delete a successfully created note. The task batch itself is atomic.

On partial failure, the UI displays the created note and failed tasks. Retry requires unchanged readable sources, an in-memory draft and a fresh approval; completed actions are skipped. Existing task-composer request/preview idempotency remains authoritative. There is one active run per user across P0 and P1. Stop aborts model calls and prevents future actions, yielding only between committed actions; completed work is shown as partial success, never described as rolled back.

Task review keeps the existing preview/request identity, fixed project and scope. All original candidate IDs must be supplied once, with an explicit selection flag. Selected fields reuse `validateComposerTasks`, also used by batch creation, so dates, recurrence, projects and duplicate checks are not reimplemented. Excluded candidates are retained for re-selection but never reach the business writer. Revision requires the current approval token and rechecks source digests, authorization and P2 grants. Validation success transactionally rotates the approval binding and replaces the in-memory draft; old tokens fail. It never writes notes/tasks or extends the session's original expiry. The frontend preserves rejected local edits, disables creation until reviewed, and reconciles uncertain review responses using GET only. The original task batch still commits business data, Outbox and result IDs together (DCC-002), within the original account/workspace boundary (DCC-006).

Mutating workflow requests are not queued for offline replay. A lost approval response triggers a read-only GET reconciliation. If reconciliation also fails, approval/retry stays disabled until a status check succeeds. Result-task reads refresh the existing confirmed task cache without generating another local Outbox entry. Context/profile checks prevent late responses from updating a different account or workspace. Existing business synchronization remains responsible for other devices; local `completed` does not prove downstream sync.

## Storage and lifetime

Migration 137 adds:

| Table | Stored metadata |
| --- | --- |
| `agent_workflows` | Owner, scope, status, model, timestamps/error, source IDs/versions/digests and approval hashes/expiry |
| `agent_workflow_steps` | Ordered tool name/status/time, cascading by run |
| `agent_workflow_actions` | Unique `(runId,kind)`, pending/failed/completed status and committed resource IDs |

Source titles are resolved under current permissions when history is read. Source body hashes are not returned by the API. Deleted/unreadable sources are omitted from history source links. Created resource IDs remain metadata; normal note/task APIs enforce current access when opened.

Instructions, evidence, summaries and drafts stay in process memory for ten minutes from run creation. They are not recoverable after restart. The runtime marks active workflows interrupted on startup and invalidates tokens; it never resumes writes automatically. Completed/partial result identities and readable source links survive restart. A partial run after restart must be inspected and continued with a new request, not replayed. Metadata older than 30 days is pruned on runtime initialization.

Limits: 2,000 scoped notebooks, top 10 RAG candidates per search, 48,000 cumulative context characters, 4,000 instruction characters, 8 model rounds, 12 tool calls, 120-second execution timeout and 45-second model-call timeout. Task evidence uses the existing context budget; truncation is disclosed. Task composer defaults to at most 12 drafts; its schema ceiling remains 30. Model support is observed during actual execution; unsupported tool calling produces an explicit error without writes.

SQLite is the current product runtime. `0137-agent-notebook-workflows.sql` provides PostgreSQL metadata parity only; its migration test is not full PostgreSQL Agent runtime acceptance.

## Delivery and issue linkage

This implements section 15 of the supplied Nowen AI Agent V1.0 task brief. Existing P0 issue context is recorded in [the original architecture](nowen-ai-agent-v1.md); no new issue was supplied and no external issue/comment/status changes were made. See [API](../api/agent-p1.md), [user guide](../user/notebook-agent.md) and [acceptance report](../qa/agent-p1-2026-10-23.md) for concrete contracts and evidence.
