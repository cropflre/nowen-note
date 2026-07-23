# Block Patch API V2-H

Block Patch applies ordered Tiptap Block mutations as one confirmed transaction. It is the persistence boundary between whole-note saves and the future Block-authoritative storage model.

## Endpoint

```http
POST /api/blocks/:noteId/patch
Authorization: Bearer <token>
Content-Type: application/json
```

Only notes whose `contentFormat` is `tiptap-json` are accepted.

## Request envelope

```json
{
  "expectedNoteVersion": 7,
  "operationId": "block-patch-550e8400-e29b-41d4-a716-446655440000",
  "operations": []
}
```

- `expectedNoteVersion` is required. A mismatch returns `409 VERSION_CONFLICT` before persistence.
- `operationId` is a user-level idempotency key, 8–128 characters.
- An uncertain retry must reuse the same operation ID for the same note.
- Reusing one operation ID on another note returns `409 OPERATION_ID_CONFLICT`.
- `operations` contains 1–100 ordered operations. The request is limited to approximately 2 MB.

## Operations

### Create

```json
{
  "type": "create",
  "clientId": "optional-local-id",
  "blockId": "optional-valid-blk_id",
  "blockType": "paragraph",
  "text": "New paragraph",
  "afterBlockId": "optional-anchor"
}
```

Supported types are `paragraph`, `heading`, `codeBlock`, `blockquote`, `listItem` and `taskItem`. Heading creation defaults to H2.

When `blockId` is omitted, the server generates one and returns the client/server mapping in `createdBlocks`. Only top-level paragraph, heading and code-block creation is currently eligible for structural or mixed incremental indexing.

### Plain-text update

```json
{
  "type": "update",
  "blockId": "blk_alpha000",
  "text": "Replacement plain text"
}
```

This keeps the existing Block type and attributes while replacing its editable text payload.

### Safe rich Block replacement

```json
{
  "type": "replace",
  "blockId": "blk_alpha000",
  "node": {
    "type": "heading",
    "attrs": {
      "blockId": "blk_alpha000",
      "level": 3,
      "textAlign": "center",
      "lineHeight": "1.6"
    },
    "content": [
      {
        "type": "text",
        "text": "Nowen",
        "marks": [{ "type": "bold" }]
      }
    ]
  }
}
```

The API does not accept arbitrary ProseMirror JSON. Allowed Block nodes are `paragraph`, `heading` and `codeBlock`; allowed inline nodes are `text` and paragraph/heading `hardBreak`.

Allowed marks include bold, italic, underline, strike, inline code, safe links, highlight and text style. Unknown nodes, marks, attrs, fields, dangerous URL schemes, mismatched Block IDs and oversized replacement nodes return `INVALID_BLOCK_NODE` before persistence.

### Delete

```json
{
  "type": "delete",
  "blockId": "blk_alpha000"
}
```

The server repairs empty list and quote containers. Deleting every top-level identified Block creates one canonical empty paragraph with a fresh stable Block ID. Delete-all uses full index synchronization because the replacement Block did not exist in the pre-patch index.

### Move a normal Block

```json
{
  "type": "move",
  "blockId": "blk_beta0000",
  "targetBlockId": "blk_alpha000",
  "position": "after"
}
```

Legacy Block moves are supported inside the same parent. Cross-parent moves return `BLOCK_MOVE_PARENT_MISMATCH`. Incremental indexing currently requires top-level paragraph, heading or code-block identities.

### Move a list item

```json
{
  "type": "move",
  "scope": "listItem",
  "blockId": "blk_source_item",
  "targetBlockId": "blk_target_item",
  "position": "inside"
}
```

Supported positions:

- `inside`: sink the source under its immediate previous sibling;
- `after`: lift a nested item after its direct parent, or move at the same depth after another item;
- `before`: move at the same depth before another item.

The source and target item/list types must match. Other cross-depth moves, non-adjacent sink, conflicting nested-list types and self moves return `LIST_MOVE_INVALID`. The complete item subtree moves unchanged. See `docs/block-patch-list-hierarchy.md` for the full proof contract.

## Atomic semantics

Operations are evaluated in request order. Inside one SQLite transaction, the server:

1. Rechecks existence, permissions, lock state and version.
2. Verifies whether the persisted Block index mirrors the current Tiptap document.
3. Materializes missing stable IDs when full normalization is required.
4. Validates and applies every operation in memory.
5. Records the pre-edit version using the same five-minute merge window as whole-note save.
6. Updates `notes.content`, `contentText`, version and timestamp with optimistic locking.
7. Applies a leaf, structural, mixed, list-subtree or full index synchronization plan.
8. Stores the idempotent authoritative response.

