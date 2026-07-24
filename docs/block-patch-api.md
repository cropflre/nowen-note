# Block Patch API V2-J

Block Patch applies ordered Tiptap or Markdown Block mutations as one confirmed transaction. The same transaction updates the compatibility snapshot, Block-authoritative shadow, indexes and operation history.

## Endpoint

```http
POST /api/blocks/:noteId/patch
Authorization: Bearer <token>
Content-Type: application/json
```

Notes whose `contentFormat` is `tiptap-json` or `markdown` are accepted. The operation union is selected by the persisted format; clients cannot choose a parser independently.

## Request envelope

```json
{
  "expectedNoteVersion": 7,
  "expectedStructureVersion": 3,
  "expectedBlockVersions": { "blk_alpha000": 5 },
  "operationId": "block-patch-550e8400-e29b-41d4-a716-446655440000",
  "operations": []
}
```

- `expectedNoteVersion` is required. A mismatch normally returns `409 VERSION_CONFLICT`.
- A stale note version may still apply a content-only `update`/`replace` when every affected Block has a matching `expectedBlockVersions` entry. This prevents an unrelated Block edit from conflicting.
- Structural create/delete/move/lift may additionally carry `expectedStructureVersion`; a mismatch returns `409 STRUCTURE_VERSION_CONFLICT`.
- A relevant content version mismatch returns `409 BLOCK_VERSION_CONFLICT` with the conflicting Block IDs and current versions.
- `operationId` is a user-level idempotency key, 8–128 characters.
- An uncertain retry must reuse the same operation ID for the same note.
- Reusing one operation ID on another note returns `409 OPERATION_ID_CONFLICT`.
- `operations` contains 1–100 ordered operations. The request is limited to approximately 2 MB.

## Operations

### Create a normal Block

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

When `blockId` is omitted, the server generates one and returns the client/server mapping in `createdBlocks`. Only top-level paragraph, heading and code-block creation is currently eligible for normal structural or mixed incremental indexing.

### Create one leaf list item

```json
{
  "type": "create",
  "scope": "listItem",
  "clientId": "blk_item_new",
  "blockId": "blk_item_new",
  "targetBlockId": "blk_existing_item",
  "position": "after",
  "node": {
    "type": "listItem",
    "attrs": {
      "blockId": "blk_item_new"
    },
    "content": [
      {
        "type": "paragraph",
        "attrs": {
          "blockId": "blk_paragraph_new",
          "textAlign": null,
          "lineHeight": null
        },
        "content": [
          {
            "type": "text",
            "text": "New item",
            "marks": [{ "type": "bold" }]
          }
        ]
      }
    ]
  }
}
```

V2-I accepts exactly one scoped list-item create operation per request.

Requirements:

- `position` is `before` or `after` an existing sibling;
- item and paragraph Block IDs are valid, distinct and globally unused;
- `listItem` targets a bullet/ordered list;
- `taskItem` targets a task list and includes boolean `checked`;
- the item contains exactly one safe paragraph;
- no nested list, table, media, formula, Mermaid or second paragraph is accepted;
- the item node is limited to 256 KB.

See `docs/block-patch-list-structure.md` for the complete replay proof and fallback contract.

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

The API does not accept arbitrary ProseMirror JSON. Allowed leaf Block nodes are `paragraph`, `heading` and `codeBlock`; allowed inline nodes are `text`, paragraph/heading `hardBreak`, `image` and `mathInline`.

Allowed marks include bold, italic, underline, strike, inline code, safe links, highlight and text style. Paragraphs accept the editor's bounded `indent` attribute (`0`–`8`). Unknown nodes, marks, attrs, fields, dangerous URL schemes, mismatched Block IDs and oversized replacement nodes return `INVALID_BLOCK_NODE` before persistence.

The same `replace` protocol accepts an existing top-level `video`, `blockEmbed` or `mathBlock` only when the replacement has the same type and Block ID and passes its attribute/URL/size allowlist. Inline images remain owned by their parent paragraph or heading and are patched by replacing that parent Block. Mermaid remains a `codeBlock` with the `mermaid` language.

### Inline image contract

An image is part of its identified parent paragraph or heading; it is not an independently versioned Block. Adding, removing, replacing or changing an inline image is committed as one parent-Block `replace` operation.

Image attrs are limited to `src`, `alt`, `title`, `width`, `height`, `rotation` and `flipX`.

Validation rules:

- `src` accepts HTTP(S), `/`, `./`, `../`, or bounded raster data URLs;
- raster data URLs are limited to PNG, JPEG, GIF and WebP;
- SVG data URLs, `javascript:`, `vbscript:`, `file:` and `blob:` are rejected;
- `alt` and `title` are limited to 512 characters and cannot contain control characters;
- `width` and `height` are integers from 1 to 10000;
- `rotation` is one of `0`, `90`, `180`, `270`;
- `flipX` is boolean;
- images cannot carry marks and cannot appear in a code block;
- one normalized replacement node cannot exceed 256 KB.

