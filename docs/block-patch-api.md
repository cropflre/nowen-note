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
- `operationId`: required idempotency key, 8–128 characters. A retry after an uncertain network result must reuse the same value.
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

The server repairs empty list/quote containers. Deleting the final document block creates an empty editable paragraph so the resulting Tiptap document remains mountable.

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
4. Updates the note with `WHERE id = ? AND version = ?`.
5. Rebuilds the Block index once.
6. Rebuilds note links once.
7. Stores the idempotent response.

When any operation fails, all earlier operations and Block-ID normalization are rolled back. A successful patch increments the note version exactly once.

## Response

```json
{
  "success": true,
  "noteId": "note-id",
  "version": 8,
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

A replay using the same user, note and `operationId` returns the stored response with:

```json
{
  "idempotentReplay": true
}
```

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

## V1 boundaries

- Tiptap JSON only. Markdown already uses CodeMirror transaction to Y.Text delta synchronization and needs a separate format-aware patch protocol.
- Update operations replace block text; mark-level and arbitrary JSON-node patches are deferred.
- Cross-parent moves are deferred.
- The editor still retains whole-document save fallback while Block Patch adoption is introduced incrementally.
- Block Patch is not yet the sole authoritative content store; `notes.content` remains the canonical document in V1.
