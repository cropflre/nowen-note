from pathlib import Path

root = Path(__file__).resolve().parents[1]
search_route = root / "backend/src/routes/search.ts"
text = search_route.read_text()
old = "  if (degraded || ftsCandidateCount === 0) return true;"
new = "  if (degraded) return true;"
if old not in text:
    raise SystemExit("missing zero-candidate fallback condition")
search_route.write_text(text.replace(old, new, 1))

notes = root / "backend/src/routes/notes.ts"
text = notes.read_text()
old = '''      const synced = syncNoteBlocks(db, id, stored.content || "", stored.contentFormat || "tiptap-json");
        db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
          .run(synced.content, synced.contentText, id);
        normalizedLinkContent = synced.content;
        finalContent = synced.content;'''
new = '''      const synced = syncNoteBlocks(db, id, stored.content || "", stored.contentFormat || "tiptap-json");
      db.prepare("UPDATE notes SET content = ?, contentText = ? WHERE id = ?")
        .run(synced.content, synced.contentText, id);
      normalizedLinkContent = synced.content;
      finalContent = synced.content;'''
if old not in text:
    raise SystemExit("missing create-path indentation cleanup")
notes.write_text(text.replace(old, new, 1))

experience = root / "backend/tests/search-experience.test.ts"
text = experience.read_text()
marker = '''test("indexed candidate retrieval stays bounded with 160 long notes", async () => {'''
addition = '''test("long tokenizer-safe misses do not trigger a full-body literal fallback", async () => {
  const response = await search(OWNER_ID, "definitelymissinglongtoken");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-search-literal-fallback"), "0");
  assert.equal(response.headers.get("x-search-candidate-count"), "0");
  assert.deepEqual(response.json, []);
});

'''
if marker not in text:
    raise SystemExit("missing performance test insertion marker")
experience.write_text(text.replace(marker, addition + marker, 1))

Path(__file__).unlink()
print("Finalized Issue #340 fallback boundary")
