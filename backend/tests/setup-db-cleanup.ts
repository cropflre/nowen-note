import test from "node:test";

let closed = false;

test.after(async () => {
  if (closed) return;
  closed = true;

  // Some note-split routes synchronize the rewritten source into an in-memory Y.Doc.
  // Those temporary rooms keep a five-minute idle timer, so closing SQLite alone does not let
  // the Node test process exit. Destroy every room before closing the isolated test database.
  const { getYjsStats, yDestroyDoc } = await import("../src/services/yjs.ts");
  for (const room of getYjsStats().details) {
    yDestroyDoc(room.noteId);
  }

  const { closeDb } = await import("../src/db/schema.ts");
  closeDb();
});
