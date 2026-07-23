# Block Patch empty-document reconciliation

## Scope

Tiptap optimized modes may now persist deletion of the final identified top-level Block through `POST /api/blocks/:noteId/patch` instead of forcing a whole-note save.

The frontend planner recognizes two transient empty representations:

```json
{ "type": "doc", "content": [] }
```

and a schema placeholder paragraph without a valid stable Block ID:

```json
{
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "attrs": {
        "blockId": null,
        "textAlign": null,
        "lineHeight": null
      },
      "content": []
    }
  ]
}
```

It converts either representation into ordered `delete` operations for the previous identified top-level paragraphs, headings and code blocks.

Complex nested documents remain on whole-note save because deleting an arbitrary container tree cannot be expressed safely by the current top-level planner.

## Server identity

The existing patch engine already guarantees that a Tiptap document never remains empty. After all requested operations are applied, it creates one empty paragraph with a fresh stable Block ID and returns it through the authoritative response:

```json
{
  "createdBlocks": [
    {
      "operationIndex": 1,
      "clientId": null,
      "blockId": "blk_server_generated"
    }
  ],
  "content": "{\"type\":\"doc\",\"content\":[...]}",
  "indexUpdateMode": "full",
  "indexUpdateKind": "full"
}
```

`operationIndex === operationCount` together with `clientId === null` identifies the automatic empty-document replacement rather than a client-requested create operation.

Delete-all deliberately remains on the full index synchronization path. The generated Block did not exist in the pre-patch index and must become the only canonical row; all links from deleted source Blocks are removed transactionally.

## Editor ACK behavior

The runtime always stores the server response as the next authoritative note version.

When the editor snapshot still equals the sent empty snapshot, `preserveLocalEditor` is false. The established Tiptap ACK guard therefore allows the note-content synchronization effect to load the server-generated paragraph. That effect suppresses save emission and clamps the previous selection into the new document, leaving the caret in a valid editable position.

When the user types again while the delete request is in flight, the current editor snapshot differs from the sent empty snapshot. `preserveLocalEditor` is true, so the response does not overwrite the newer local input. The queued save is planned against the confirmed server version; it can delete the server-generated empty Block and create or update the local identified Block in one later transaction.

This preserves the more important user input while still ensuring that the next persistence baseline contains a stable server-confirmed Block identity.

## Idempotency and recovery

- Retrying an uncertain delete-all request uses the same `operationId`.
- An idempotent replay returns the same generated Block ID and authoritative content.
- A version conflict does not trigger a blind whole-note overwrite.
- Failure before commit leaves the original Block, version history and indexes unchanged.
- Successful deletion and replacement increase the note version exactly once.

## Remaining boundary

The current content synchronization effect replays authoritative JSON through the established `setContent(..., { emitUpdate: false })` path. Selection restoration is covered; a dedicated no-history ProseMirror metadata-only reconciliation can be considered later if product testing finds that undo UX after delete-all needs stronger preservation across the server-generated identity change.
