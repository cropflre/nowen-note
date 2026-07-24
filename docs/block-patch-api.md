# Block Patch API V2-J

Block Patch applies ordered Tiptap mutations as one confirmed transaction. `notes.content` remains the canonical document; this API reduces the amount of editor-side and derived-index work without exposing arbitrary ProseMirror JSON.

## Endpoint

```http
POST /api/blocks/:noteId/patch
Authorization: Bearer <token>
Content-Type: application/json
```

Only `tiptap-json` notes are accepted.

## Request envelope

```json
{
  "expectedNoteVersion": 7,
  "operationId": "block-patch-550e8400-e29b-41d4-a716-446655440000",
  "operations": []
}
```

- `expectedNoteVersion` is required and checked again inside the write transaction.
- `operationId` is a per-user idempotency key, 8–128 characters.
- An uncertain retry must reuse the same operation ID.
- `operations` contains 1–100 ordered operations and the request is limited to approximately 2 MB.
- One successful request increments the note version exactly once.

## Normal Block operations

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

Supported indexed types are `paragraph`, `heading`, `codeBlock`, `blockquote`, `listItem` and `taskItem`. The normal structural incremental path is restricted to proven-safe top-level paragraph, heading and code-block changes.

### Plain-text update

```json
{
  "type": "update",
  "blockId": "blk_alpha000",
  "text": "Replacement plain text"
}
```

The existing Block type and attrs are preserved while its editable text payload is replaced.

### Safe rich replacement

```json
{
  "type": "replace",
  "blockId": "blk_alpha000",
  "node": {
    "type": "paragraph",
    "attrs": {
      "blockId": "blk_alpha000",
      "textAlign": null,
      "lineHeight": null
    },
    "content": [
      { "type": "text", "text": "Before " },
      {
        "type": "image",
        "attrs": {
          "src": "/api/attachments/11111111-1111-4111-8111-111111111111/content",
          "alt": "Diagram",
          "title": "Rotated diagram",
          "width": 640,
          "height": 360,
          "rotation": 90,
          "flipX": true
        }
      },
      { "type": "text", "text": " after" }
    ]
  }
}
```

Allowed replacement Block nodes:

- `paragraph`;
- `heading`;
- `codeBlock`.

Allowed inline nodes:

- `text`;
- paragraph/heading `hardBreak`;
- paragraph/heading `image`.

Allowed marks on text are bold, italic, underline, strike, inline code, safe links, highlight and text style.

### Inline image contract

An image is part of its identified parent paragraph or heading; it is not an independently versioned Block. Therefore adding, removing, replacing or changing an inline image is committed as one parent-Block `replace` operation.

Image attrs are limited to:

```text
src, alt, title, width, height, rotation, flipX
```

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

Unknown fields, nodes, attrs, marks, unsafe protocols, mismatched Block IDs and oversized payloads return `INVALID_BLOCK_NODE` before persistence.

Attachment ownership is not changed by this operation. Existing attachment upload/ownership rules still apply, and the complete authoritative JSON returned by the server becomes the next Patch baseline.

### Delete

```json
{
  "type": "delete",
  "blockId": "blk_alpha000"
}
```

Deleting all identified top-level Blocks creates one canonical empty paragraph with a new stable Block ID. The client reconciles that identity without adding an Undo history entry.

### Move

```json
{
  "type": "move",
  "blockId": "blk_beta000",
  "targetBlockId": "blk_alpha000",
  "position": "after"
}
```

Normal moves remain same-parent operations. Unsupported cross-parent changes fail closed.

## Scoped list operations

### Create or delete a leaf item

```json
{
  "type": "create",
  "scope": "listItem",
  "clientId": "blk_item_new",
  "blockId": "blk_item_new",
  "targetBlockId": "blk_item_old",
  "position": "after",
  "node": {
    "type": "listItem",
    "attrs": { "blockId": "blk_item_new" },
    "content": [
      {
        "type": "paragraph",
        "attrs": {
          "blockId": "blk_paragraph_new",
          "textAlign": null,
          "lineHeight": null
        }
      }
    ]
  }
}
```

```json
{
  "type": "delete",
  "scope": "listItem",
  "blockId": "blk_item_old"
}
```

A created item contains one identified safe paragraph. Task items require boolean `checked`. Nested subtree creation/deletion is not accepted by this leaf operation.

### Move, sink or lift inside list structure

```json
{
  "type": "move",
  "scope": "listItem",
  "blockId": "blk_source_item",
  "targetBlockId": "blk_target_item",
  "position": "inside"
}
```

