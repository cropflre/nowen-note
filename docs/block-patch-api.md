# Block Patch API V2-D

Block Patch API applies ordered Tiptap Block mutations as one confirmed transaction. It is the persistence boundary between whole-note saves and the future Block-authoritative storage model.

## Endpoint

```http
POST /api/blocks/:noteId/patch
Authorization: Bearer <token>
Content-Type: application/json
```

The endpoint currently accepts only notes whose `contentFormat` is `tiptap-json`.

## Request envelope

```json
{
  "expectedNoteVersion": 7,
  "operationId": "block-patch-550e8400-e29b-41d4-a716-446655440000",
  "operations": []
}
```

- `expectedNoteVersion` is required. A mismatch returns `409 VERSION_CONFLICT` before persistence.
- `operationId` is a user-level idempotency key, 8–128 characters. An uncertain retry must reuse the same ID for the same note.
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

Supported create types:

- `paragraph`
- `heading` — created as H2
- `codeBlock`
- `blockquote`
- `listItem`
- `taskItem`

When `blockId` is omitted, the server generates one and returns the client/server mapping in `createdBlocks`.

Only top-level `paragraph`, `heading` and `codeBlock` creation is currently eligible for structural or mixed incremental indexing. Other create types remain valid API operations but use full index synchronization.

An explicitly identified Block created earlier in the same request may be referenced by a later top-level `move`. The server validates these temporary identities in operation order before enabling incremental mode.

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

V2 does not accept arbitrary ProseMirror JSON. Frontend planning and backend validation enforce the same restricted schema.

Allowed Block nodes:

- `paragraph`
- `heading`
- `codeBlock`

Allowed inline nodes:

- `text`
- `hardBreak` for paragraphs/headings only

Allowed marks:

- `bold`
- `italic`
- `underline`
- `strike`
- `code`
- `link`
- `highlight`
- `textStyle`

Allowed attributes:

- paragraph: `blockId`, `textAlign`, `lineHeight`
- heading: paragraph attrs plus `level` from 1–6
- code block: `blockId`, `language`, `indent` from 0–8
- text style: safe hexadecimal `color` and validated `fontSize`
- highlight: safe hexadecimal `color`
- link: `href`, `target`, `rel`, `class`

Safe link protocols include `http`, `https`, `mailto`, `tel`, `sms`, `note`, anchors and relative paths. Script-execution, data and local-file schemes are rejected.

Additional guards:

- `node.attrs.blockId` must equal the operation target.
- A replacement node is limited to 256 KB.
- Code blocks cannot contain inline marks or hard breaks.
- Top-level paragraph, heading and code blocks may convert among those three types.
- Nested blocks must retain their original type.
- Unknown fields, attrs, marks or inline nodes return `400 INVALID_BLOCK_NODE` before persistence.

### Delete

```json
{
  "type": "delete",
  "blockId": "blk_alpha000"
}
```

The server repairs empty list/quote containers. Deleting the final document Block creates a valid empty paragraph. The editor rollout still keeps delete-all on whole-note save until the generated replacement Block ID can be reconciled explicitly.

Only deletion of an existing top-level paragraph, heading or code block is eligible for structural or mixed incremental indexing.

### Move

```json
{
  "type": "move",
  "blockId": "blk_beta0000",
  "targetBlockId": "blk_alpha000",
  "position": "after"
}
```

Moves are supported only inside the same parent. Cross-parent moves return `BLOCK_MOVE_PARENT_MISMATCH`.

Incremental indexing additionally requires the moved Block and anchor to be top-level paragraphs, headings or code blocks. They may either exist before the request or be explicitly identified Blocks created earlier in the same request.

## Atomic semantics

Operations are evaluated in request order. Inside one SQLite transaction, the server:

1. Rechecks note existence, permission, lock state and version.
2. Verifies whether the current Block index is a complete mirror of the Tiptap document.
3. Materializes missing stable Block IDs when verification fails.
4. Validates and applies every operation in memory.
5. Records the pre-edit version using the same five-minute merge window as `PUT /notes/:id`.
6. Updates `notes.content`, `contentText`, version and timestamp using optimistic locking.
7. Applies a leaf, structural, mixed or full index synchronization plan.
8. Stores the idempotent response.

Any failure rolls back the document, indexes, history row and idempotency record. One successful batch increments the note version exactly once. Replaying the same operation ID returns the stored authoritative result without adding another version.

## Incremental index modes

Before any incremental mode is enabled, the server compares the current document and `note_blocks_index` for:

- total row count;
- stable and unique Block IDs;
- Block type;
- parent Block ID;
- order and path;
- plain text and content hash.

Any mismatch fails closed to full synchronization.

### Leaf incremental mode

Used for batches containing only safe `update` and `replace` operations.

- Only changed leaf rows are upserted.
- Indexed ancestors such as `listItem`, `taskItem` and `blockquote` are refreshed when their aggregate text/hash changes.
- Only `note_links` rows belonging to changed source leaf Blocks are recreated.
- Unrelated Block rows and backlink rows keep their IDs and timestamps.

### Structural incremental mode

Used for batches containing only `create`, `delete` and `move`, when all affected structures are top-level paragraphs, headings or code blocks.

The planner computes:

- newly inserted index rows;
- deleted index rows;
- existing rows whose `blockOrder` or `path` changed;
- links belonging to newly created or deleted source Blocks.

