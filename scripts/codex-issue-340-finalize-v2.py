from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
search_index = root / "backend/src/lib/searchIndex.ts"
text = search_index.read_text()
old = '''    CREATE VIRTUAL TABLE IF NOT EXISTS notes_search_fts USING fts5(
      title,
      contentText
    );'''
new = '''    CREATE VIRTUAL TABLE IF NOT EXISTS notes_search_fts USING fts5(
      title,
      contentText,
      content=''
    );'''
if old not in text:
    raise SystemExit("missing normalized FTS table definition")
search_index.write_text(text.replace(old, new, 1))
runpy.run_path(str(root / "scripts/codex-issue-340-finalize.py"), run_name="__main__")
Path(__file__).unlink()