- `inside` sinks under the immediate previous compatible item;
- `before` and `after` perform a proven same-depth or controlled cross-parent move;
- bullet, ordered and task list types are not implicitly converted.

### Lift a root list item to a paragraph

```json
{
  "type": "lift",
  "scope": "listItem",
  "blockId": "blk_root_item",
  "position": "after"
}
```

The list-item wrapper is removed while its paragraph Block ID, text and marks are preserved. Empty list wrappers are cleaned up.

### Ordered list batches

The endpoint accepts up to 100 ordered operations. The editor can use one atomic batch for:

- Enter split: replace/update the original paragraph plus create the new item;
- multi-line paste creating several items;
- batch delete;
- consecutive compatible moves;
- controlled content/format plus list-structure changes.

The frontend sends a batch only when applying the generated operations reproduces the complete target JSON. The server maintains temporary identities across the batch and rejects references to missing, deleted or conflicting Blocks.

## Atomic semantics

Inside one SQLite transaction the server:

1. rechecks existence, permission, lock state and note version;
2. validates the full operation sequence before persistence;
3. applies operations in order to an in-memory document;
4. records the pre-edit version using the existing merge window;
5. updates canonical content, searchable text, version and timestamp;
6. updates Block/link indexes incrementally when correctness is proven, otherwise performs a full rebuild;
7. stores the authoritative idempotent response;
8. emits note and list realtime updates after commit.

Any failure rolls back content, indexes, history and the idempotency record.

## Index update modes

`indexUpdateMode` is `incremental` or `full`.

`indexUpdateKind` currently reports:

- `leaf`: safe update/replace, including identified paragraphs containing inline images;
- `structural`: top-level create/delete/move;
- `mixed`: normal leaf plus top-level structure;
- `list-subtree`: controlled list hierarchy movement;
- `list-structural`: list-item create/delete/lift and compatible structure batches;
- `list-mixed`: list structure plus paragraph content/format changes;
- `full`: correctness could not be proven.

Before an incremental path is used, the persisted Block index must mirror the current document. Any missing/duplicate ID, stale row, unexpected parent/path/content difference or unsupported node fails closed to full synchronization.

Only affected link sources are recreated. Pure structural moves preserve existing link row IDs and timestamps.

## Authoritative response

```json
{
  "success": true,
  "noteId": "note-id",
  "title": "Note title",
  "version": 8,
  "updatedAt": "2026-07-24T10:00:00.000Z",
  "content": "{\"type\":\"doc\",\"content\":[]}",
  "contentText": "Searchable plain text",
  "contentFormat": "tiptap-json",
  "notebookId": "notebook-id",
  "operationCount": 1,
  "affectedBlockIds": ["blk_alpha000"],
  "deletedBlockIds": [],
  "createdBlocks": [],
  "blocks": [],
  "indexUpdateMode": "incremental",
  "indexUpdateKind": "leaf",
  "indexedBlockIds": ["blk_alpha000"],
  "contentChangedByNormalization": false
}
```

The returned `content` and `version` are the only valid base for a dependent Patch. Only one request may be in flight per editor. A timeout or other uncertain result retries with the same operation ID and never triggers a blind whole-note overwrite.

## Editor rollout

Block Patch is enabled by default for the active authenticated Tiptap note in `viewport-optimized` and `lightweight-edit` modes. A session override remains available:

```js
localStorage.setItem("nowen.tiptap_block_patch_v1", "on")
localStorage.setItem("nowen.tiptap_block_patch_v1", "off")
```

Public, guest and presentation routes do not mount the authenticated Patch bridge.

## Whole-save fallback boundaries

The following remain on the whole-document path:

- tables and table structure;
- Block Embed, video/iframe, Mermaid and math nodes;
- unsupported image attrs or unsafe image sources;
- arbitrary unknown extensions;
- bullet/ordered/task type conversion;
- list changes that cannot be reproduced by a bounded deterministic batch;
- title and other note metadata changes;
- any result whose identity or structure cannot be proven.

## Remaining architecture boundaries

- `notes.content` is still the canonical complete document.
- Every successful Patch still serializes a complete JSON snapshot.
- Images do not yet have independent Block identity or Block-level version history.
- There is no independent Block-authoritative table or Block-to-attachment reference table.
- Markdown uses its separate editor path; a format-aware Markdown Block Patch protocol is not implemented yet.
- Table/media/embedding node families require separate schema-specific Patch contracts.
