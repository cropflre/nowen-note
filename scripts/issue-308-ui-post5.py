from pathlib import Path

path = Path(__file__).resolve().parent / "issue-308-ui.py"
text = path.read_text(encoding="utf-8")
old = r"""replace_once(
    "frontend/src/types/index.ts",
    '''  expiresAt: string | null;\n  createdBy: string;''',
    '''  expiresAt: string | null;\n  maxUses: number | null;\n  useCount: number;\n  createdBy: string;''',
)"""
new = r"""replace_once(
    "frontend/src/types/index.ts",
    '''export interface NotebookShareLink {\n  id: string;\n  notebookId: string;\n  token: string;\n  role: Exclude<NotebookRole, "owner">;\n  enabled: 0 | 1 | number;\n  expiresAt: string | null;\n  createdBy: string;''',
    '''export interface NotebookShareLink {\n  id: string;\n  notebookId: string;\n  token: string;\n  role: Exclude<NotebookRole, "owner">;\n  enabled: 0 | 1 | number;\n  expiresAt: string | null;\n  maxUses: number | null;\n  useCount: number;\n  createdBy: string;''',
)"""
if old not in text:
    raise RuntimeError("ambiguous NotebookShareLink type patch marker missing")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("Issue #308 NotebookShareLink type patch narrowed with literal escapes")