Any failure rolls back the document, indexes, history row and idempotency record. One successful batch increments the note version exactly once. Idempotent replay returns the same authoritative content and generated IDs.

## Index update modes

Before any incremental mode is enabled, the server compares row count, Block IDs, types, parents, order, paths, plain text and content hashes. Any mismatch fails closed to full synchronization.

### `leaf`

Used for safe `update` and `replace` batches.

- Changed leaf rows are upserted.
- Indexed ancestors are refreshed when aggregate text/hash changes.
- Links are recreated only for changed source leaves.
- Unrelated rows and links keep their IDs and timestamps.

### `structural`

Used for top-level create, delete and move batches.

- New and deleted rows are inserted or removed.
- Only shifted `blockOrder/path` rows are updated.
- Pure moves preserve link rows.
- New and deleted source links are updated locally.

### `mixed`

Used when safe leaf and top-level structural operations occur together.

- Leaf changes and indexed ancestors are refreshed.
- Created/deleted rows are inserted or removed.
- Shifted top-level rows are updated.
- Links are recreated only for changed/new sources and removed for deleted sources.

### `list-subtree`

Used for one controlled scoped list-item move when the old index is an exact mirror of the source document.

- The moved root may change `parentBlockId`.
- The moved subtree and intervening rows may change `blockOrder/path`.
- Old/new parent items and their indexed ancestors may change aggregate `plainText/contentHash`.
- Paragraph, heading and code-block content/hash must remain unchanged.
- Only proven-different rows are upserted.
- No `note_links` rows are deleted or recreated, so links inside the moved subtree preserve their IDs and timestamps.

### `full`

Used whenever incremental correctness cannot be proven, including stale indexes, missing or duplicate IDs, unsupported nested mutations, identity ambiguity, complex nodes, delete-all replacement, or a list difference exceeding the single controlled move contract.

All fallback decisions happen inside the same transaction.

## Authoritative response

```json
{
  "success": true,
  "noteId": "note-id",
  "title": "Note title",
  "version": 8,
  "updatedAt": "2026-07-23T10:00:00.000Z",
  "content": "{\"type\":\"doc\",\"content\":[]}",
  "contentText": "Searchable plain text",
  "contentFormat": "tiptap-json",
  "notebookId": "notebook-id",
  "operationCount": 1,
  "affectedBlockIds": ["blk_source_item", "blk_target_item"],
  "deletedBlockIds": [],
  "createdBlocks": [],
  "blocks": [],
  "indexUpdateMode": "incremental",
  "indexUpdateKind": "list-subtree",
  "indexedBlockIds": ["blk_source_item", "blk_descendant"],
  "contentChangedByNormalization": false
}
```

The client must use the returned content and version as the base for the next dependent patch. Successful writes emit `note:updated` and `note:list-updated`.

## Editor rollout

The Tiptap Runtime enables Block Patch by default only for the active note in `viewport-optimized` or `lightweight-edit` mode.

A session override remains available:

```js
localStorage.setItem("nowen.tiptap_block_patch_v1", "on")
localStorage.setItem("nowen.tiptap_block_patch_v1", "off")
```

The runtime planner currently sends:

- plain-text changes as `update`;
- safe formatting and attrs as `replace`;
- top-level create/delete/reorder operations;
- safe content and structure changes as one mixed transaction;
- final-Block deletion as an empty-document delete batch;
- one proven-safe list sink, lift or same-depth move as scoped `move`.

The following continue through whole-note save:

- tables and table structure changes;
- images, videos, attachments, Mermaid, math and other atom nodes;
- list content changes combined with hierarchy changes;
- multiple independent list moves;
- top-level lift out of a list;
- conversion between bullet, ordered and task lists;
- arbitrary cross-depth or cross-type reparenting;
- unsupported complex paste operations;
- unknown extension nodes or attributes;
- title/meta changes.

Only one patch may be in flight per editor. Uncertain outcomes retry with the same idempotency key and never trigger a blind whole-note overwrite. Public, guest and presentation routes never mount the authenticated Block Patch AppContext bridge.

## Remaining boundaries

- `notes.content` remains the canonical complete document.
- A successful patch still serializes a full JSON snapshot.
- List-item create/delete and multi-item transactions still use full synchronization.
- Arbitrary nested structural operations remain deferred.
- Table, media, attachment, formula and Mermaid node patches are deferred.
- There is no independent Block-authoritative content table yet.
- Markdown uses its separate CodeMirror/Y.Text incremental path.
