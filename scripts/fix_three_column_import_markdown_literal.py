from pathlib import Path

path = Path("frontend/src/components/NoteList.tsx")
text = path.read_text(encoding="utf-8")
old = '          content: "# 无标题 Markdown\n\n",'
new = '          content: "# 无标题 Markdown\\n\\n",'
if text.count(old) != 1:
    raise RuntimeError(f"expected one broken markdown literal, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("markdown newline literal fixed")
