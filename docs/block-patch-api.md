# Block Patch API V2-B

Block Patch API applies several Tiptap block mutations as one confirmed transaction. It is the persistence boundary between whole-note saves and the future block-authoritative storage model.

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

### Plain-text update

```json
{
  "type": "update",
  "blockId": "blk_alpha000",
  "text": "Replacement plain text"
}
```

This keeps the existing block type and attributes while replacing its editable text payload.

### Safe rich block replacement

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
        "marks": [
          { "type": "bold" },
          {
            "type": "link",
            "attrs": {
              "href": "https://example.com",
              "target": "_blank",
              "rel": "noopener noreferrer nofollow",
              "class": null
            }
          }
        ]
      }
    ]
  }
}
```

V2-A/V2-B do not accept arbitrary ProseMirror JSON. Frontend planning and backend validation enforce the same restricted schema.

Allowed block nodes:

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

Safe link protocols include `http`, `https`, `mailto`, `tel`, `sms`, `note`, anchors and relative paths. `javascript:`, `vbscript:`, `data:` and `file:` are rejected.

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

The server repairs empty list/quote containers. Deleting the final document block creates a valid empty paragraph. The editor rollout still keeps delete-all on whole-note save until the generated replacement Block ID can be reconciled explicitly.

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

## Atomic semantics

Operations are evaluated in request order. Inside one SQLite transaction, the server:

1. Rechecks note existence, permission, lock state and version.
2. Verifies whether the current Block index is a complete mirror of the Tiptap document.
3. Materializes missing stable Block IDs when the verification fails.
4. Validates and applies every operation in memory.
5. Records the pre-edit version using the same five-minute merge window as `PUT /notes/:id`.
6. Updates `notes.content`, `contentText`, version and timestamp using optimistic locking.
7. Applies either incremental or full index synchronization.
8. Stores the idempotent response.

Any failure rolls back the document, indexes, history row and idempotency record. One successful batch increments the note version exactly once. Replaying the same operation ID returns the stored authoritative result without adding another version.

## Incremental index mode

V2-B introduces fail-closed incremental synchronization for leaf-only `update` and `replace` batches.

Before enabling it, the server compares the current document and `note_blocks_index` for:

- total row count;
- stable and unique Block IDs;
- block type;
- parent Block ID;
- order and path;
- plain text and content hash.

Incremental mode is used only when this comparison succeeds and every operation targets a supported paragraph, heading or code block.

When enabled:

- only affected leaf Block rows are upserted;
- indexed ancestors such as `listItem`, `taskItem` and `blockquote` are also refreshed because their aggregate text/hash changes;
- only `note_links` rows whose `sourceBlockId` belongs to the changed leaf blocks are deleted and recreated;
- unrelated Block rows keep their original `createdAt/updatedAt` values;
- unrelated backlink rows keep their original IDs and timestamps;
- `contentText` is produced from the same verified document analysis instead of running the legacy full index rebuild again.

The server falls back to full synchronization for:

- create/delete/move operations;
- stale, missing or inconsistent Block indexes;
- missing or duplicate Block IDs;
- unsupported target nodes;
- structural or parent/path changes that cannot be proven safe.

The fallback occurs inside the same transaction and does not change the API's data-safety guarantees.

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
  "affectedBlockIds": ["blk_alpha000"],
  "deletedBlockIds": [],
  "createdBlocks": [],
  "blocks": [],
  "indexUpdateMode": "incremental",
  "indexedBlockIds": ["blk_parent000", "blk_alpha000"],
  "contentChangedByNormalization": false
}
```

- `indexUpdateMode` is `incremental` or `full`.
- `indexedBlockIds` reports the Block rows explicitly refreshed. It may include indexed ancestors in incremental mode.
- `affectedBlockIds` continues to describe the blocks addressed by the patch engine.

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
- simple top-level create/delete/reorder operations as structural operations.

The following continue through whole-note save:

- tables and table structure changes;
- images, videos, attachments, Mermaid, math and other atom nodes;
- list hierarchy changes and cross-parent moves;
- complex paste operations combining structure and rich block changes;
- unknown marks, attributes or extension nodes;
- title/meta changes;
- delete-all until empty-block identity reconciliation is implemented.

Only one patch may be in flight per editor. Later edits and title/meta saves wait for the authoritative version. Timeout/network uncertainty retries once with the same idempotency key; if the result remains unknown, the local draft is retained and no blind whole-note overwrite is issued.

Public, guest and presentation routes never mount the authenticated Block Patch AppContext bridge.

## Attachment boundary

The current schema stores attachment ownership in `attachments.noteId`; it does not maintain a separate content-reference index per Block. Therefore V2-B does not mutate attachment ownership or introduce an unused attachment-reference table. Media/attachment node edits still use whole-note save, while note split continues to handle attachment ownership and physical-path reuse transactionally.

## Remaining boundaries

- `notes.content` is still the canonical complete document.
- A successful patch still serializes the full JSON snapshot.
- Incremental indexes currently cover safe leaf `update/replace`; structural operations use full synchronization.
- Table, media, attachment, formula and Mermaid node patches are deferred.
- Cross-parent moves are deferred.
- There is no independent Block-authoritative content table yet.
- Markdown uses its separate CodeMirror/Y.Text incremental path.
