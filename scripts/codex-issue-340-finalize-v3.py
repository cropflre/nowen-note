from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
search_index = root / "backend/src/lib/searchIndex.ts"
text = search_index.read_text()
old_table = '''    CREATE VIRTUAL TABLE IF NOT EXISTS notes_search_fts USING fts5(
      title,
      contentText
    );'''
new_table = '''    CREATE VIRTUAL TABLE IF NOT EXISTS notes_search_fts USING fts5(
      title,
      contentText,
      content=''
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
    Path(__file__),
]:
    if temporary.exists():
        temporary.unlink()