Behavior:

- inserting a top-level simple Block upserts the new row and only the shifted range;
- deleting a top-level simple Block removes that row and only updates the shifted range;
- moving top-level simple Blocks updates only rows whose order/path changed;
- a newly created explicit Block ID may be moved later in the same request;
- pure moves preserve existing backlink row IDs and timestamps;
- links from deleted Blocks are removed;
- links in newly created Block text are indexed.

### Mixed incremental mode

Used when one request contains both:

- safe `update` or `replace` leaf operations; and
- safe top-level `create`, `delete` or `move` operations.

The final document is analyzed once and converted into one unified database plan:

- changed leaf rows and their indexed ancestors are refreshed;
- newly created and deleted rows are inserted or removed;
- top-level rows whose order/path changed are updated;
- links are recreated only for changed leaf sources and newly created Blocks;
- links for deleted Blocks are removed;
- pure-move source links remain untouched;
- unaffected rows and links keep their existing IDs and timestamps.

A mixed plan is rejected and falls back to full synchronization when:

- a leaf target is created or deleted in the same request;
- a move or create anchor is deleted in the same request;
- a structural shift changes nested list, task or quote paths;
- a nested Block changes parent or type;
- create/delete counts do not exactly match the final identity delta;
- a deleted ID is reused;
- create-then-delete makes final identity ambiguous;
- delete-all creates a server-generated empty replacement Block;
- any content change cannot be explained by the declared leaf operations and their indexed ancestors.

All incremental fallback decisions happen inside the same transaction and preserve the API's data-safety guarantees.

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
  "operationCount": 3,
  "affectedBlockIds": ["blk_alpha000", "blk_created00"],
  "deletedBlockIds": [],
  "createdBlocks": [],
  "blocks": [],
  "indexUpdateMode": "incremental",
  "indexUpdateKind": "mixed",
  "indexedBlockIds": ["blk_alpha000", "blk_created00", "blk_shifted00"],
  "contentChangedByNormalization": false
}
```

- `indexUpdateMode` is `incremental` or `full`.
- `indexUpdateKind` is `leaf`, `structural`, `mixed` or `full`.
- `indexedBlockIds` contains Block IDs inserted, updated or deleted by index synchronization. Full mode returns every rebuilt Block ID.
- `affectedBlockIds` continues to describe Blocks addressed by the patch engine.

The client must use the returned snapshot and version as the base for the next dependent patch. Successful writes emit `note:updated` and `note:list-updated` realtime messages.

## Error codes

Common errors:

- `INVALID_BLOCK_PATCH`
- `INVALID_PATCH`
- `INVALID_BLOCK_ID`
- `INVALID_BLOCK_NODE`
- `BLOCK_ID_CONFLICT`
- `BLOCK_NOT_FOUND`
- `BLOCK_MOVE_SELF`
- `BLOCK_MOVE_PARENT_MISMATCH`
- `INVALID_TIPTAP_DOCUMENT`
- `NOTE_LOCKED`
- `VERSION_CONFLICT`
- `OPERATION_ID_CONFLICT`
- `BLOCK_FORMAT_UNSUPPORTED`

Known validation errors occur before persistence and may safely fall back to the established whole-note save path. Version conflicts and uncertain network outcomes must not trigger a blind full overwrite.

## Editor grey rollout

`frontend/src/components/TiptapEditorRuntime.tsx` enables Block Patch by default only when the active runtime decision belongs to that note and its mode is `viewport-optimized` or `lightweight-edit`.

A session override remains available:

```js
localStorage.setItem("nowen.tiptap_block_patch_v1", "on")
localStorage.setItem("nowen.tiptap_block_patch_v1", "off")
```

The legacy key name is retained for compatibility.

The planner currently sends:

- plain-text changes as `update`;
- safe marks, links, line breaks, heading level, alignment, line height, code language and indent as `replace`;
- simple top-level create/delete/reorder operations as structural operations;
- safe rich replacements and top-level structural operations together as one mixed transaction.

The following continue through whole-note save:

- tables and table structure changes;
- images, videos, attachments, Mermaid, math and other atom nodes;
- list hierarchy changes and cross-parent moves;
- unsupported or ambiguous complex paste operations;
- unknown marks, attributes or extension nodes;
- title/meta changes;
- delete-all until empty-Block identity reconciliation is implemented.

Only one patch may be in flight per editor. Later edits and title/meta saves wait for the authoritative version. Timeout/network uncertainty retries once with the same idempotency key; if the result remains unknown, the local draft is retained and no blind whole-note overwrite is issued.

Public, guest and presentation routes never mount the authenticated Block Patch AppContext bridge.

## Attachment boundary

The current schema stores attachment ownership in `attachments.noteId`; it does not maintain a separate content-reference index per Block. V2-D does not mutate attachment ownership or introduce an unused attachment-reference table. Media/attachment node edits still use whole-note save, while note split continues to handle attachment ownership and physical-path reuse transactionally.

## Remaining boundaries

- `notes.content` is still the canonical complete document.
- A successful patch still serializes the full JSON snapshot.
- Nested structural operations and cross-parent moves are deferred.
- Table, media, attachment, formula and Mermaid node patches are deferred.
- Empty-document replacement Block ID reconciliation is deferred.
- There is no independent Block-authoritative content table yet.
- Markdown uses its separate CodeMirror/Y.Text incremental path.
