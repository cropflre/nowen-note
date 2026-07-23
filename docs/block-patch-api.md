# Block Patch API V2-A

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

Supported V1 create types:

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

This operation keeps the existing block type and attributes while replacing its editable text payload. It remains useful for the lowest-cost typing path.

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

V2-A does not accept arbitrary ProseMirror JSON. Both frontend planning and backend validation enforce the same restricted schema.

Allowed block node types:

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
- A single replacement node is limited to 256 KB.
- Code blocks cannot contain inline marks or hard breaks.
- Top-level paragraph, heading and code blocks may convert among those three types.
- Nested blocks must retain their original type so list/quote schemas cannot be broken.
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
2. Materializes missing stable Block IDs.
3. Validates and applies every operation in memory.
4. Records the pre-edit version using the same five-minute merge window as `PUT /notes/:id`.
5. Updates `notes.content`, `contentText`, version and timestamp using optimistic locking.
6. Rebuilds the Block index once.
7. Rebuilds note links once.
8. Stores the idempotent response.

Any failure rolls back the document, indexes, history row and idempotency record. One successful batch increments the note version exactly once. Replaying the same operation ID returns the stored authoritative result without adding another version.

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
  "contentChangedByNormalization": false
}
```

The client must use this snapshot and version as the base for the next dependent patch. Successful writes also emit the normal `note:updated` and `note:list-updated` realtime messages.

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

The legacy key name is retained for compatibility even though the protocol now includes V2-A replacement operations.

The planner currently sends:

- plain-text changes as `update`;
- safe marks, links, line breaks, heading level, alignment, line height, code language and indent as `replace`;
- simple top-level create/delete/reorder operations as V1 operations.

The following continue through whole-note save:

- tables and table structure changes;
- images, videos, attachments, Mermaid, math and other atom nodes;
- list hierarchy changes and cross-parent moves;
- complex paste operations that combine structure and rich block changes;
- unknown marks, attributes or extension nodes;
- title/meta changes;
- delete-all until empty-block identity reconciliation is implemented.

Only one patch may be in flight per editor. Later edits and title/meta saves wait for the authoritative version. Timeout/network uncertainty retries once with the same idempotency key; if the result remains unknown, the local draft is retained and no blind whole-note overwrite is issued.

Public, guest and presentation routes never mount the authenticated Block Patch AppContext bridge.

## Remaining boundaries

- `notes.content` is still the canonical complete document.
- A successful patch still serializes the full JSON snapshot.
- Block and link indexes are still rebuilt for the whole note.
- Attachment reference indexes are not incrementally patched.
- Arbitrary JSON node replacement, table patches, media patches and cross-parent moves are deferred.
- Markdown uses its separate CodeMirror/Y.Text incremental path.
