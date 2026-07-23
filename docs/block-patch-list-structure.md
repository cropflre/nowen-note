# Block Patch list item structure V1

## Scope

Optimized Tiptap sessions can persist one proven-safe list-item creation or deletion through:

```http
POST /api/blocks/:noteId/patch
```

The operations reuse `create` and `delete` with an explicit list-item scope. This keeps normal top-level Block operations backward-compatible and avoids exposing arbitrary list-tree editing.

## Create one leaf list item

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

Requirements:

- the request contains exactly one operation;
- `scope` is exactly `listItem`;
- `blockId` and the paragraph Block ID are valid, distinct and not already present;
- `targetBlockId` identifies an existing sibling list item;
- `position` is `before` or `after`;
- `listItem` is inserted only into `bulletList` or `orderedList`;
- `taskItem` is inserted only into `taskList`;
- a task item must include a boolean `checked` attribute;
- the new item contains exactly one paragraph;
- the paragraph uses the same safe marks, link schemes and attributes as rich Block replacement;
- the node is limited to 256 KB.

V1 does not allow a newly created item to contain a nested list, multiple paragraphs, a table, media, formula, Mermaid or another extension node.

The server returns the item identity in `createdBlocks`. The paragraph already carries its stable client-generated Block ID in the authoritative content and Block index.

## Delete one leaf list item

```json
{
  "type": "delete",
  "scope": "listItem",
  "blockId": "blk_item_old"
}
```

Requirements:

- the request contains exactly one operation;
- the target is a `listItem` or `taskItem` under a compatible list container;
- the target contains exactly one paragraph;
- the target has no nested list or other child subtree.

The item and its paragraph are deleted together. When the source list becomes empty, its list wrapper is removed. An empty nested list wrapper is therefore removed from its parent item without deleting that parent item.

Deleting the only list item when it would make the complete Tiptap document empty is deliberately rejected with `LIST_STRUCTURE_INVALID`. The editor then uses its established whole-note empty-document path so the canonical replacement paragraph and Block ID can be reconciled safely.

## Frontend proof

The Runtime planner compares the complete before/after Tiptap JSON and sends a scoped structure operation only when one operation reproduces the target snapshot exactly.

Before sending a create request, it proves:

- exactly one list-item Block ID was added;
- exactly two total Block IDs were added: the item and its paragraph;
- no Block ID was deleted;
- every Block ID is globally valid and unique;
- the new item is a compatible leaf item;
- inserting before or after an existing sibling reproduces the full target JSON.

Before sending a delete request, it proves:

- exactly one list-item Block ID was removed;
- exactly two total Block IDs were removed: the item and its paragraph;
- no Block ID was added;
- the removed item was a compatible leaf item;
- deleting it and cleaning an empty list wrapper reproduces the full target JSON.

The planner falls back to whole-note save when the edit also changes an existing item payload. This includes the common Enter-key split case where the original paragraph text changes while a new item is created.

## Validation errors

Pre-persistence failures use:

- `INVALID_BLOCK_ID`
- `INVALID_BLOCK_NODE`
- `BLOCK_ID_CONFLICT`
- `BLOCK_NOT_FOUND`
- `LIST_STRUCTURE_INVALID`

These errors are safe whole-note fallback signals. Version conflicts and uncertain network outcomes retain the normal no-blind-overwrite behavior.

## Transaction semantics

Scoped list-item create/delete retains the standard Block Patch guarantees:

- permission and lock checks;
- optimistic note version validation;
- user-level idempotency key;
- pre-edit history snapshot using the five-minute merge window;
- one note-version increment per successful request;
- authoritative content response;
- realtime note/list broadcasts;
- full transaction rollback on any failure.

Only one scoped structure operation is accepted per request in V1.

## Incremental index mode

When the old Block index exactly mirrors the pre-patch Tiptap document, a successful operation returns:

```json
{
  "indexUpdateMode": "incremental",
  "indexUpdateKind": "list-structural"
}
```

### Create

The incremental plan:

- inserts the new item and paragraph rows;
- refreshes nested parent/ancestor aggregate text and hash when applicable;
- adjusts only rows whose `blockOrder` or `path` changed;
- creates note-link rows only for the new paragraph;
- preserves unrelated Block and link rows.

### Delete

The incremental plan:

- deletes the item and paragraph rows;
- refreshes nested parent/ancestor aggregate text and hash when applicable;
- adjusts only rows whose `blockOrder` or `path` changed;
- deletes note-link rows sourced from the removed item/paragraph;
- preserves unrelated Block and link rows.

Any stale index, identity mismatch, unexpected added/deleted row, leaf-content mutation, parent change outside the contract, or unproved structural difference falls back to complete Block/link synchronization in the same transaction.

## Remaining boundaries

- No item split transaction that also changes existing text.
- No nested subtree creation or deletion.
- No multiple create/delete operations in one request.
- No mixed list structure plus formatting/content patch.
- No top-level lift from a list into a standalone paragraph.
- No conversion between bullet, ordered and task lists.
- `notes.content` remains the canonical complete Tiptap document.
