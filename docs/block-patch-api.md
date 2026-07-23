# Block Patch API V1

Block Patch API lets a client apply several Tiptap block mutations as one confirmed transaction. It is the first persistence boundary for moving from whole-note saves toward block-aware saving.

## Endpoint

```http
POST /api/blocks/:noteId/patch
Authorization: Bearer <token>
Content-Type: application/json
```

The current V1 accepts only notes whose `contentFormat` is `tiptap-json`.

## Request

```json
{
  "expectedNoteVersion": 7,
  "operationId": "block-patch-550e8400-e29b-41d4-a716-446655440000",
  "operations": [
    {
      "type": "update",
      "blockId": "blk_alpha000",
      "text": "Updated text"
    },
    {
      "type": "create",
      "clientId": "local-block-1",
      "blockType": "paragraph",
      "text": "New paragraph",
      "afterBlockId": "blk_alpha000"
    },
    {
      "type": "move",
      "blockId": "blk_beta0000",
      "targetBlockId": "blk_alpha000",
      "position": "before"
    },
    {
      "type": "delete",
      "blockId": "blk_old00000"
    }
  ]
}
```

### Envelope fields

- `expectedNoteVersion`: required optimistic-lock version. The complete patch is rejected with `409 VERSION_CONFLICT` when it does not match.
- `operationId`: required user-level idempotency key, 8–128 characters. It must be globally unique for the current user. A retry after an uncertain network result must reuse the same value for the same note; reusing it on another note returns `OPERATION_ID_CONFLICT`.
- `operations`: ordered list containing 1–100 operations. The encoded request is limited to approximately 2 MB.

### Operations

#### Create

```json
{
  "type": "create",
  "clientId": "optional-local-id",
  "blockId": "optional-valid-blk_id",
  "blockType": "paragraph",
  "text": "Content",
  "afterBlockId": "optional-anchor"
}
```

Supported `blockType` values:

- `paragraph`
- `heading`
- `listItem`
- `taskItem`
- `blockquote`
- `codeBlock`

When `blockId` is omitted, the server generates one. `clientId` is returned with the generated ID so an editor can reconcile optimistic local blocks.

#### Update

```json
{
  "type": "update",
  "blockId": "blk_alpha000",
  "text": "Replacement plain text"
}
```

V1 replaces the editable text payload of the addressed supported block. Rich mark-level patches are not part of V1.

#### Delete

```json
{
  "type": "delete",
  "blockId": "blk_alpha000"
}
```

The server repairs empty list/quote containers. Deleting the final document block creates an empty editable paragraph so the resulting Tiptap document remains mountable. The grey editor planner currently keeps delete-all on the whole-document path because V1 does not yet reconcile that server-generated replacement Block ID back to the local editor as an explicit operation.

#### Move

```json
{
  "type": "move",
  "blockId": "blk_beta0000",
  "targetBlockId": "blk_alpha000",
  "position": "after"
}
```

V1 permits moves only inside the same parent node. Cross-parent moves return `BLOCK_MOVE_PARENT_MISMATCH` instead of guessing how nested schemas should be rewritten.

## Sequential and atomic semantics

Operations are evaluated in array order. Later operations see changes made by earlier operations in the same request.

The server performs the following work inside one SQLite transaction:

1. Rechecks the note, write permission, lock state and expected version.
2. Materializes missing stable Block IDs.
3. Applies every operation in memory.
4. Records the pre-edit note version using the same five-minute merge window as `PUT /notes/:id`.
5. Updates the note with `WHERE id = ? AND version = ?`.
6. Rebuilds the Block index once.
7. Rebuilds note links once.
8. Stores the idempotent response.

When any operation fails, all earlier operations, Block-ID normalization and the tentative version snapshot are rolled back. A successful patch increments the note version exactly once. An idempotent replay returns the stored result and does not create another history entry.

## Response

The response includes the authoritative persisted snapshot. The client must use these fields as the base for the next patch instead of assuming that its local JSON is byte-for-byte identical after server normalization.

