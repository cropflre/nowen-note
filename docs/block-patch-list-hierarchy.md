# Block Patch list hierarchy V1

## Scope

Optimized Tiptap sessions can persist one proven-safe list hierarchy move through the existing Block Patch endpoint:

```http
POST /api/blocks/:noteId/patch
```

The protocol reuses the existing `move` operation with an explicit scope:

```json
{
  "type": "move",
  "scope": "listItem",
  "blockId": "blk_source_item",
  "targetBlockId": "blk_target_item",
  "position": "inside"
}
```

This avoids exposing an arbitrary tree-reparent API while keeping legacy top-level `move` requests compatible.

## Supported operations

### Sink one level

```json
{
  "type": "move",
  "scope": "listItem",
  "blockId": "blk_item_b",
  "targetBlockId": "blk_item_a",
  "position": "inside"
}
```

Requirements:

- source and target are in the same list container and at the same depth;
- target is the source's immediate previous sibling;
- item types match;
- list container types match exactly;
- an existing nested list under the target must have the same type and be unique.

The source item is appended to the target's nested list. If no nested list exists, the server creates one with the same type and a cloned copy of the current list's JSON attributes. This preserves canonical ordered-list attributes such as `start` without inventing schema fields.

The frontend still compares the complete result with the actual Tiptap snapshot. A custom ordered-list configuration whose generated nested attrs differ from this canonical copy fails closed to whole-note save.

### Lift one level

```json
{
  "type": "move",
  "scope": "listItem",
  "blockId": "blk_nested_item",
  "targetBlockId": "blk_parent_item",
  "position": "after"
}
```

Requirements:

- the source is exactly one list depth below the target;
- the target is the source item's direct parent list item;
- the nested and outer list types match;
- source and target item types match.

The source becomes the immediate sibling after its former parent. An empty nested list wrapper is removed.

Top-level lift out of a list into a paragraph is not part of V1 and remains on whole-note save.

### Move at the same depth

```json
{
  "type": "move",
  "scope": "listItem",
  "blockId": "blk_source_item",
  "targetBlockId": "blk_target_item",
  "position": "before"
}
```

or:

```json
{
  "type": "move",
  "scope": "listItem",
  "blockId": "blk_source_item",
  "targetBlockId": "blk_target_item",
  "position": "after"
}
```

The source and target may be in the same list or in separate list containers, provided that:

- both are at the same list depth;
- list types match exactly;
- item types match exactly.

When the source list becomes empty, its wrapper is removed. The complete item subtree, including large nested subtrees, marks, checked state and stable Block IDs, moves unchanged.

## Type compatibility

Supported pairs:

- `listItem` inside `bulletList`;
- `listItem` inside `orderedList`;
- `taskItem` inside `taskList`.

The server rejects:

- bullet-list to ordered-list moves;
- list-item to task-item moves;
- different-depth moves that are not the exact lift operation;
- sinking under a non-adjacent item;
- sinking into an item containing a conflicting or ambiguous nested list;
- moving an item to itself.

Rejected operations return:

```json
{
  "code": "LIST_MOVE_INVALID"
}
```

This is a known pre-persistence rejection, so the editor may safely use the established whole-note save fallback.

## Frontend proof

The runtime does not infer a list operation merely because the document shape changed. It compares the complete pre-save and post-save Tiptap JSON and sends a list patch only when a controlled single move can reproduce the final JSON.

Before planning, it verifies:

- the same stable list-item IDs exist before and after;
- each item's content, marks, checked state and non-list attributes are unchanged;
- non-list document structure is unchanged;
- list and item types remain compatible;
- the final JSON is exactly reproduced by a candidate move.

Large moved subtrees are supported without treating every descendant depth change as a separate move. Candidate generation is limited to items whose parent or sibling identity changed; all descendants are still validated by the final full-JSON replay.

Two equivalent operations can describe an adjacent swap. When several safe candidates reproduce the exact same JSON, the planner uses a stable semantic and lexical rank to choose one deterministic request.

A snapshot falls back to whole-note save when it includes:

- list content edits together with hierarchy changes;
- multiple independent list moves that no single operation can reproduce;
- list type conversion;
- item creation or deletion;
- unstable or duplicate list-item IDs;
- any unsupported structure.

The existing Block Patch serialization rule still allows only one confirmed request in flight per editor.

## Transaction and indexes

List hierarchy operations retain the normal Block Patch guarantees:

- permission and lock checks;
- optimistic note version validation;
- user-level idempotency keys;
- pre-edit version history in the five-minute merge window;
- one version increment per successful request;
- authoritative response content;
- complete rollback on failure.

V1 deliberately uses:

```json
{
  "indexUpdateMode": "full",
  "indexUpdateKind": "full"
}
```

Changing a list item's parent affects the item, its descendant paths, ancestor aggregate text and global Block order. Until a dedicated subtree index plan is proven, the server rebuilds Block and note-link indexes inside the same transaction.

Attachment ownership is unchanged because the complete item subtree moves inside the same note.

## Remaining boundaries

- No top-level lift from a list into a standalone paragraph.
- No conversion between bullet, ordered and task lists.
- No arbitrary cross-depth reparenting.
- No multi-item list transaction planning.
- No mixed list hierarchy plus content/mark patch in one request.
- No list-subtree incremental index update yet.
- `notes.content` remains the canonical complete Tiptap document.
