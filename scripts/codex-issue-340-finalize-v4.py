from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
search_index = root / "backend/src/lib/searchIndex.ts"
text = search_index.read_text()
old_key = 'const SEARCH_REBUILT_AT_KEY = "search_index_last_rebuilt_at";'
new_key = '''const SEARCH_REBUILT_AT_KEY = "search_index_last_rebuilt_at";
const normalizedSearchFunctionDatabases = new WeakSet<object>();'''
if old_key not in text:
    raise SystemExit("missing normalized function WeakSet marker")
text = text.replace(old_key, new_key, 1)
old_function = '''  db.function(
    "nowen_search_normalize",
    { deterministic: true },
    (value: unknown) => normalizeSearchText(value === null || value === undefined ? "" : String(value)),
  );'''
new_function = '''  if (!normalizedSearchFunctionDatabases.has(db as object)) {
    db.function(
      "nowen_search_normalize",
      { deterministic: true },
      (value: unknown) => normalizeSearchText(value === null || value === undefined ? "" : String(value)),
    );
    normalizedSearchFunctionDatabases.add(db as object);
  }'''
if old_function not in text:
    raise SystemExit("missing normalized SQL function registration")
text = text.replace(old_function, new_function, 1)
old_table = '''    CREATE VIRTUAL TABLE IF NOT EXISTS notes_search_fts USING fts5(
      title,
      contentText
    );'''
new_table = '''    CREATE VIRTUAL TABLE IF NOT EXISTS notes_search_fts USING fts5(
      title,
      contentText,
      content='',
      tokenize='trigram'
    );'''
if old_table not in text:
    raise SystemExit("missing normalized FTS table definition")
text = text.replace(old_table, new_table, 1)
old_rebuild = '''export function rebuildNormalizedSearchFts(db: Database.Database): void {
  createNormalizedSearchFts(db);
  db.prepare("INSERT INTO notes_search_fts(notes_search_fts) VALUES('delete-all')").run();
  db.prepare(`'''
new_rebuild = '''export function rebuildNormalizedSearchFts(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS notes_search_ai;
    DROP TRIGGER IF EXISTS notes_search_ad;
    DROP TRIGGER IF EXISTS notes_search_au;
    DROP TABLE IF EXISTS notes_search_fts;
  `);
  createNormalizedSearchFts(db);
  db.prepare(`'''
if old_rebuild not in text:
    raise SystemExit("missing normalized FTS rebuild implementation")
search_index.write_text(text.replace(old_rebuild, new_rebuild, 1))
runpy.run_path(str(root / "scripts/codex-issue-340-finalize.py"), run_name="__main__")
for temporary in [
    root / "scripts/codex-issue-340-finalize-v2.py",
    root / "scripts/codex-issue-340-finalize-v3.py",
    Path(__file__),
]:
    if temporary.exists():
        temporary.unlink()