```json
{
  "success": true,
  "noteId": "note-id",
  "title": "Note title",
  "version": 8,
  "updatedAt": "2026-07-22T10:00:00.000Z",
  "content": "{\"type\":\"doc\",\"content\":[]}",
  "contentText": "Searchable plain text",
  "contentFormat": "tiptap-json",
  "notebookId": "notebook-id",
  "operationCount": 4,
  "affectedBlockIds": ["blk_alpha000", "blk_new00000"],
  "deletedBlockIds": ["blk_old00000"],
  "createdBlocks": [
    {
      "operationIndex": 1,
      "clientId": "local-block-1",
      "blockId": "blk_new00000"
    }
  ],
  "blocks": [],
  "contentChangedByNormalization": false
}
```

A replay using the same user, note and `operationId` returns the same stored authoritative snapshot with:

```json
{
  "idempotentReplay": true
}
```

Successful writes also emit the normal `note:updated` and `note:list-updated` realtime messages so other open clients receive the new version.

## Errors

Common error codes:

- `INVALID_BLOCK_PATCH`
- `INVALID_PATCH`
- `INVALID_BLOCK_ID`
- `BLOCK_ID_CONFLICT`
- `BLOCK_NOT_FOUND`
- `BLOCK_MOVE_SELF`
- `BLOCK_MOVE_PARENT_MISMATCH`
- `INVALID_TIPTAP_DOCUMENT`
- `NOTE_LOCKED`
- `VERSION_CONFLICT`
- `OPERATION_ID_CONFLICT`
- `BLOCK_FORMAT_UNSUPPORTED`

Permission failures intentionally use `404 NOT_FOUND` semantics so the endpoint does not disclose private note existence.

## Frontend client

Use `frontend/src/lib/blockPatchApi.ts`:

```ts
const operationId = createBlockPatchOperationId();

const result = await patchTiptapBlocks(noteId, {
  expectedNoteVersion: note.version,
  operationId,
  operations,
});
```

The client bypasses the optimistic offline queue. The caller must receive the authoritative server version before submitting a dependent patch. After a timeout, retry with the same `operationId`.

## Tiptap editor grey rollout

`frontend/src/components/TiptapEditorRuntime.tsx` enables the patch path by default only for the note which owns the active `viewport-optimized` or `lightweight-edit` runtime decision. Normal documents and other notes open in split panes keep the existing whole-document save path until wider validation is complete.

A session can override the mode threshold with local storage, but the runtime decision must still belong to the editor's note:

```js
localStorage.setItem("nowen.tiptap_block_patch_v1", "on")
localStorage.setItem("nowen.tiptap_block_patch_v1", "off")
```

The planner intentionally accepts only changes which can be represented without losing Tiptap structure:

- plain-text updates on stable-ID paragraph, heading and code blocks;
- plain-text updates inside an otherwise unchanged nested structure;
- top-level simple block create/delete/reorder operations;
- no marks, hard breaks, non-default created-node attributes or missing/duplicate Block IDs;
- no delete-all operation until the replacement empty Block ID can be reconciled explicitly.

Formatting changes, tables, media, complex pastes, list restructuring, title changes and any unrecognized transaction continue through the original whole-document save callback.

Only one patch may be in flight per editor. Later edits and title/meta saves are kept as the newest local payload and processed only after the authoritative version arrives. Timeout/network uncertainty retries once with the same idempotency key. If the outcome remains uncertain, the local draft is retained and the editor reports a sync error; it does not issue a blind whole-document overwrite. Known request validation failures that happened before persistence may safely fall back to whole-document save.

Public, guest and presentation routes never mount the authenticated Block Patch AppContext bridge, even when another editor has activated an optimized runtime mode.

## V1 boundaries

- Tiptap JSON only. Markdown already uses CodeMirror transaction to Y.Text delta synchronization and needs a separate format-aware patch protocol.
- Update operations replace block text; mark-level and arbitrary JSON-node patches are deferred.
- Cross-parent moves are deferred.
- The editor retains whole-document save as the compatibility and safety fallback.
- The backend still serializes the complete `notes.content` snapshot and rebuilds whole-note Block/link indexes after a successful patch.
- Block Patch is not yet the sole authoritative content store; `notes.content` remains the canonical document in V1.
