import assert from "node:assert/strict";
import test from "node:test";
import { closeDb, getDb } from "../src/db/schema";
import { initVecStore, isVecAvailable, knnSearch } from "../src/services/vec-store";

test("first successful extension load restores existing embeddings without vec_dim (#800)", () => {
  const db = getDb();
  try {
    db.prepare("INSERT INTO users (id,username,passwordHash) VALUES ('vec-owner','vec-owner','hash')").run();
    db.prepare("INSERT INTO notebooks (id,userId,name) VALUES ('vec-notebook','vec-owner','Vectors')").run();
    db.prepare(`INSERT INTO notes (id,userId,notebookId,title) VALUES
      ('vec-far','vec-owner','vec-notebook','Other note'),
      ('vec-note','vec-owner','vec-notebook','Existing note')`).run();
    db.prepare(`INSERT INTO note_embeddings
      (noteId,userId,chunkIndex,chunkText,vectorJson,model,dim)
      VALUES ('vec-far','vec-owner',0,'Other embedding','[0,1]','test-model',2),
        ('vec-note','vec-owner',0,'Previously computed embedding','[1,0]','test-model',2)`).run();
    assert.equal(db.prepare("SELECT value FROM system_settings WHERE key='vec_dim'").get(), undefined);

    assert.deepEqual(initVecStore(), { loaded: true, dim: 2 });
    assert.equal(isVecAvailable(), true);
    assert.equal(knnSearch([1, 0], "vec-owner", null)[0]?.noteId, "vec-note");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM note_embeddings").get() as { count: number }).count, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM vec_note_chunks").get() as { count: number }).count, 2);
    assert.deepEqual(db.prepare("SELECT value FROM system_settings WHERE key='vec_dim'").get(), { value: "2" });
    assert.deepEqual(initVecStore(), { loaded: true, dim: 2 });
  } finally {
    closeDb();
  }
});
