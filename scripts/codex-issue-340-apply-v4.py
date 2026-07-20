from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
v2 = root / "scripts/codex-issue-340-apply-v2.py"
text = v2.read_text()
post_old = "'''        normalizedLinkContent = synced.content;\n        finalContent = synced.content;''',"
post_new = "'''      normalizedLinkContent = synced.content;\n      finalContent = synced.content;''',"
if post_old not in text:
    raise SystemExit("missing post sync indentation template")
text = text.replace(post_old, post_new, 1)
v2.write_text(text)
runpy.run_path(str(v2), run_name="__main__")
for temporary in [
    root / "scripts/codex-issue-340-apply-v3.py",
    Path(__file__),
]:
    if temporary.exists():
        temporary.unlink()
