from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
v2 = root / "scripts/codex-issue-340-apply-v2.py"
text = v2.read_text()
text = text.replace(
    "'''        normalizedLinkContent = synced.content;\n        finalContent = synced.content;''',",
    "'''      normalizedLinkContent = synced.content;\n      finalContent = synced.content;''',",
)
text = text.replace(
    "'''        normalizedLinkContent = synced.content;\n        body.content = synced.content;\n        body.contentText = synced.contentText;''',",
    "'''      normalizedLinkContent = synced.content;\n      body.content = synced.content;\n      body.contentText = synced.contentText;''',",
)
v2.write_text(text)
runpy.run_path(str(v2), run_name="__main__")
Path(__file__).unlink()
