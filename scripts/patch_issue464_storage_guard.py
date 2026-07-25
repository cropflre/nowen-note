from pathlib import Path

path = Path("backend/src/services/legacyKnowledgeHierarchy.ts")
text = path.read_text(encoding="utf-8")

import_anchor = 'import { v4 as uuid } from "uuid";\n\n'
import_replacement = (
    'import { v4 as uuid } from "uuid";\n\n'
    'import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";\n\n'
)
if text.count(import_anchor) != 1:
    raise SystemExit(f"storage import anchor changed: {text.count(import_anchor)}")
text = text.replace(import_anchor, import_replacement, 1)

scope_anchor = '''function scopeKey(userId: string, workspaceId: string | null): string {
  return workspaceId ? `workspace:${workspaceId}` : `personal:${userId}`;
}

'''
scope_replacement = scope_anchor + '''function ensureKnowledgeTreeStorage(db: Database.Database): void {
  const exists = db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_tree_nodes'",
  ).get() as { found: number } | undefined;
  // Old databases and isolated route tests may not have loaded the knowledge-tree runtime bootstrap.
  // Only initialize when the table is absent. If tests intentionally drop legacy sync triggers while
  // keeping the table, this guard does not recreate those triggers.
  if (!exists) ensureKnowledgeTreeTables(db);
}

'''
if text.count(scope_anchor) != 1:
    raise SystemExit(f"storage helper anchor changed: {text.count(scope_anchor)}")
text = text.replace(scope_anchor, scope_replacement, 1)

anchors = [
    '''}): KnowledgeNodeRow {
  const notebook = readNotebook(input.db, input.notebookId);
''',
    '''}): KnowledgeNodeRow {
  const note = readNote(input.db, input.noteId);
''',
    ''')}): LegacyHierarchyConsistencyIssue[] {
  const issues: LegacyHierarchyConsistencyIssue[] = [];
''',
]
replacements = [
    '''}): KnowledgeNodeRow {
  ensureKnowledgeTreeStorage(input.db);
  const notebook = readNotebook(input.db, input.notebookId);
''',
    '''}): KnowledgeNodeRow {
  ensureKnowledgeTreeStorage(input.db);
  const note = readNote(input.db, input.noteId);
''',
    ''')}): LegacyHierarchyConsistencyIssue[] {
  ensureKnowledgeTreeStorage(input.db);
  const issues: LegacyHierarchyConsistencyIssue[] = [];
''',
]
for index, (anchor, replacement) in enumerate(zip(anchors, replacements), start=1):
    if text.count(anchor) != 1:
        raise SystemExit(f"storage call anchor {index} changed: {text.count(anchor)}")
    text = text.replace(anchor, replacement, 1)

path.write_text(text, encoding="utf-8")
print("patched conditional knowledge-tree storage bootstrap")
