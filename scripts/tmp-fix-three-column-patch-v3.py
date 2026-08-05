from pathlib import Path

path = Path("scripts/tmp-apply-three-column-folder-contents.py")
text = path.read_text()
replacements = [
    ('import { fileURLToPath } from "node:url";', 'import { resolve } from "node:path";'),
    ('fileURLToPath(new URL("../../components/NoteList.tsx", import.meta.url))', 'resolve(process.cwd(), "src/components/NoteList.tsx")'),
    ('fileURLToPath(new URL("../../components/KnowledgeTreePanel.tsx", import.meta.url))', 'resolve(process.cwd(), "src/components/KnowledgeTreePanel.tsx")'),
]
for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one staged test path target, found {count}: {old}")
    text = text.replace(old, new, 1)
path.write_text(text)
