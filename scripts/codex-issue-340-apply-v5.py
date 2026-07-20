from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
v2 = root / "scripts/codex-issue-340-apply-v2.py"
source = v2.read_text()
post_old = "'''        normalizedLinkContent = synced.content;\n        finalContent = synced.content;''',"
post_new = "'''      normalizedLinkContent = synced.content;\n      finalContent = synced.content;''',"
if post_old not in source:
    raise SystemExit("missing post sync indentation template")
v2.write_text(source.replace(post_old, post_new, 1))
runpy.run_path(str(v2), run_name="__main__")

experience = root / "backend/tests/search-experience.test.ts"
text = experience.read_text()
old = '''  content = contentText,
) {
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, OWNER_ID, NOTEBOOK_ID, title, content, contentText, contentFormat);
}'''
new = '''  content?: string,
) {
  const storedContent = content ?? (contentFormat === "tiptap-json"
    ? JSON.stringify({
        type: "doc",
        content: [{
          type: "paragraph",
          content: [{ type: "text", text: contentText }],
        }],
      })
    : contentText);
  db().prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, OWNER_ID, NOTEBOOK_ID, title, storedContent, contentText, contentFormat);
}'''
if old not in text:
    raise SystemExit("missing generated insertNote helper")
experience.write_text(text.replace(old, new, 1))

for temporary in [
    root / "scripts/codex-issue-340-apply-v3.py",
    root / "scripts/codex-issue-340-apply-v4.py",
    Path(__file__),
]:
    if temporary.exists():
        temporary.unlink()
