from pathlib import Path

root = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    if old not in text:
        raise SystemExit(f"missing {label} in {path}")
    path.write_text(text.replace(old, new, 1))


search_route = root / "backend/src/routes/search.ts"
text = search_route.read_text()
old = "  if (degraded || ftsCandidateCount === 0) return true;"
if old not in text:
    raise SystemExit("missing zero-candidate fallback condition")
text = text.replace(old, "  if (degraded) return true;", 1)
for old_name, new_name in [
    ("FROM notes_fts", "FROM notes_search_fts"),
    ("notes_fts.rowid", "notes_search_fts.rowid"),
    ("notes_fts MATCH", "notes_search_fts MATCH"),
    ("bm25(notes_fts", "bm25(notes_search_fts"),
]:
    text = text.replace(old_name, new_name)
old_import = '''  markSearchIndexRebuilt,
  repairSearchContentText,
} from "../lib/searchIndex";'''
new_import = '''  markSearchIndexRebuilt,
  rebuildNormalizedSearchFts,
  repairSearchContentText,
} from "../lib/searchIndex";'''
if old_import not in text:
    raise SystemExit("missing normalized rebuild import marker")
text = text.replace(old_import, new_import, 1)
old_rebuild = '''      db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
      markSearchIndexRebuilt(db, rebuiltAt);'''
new_rebuild = '''      db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
      rebuildNormalizedSearchFts(db);
      markSearchIndexRebuilt(db, rebuiltAt);'''
if old_rebuild not in text:
    raise SystemExit("missing rebuild endpoint marker")
search_route.write_text(text.replace(old_rebuild, new_rebuild, 1))

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

schema = root / "backend/src/db/schema.ts"
replace_once(
    schema,
    'import { assertSafeTestDatabasePath } from "./test-db-guard.js";\n',
    'import { assertSafeTestDatabasePath } from "./test-db-guard.js";\nimport { ensureNormalizedSearchFts } from "../lib/searchIndex.js";\n',
    "schema normalized FTS import",
)
replace_once(
    schema,
    '''      runMigrations(db);
    } catch (e) {''',
    '''      runMigrations(db);
      ensureNormalizedSearchFts(db);
    } catch (e) {''',
    "startup normalized FTS ensure",
)

migrations = root / "backend/src/db/migrations.ts"
replace_once(
    migrations,
    'import { markSearchIndexRebuilt, repairSearchContentText } from "../lib/searchIndex.js";',
    'import { markSearchIndexRebuilt, rebuildNormalizedSearchFts, repairSearchContentText } from "../lib/searchIndex.js";',
    "migration normalized rebuild import",
)
replace_once(
    migrations,
    '''    db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
    markSearchIndexRebuilt(db);''',
    '''    db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
    rebuildNormalizedSearchFts(db);
    markSearchIndexRebuilt(db);''',
    "migration normalized rebuild",
)

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
print("Finalized Issue #340 normalized candidate index")
