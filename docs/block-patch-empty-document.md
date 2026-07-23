# Block Patch empty-document reconciliation

## Scope

Tiptap optimized modes may persist deletion of the final identified top-level Block through `POST /api/blocks/:noteId/patch` instead of forcing a whole-note save.

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

The patch engine guarantees that a Tiptap document never remains empty. After all requested operations are applied, it creates one empty paragraph with a fresh stable Block ID and returns it through the authoritative response:

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

When the editor snapshot still equals the sent empty snapshot, `preserveLocalEditor` is false. The normal note-content synchronization effect receives the server-generated paragraph. Before Tiptap applies its whole-document `setContent` transaction, `tiptapEmptyBlockIdentityDispatch` verifies that:

- both current and incoming documents contain exactly one empty paragraph;
- document attributes are identical;
- paragraph attributes are identical except for `blockId`;
- the incoming Block ID is valid and differs from the local ID.

Only under those conditions, the incoming transaction is replaced with:

```text
setNodeMarkup(0, { ...currentAttrs, blockId: serverBlockId })
+ addToHistory = false
+ preventUpdate inherited from setContent
```

Consequences:

- the editor DOM and document content are not rebuilt;
- the current selection and caret position remain unchanged;
- no save event is emitted;
- the server Block ID becomes the local canonical identity;
- the metadata update is not added to ProseMirror history.

Any text, structure, document attribute or presentation attribute difference bypasses the interceptor and executes the original synchronization transaction.

When the user types again while the delete request is in flight, the current editor snapshot differs from the sent empty snapshot. `preserveLocalEditor` is true, so the response does not overwrite the newer local input. The queued save is planned against the confirmed server version and reconciles the local Block identity in the next confirmed patch.

## Undo behavior

The user's delete transaction remains the latest history event. The later server Block ID assignment is mapped through history but is not stored as an additional undo item.

Therefore, the first Undo after reconciliation restores the content that the user deleted. It does not merely switch the empty paragraph from the server Block ID back to the temporary local Block ID.

The dedicated ProseMirror regression covers:

1. deleting the last paragraph;
2. applying a server-generated empty paragraph through a setContent-style transaction;
3. verifying the applied transaction has `addToHistory=false`;
4. preserving the caret position;
5. executing Undo and restoring the original text and Block ID.

## Idempotency and recovery

- Retrying an uncertain delete-all request uses the same `operationId`.
- An idempotent replay returns the same generated Block ID and authoritative content.
- A version conflict does not trigger a blind whole-note overwrite.
- Failure before commit leaves the original Block, version history and indexes unchanged.
- Successful deletion and replacement increase the note version exactly once.

## Remaining boundary

This interceptor is intentionally limited to a single empty paragraph and a Block-ID-only difference. It is not a generic remote-document merge mechanism. Non-empty Block identity changes, multiple-Block documents, formatting changes and structural changes continue through the established guarded content synchronization path.