Attachment ownership is not changed by this operation. Existing attachment upload/ownership rules still apply, and the complete authoritative JSON returned by the server becomes the next Patch baseline.

## Markdown operations

Markdown Blocks use stable trailing `^blk_*` markers and a content hash. `replace`, `insert`, `delete` and `move` are supported, up to 100 ordered operations. The server parses ranges again, checks every expected hash and replays the complete result before persistence. Ambiguous IDs or boundaries inside fenced code, tables, lists, quotes, raw HTML or reference definitions fail closed; the client then uses the existing whole-document save path.

### Replace one top-level table atomically

`replace` also accepts one existing top-level `table` as an atomic Block. The target and replacement must use the same table `blockId`; table creation, deletion, moving, nesting and conversion to another node type continue through whole-note save.

The accepted shape is `table -> tableRow -> tableCell/tableHeader -> paragraph -> text/hardBreak`. Every level uses an attribute allowlist. Nested paragraph Block IDs must be valid, unique inside the table and conflict-free with Blocks outside the replaced table. A table is limited to 500 rows, 200 cells per row, 10,000 cells total and 256 KB per replacement node. Table replacements always use full Block/link index synchronization inside the same note transaction.

### Delete a normal Block

```json
{
  "type": "delete",
  "blockId": "blk_alpha000"
}
```

The server repairs empty list and quote containers. Deleting every top-level identified Block creates one canonical empty paragraph with a fresh stable Block ID. Delete-all uses full index synchronization because the replacement Block did not exist in the pre-patch index.

### Delete one leaf list item

```json
{
  "type": "delete",
  "scope": "listItem",
  "blockId": "blk_item_old"
}
```

The target must contain exactly one paragraph and no nested list or subtree. The item and paragraph Block rows are deleted together. An empty list wrapper is removed.

Deleting the only list item when it would make the complete Tiptap document empty returns `LIST_STRUCTURE_INVALID`. The editor then uses the established whole-note empty-document save path and Block ID reconciliation.

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
7. Applies a leaf, structural, mixed, list-subtree, list-structural or full index synchronization plan.
8. Rebuilds and verifies the Block-authoritative records, per-Block versions, structure version and attachment ownership.
9. Stores the idempotent authoritative response.

Any failure rolls back the document, indexes, history row and idempotency record. One successful request increments the note version exactly once. Idempotent replay returns the same authoritative content and generated IDs.

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
- No `note_links` rows are deleted or recreated.

### `list-structural`

Used for one controlled leaf list-item create or delete.

For create:

- exactly the new item and its paragraph are inserted;
- nested parent/ancestor aggregate text and hash are refreshed when needed;
- only shifted `blockOrder/path` rows are updated;
- links are extracted only from the new paragraph.

For delete:

- exactly the item and its paragraph are removed;
- nested parent/ancestor aggregate text and hash are refreshed when needed;
- only shifted `blockOrder/path` rows are updated;
- links sourced from the removed item/paragraph are deleted.

Existing leaf content must remain unchanged. Any extra added/deleted Block, unexpected parent change or unproved structural difference disables this mode.

### `full`

Used whenever incremental correctness cannot be proven, including stale indexes, missing or duplicate IDs, unsupported nested mutations, identity ambiguity, complex nodes, delete-all replacement, multi-item list edits, or a list difference exceeding a controlled operation contract.

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
  "affectedBlockIds": ["blk_item_new", "blk_paragraph_new"],
  "deletedBlockIds": [],
  "createdBlocks": [
    {
      "operationIndex": 0,
      "clientId": "blk_item_new",
      "blockId": "blk_item_new"
    }
  ],
  "blocks": [],
  "indexUpdateMode": "incremental",
  "indexUpdateKind": "list-structural",
  "indexedBlockIds": ["blk_item_new", "blk_paragraph_new"],
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
- one proven-safe list sink, lift or same-depth move;
- one proven-safe leaf list-item create or delete.

List-item create/delete planning requires an exact full-JSON replay and a globally unique Block identity delta. The following continue through whole-note save:

- item split where the original paragraph also changes;
- nested list-subtree creation or deletion;
- multiple list-item create/delete operations;
- mixed list structure plus content/formatting changes;
- deleting the only list item when the whole document becomes empty;
- tables and table structure changes;
- images, videos, attachments, Mermaid, math and other atom nodes;
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
- Multi-item and mixed list-structure transactions remain deferred.
- Arbitrary nested structural operations remain deferred.
- Table, media, attachment, formula and Mermaid node patches are deferred.
- There is no independent Block-authoritative content table yet.
- Markdown uses its separate CodeMirror/Y.Text incremental path.
