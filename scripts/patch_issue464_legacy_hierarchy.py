from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label} changed: expected 1 match, got {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label} changed: expected 1 match, got {count}")
    return updated


service_path = Path("backend/src/services/legacyKnowledgeHierarchy.ts")
service = service_path.read_text(encoding="utf-8")
service = service.replace('import { ensureKnowledgeTreeTables } from "../db/knowledgeTreeMigration.js";\n\n', "")
service = service.replace("  ensureKnowledgeTreeTables(input.db);\n", "")
if "ensureKnowledgeTreeTables" in service:
    raise SystemExit("legacy coordinator still recreates migration triggers")
service_path.write_text(service, encoding="utf-8")


notes_path = Path("backend/src/routes/notes.ts")
notes = notes_path.read_text(encoding="utf-8")
notes = replace_once(
    notes,
    'import { extractSearchableText } from "../lib/searchIndex";\n',
    'import { extractSearchableText } from "../lib/searchIndex";\n'
    'import {\n'
    '  synchronizeLegacyNoteHierarchy,\n'
    '  synchronizeLegacyNotebookHierarchy,\n'
    '} from "../services/legacyKnowledgeHierarchy";\n',
    "notes coordinator import",
)

notes = replace_once(
    notes,
    '''  const stmt = db.prepare("UPDATE notes SET sortOrder = ? WHERE id = ?");
  const updateMany = db.transaction((list: { id: string; sortOrder: number }[]) => {
    for (const item of list) {
      const { permission } = resolveNotePermission(item.id, userId);
      if (hasPermission(permission, "write")) {
        stmt.run(item.sortOrder, item.id);
      }
    }
  });
''',
    '''  const stmt = db.prepare("UPDATE notes SET sortOrder = ? WHERE id = ?");
  const updateMany = db.transaction((list: { id: string; sortOrder: number }[]) => {
    for (const item of list) {
      const { permission } = resolveNotePermission(item.id, userId);
      if (hasPermission(permission, "write")) {
        stmt.run(item.sortOrder, item.id);
        synchronizeLegacyNoteHierarchy({
          db,
          noteId: item.id,
          actorUserId: userId,
          reason: "reorder",
          parentMode: "preserve",
        });
      }
    }
  });
''',
    "notes batch reorder",
)

notes = replace_once(
    notes,
    '''  try {
    db.prepare(`
      INSERT INTO notes (id, userId, workspaceId, notebookId, title, content, contentText, contentFormat)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, userId, inheritedWorkspaceId, body.notebookId,
      body.title || "无标题笔记", initialContent,
      extractSearchableText(initialContent, contentFormat), contentFormat,
    );
  } catch (e: any) {
''',
    '''  const legacyNoteCreateTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO notes (id, userId, workspaceId, notebookId, title, content, contentText, contentFormat)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, userId, inheritedWorkspaceId, body.notebookId,
      body.title || "无标题笔记", initialContent,
      extractSearchableText(initialContent, contentFormat), contentFormat,
    );
    synchronizeLegacyNoteHierarchy({
      db,
      noteId: id,
      actorUserId: userId,
      reason: "create",
      parentMode: "resource",
    });
  });
  try {
    legacyNoteCreateTx();
  } catch (e: any) {
''',
    "notes create transaction",
)

notes = replace_once(
    notes,
    '''  if (body.isTrashed !== undefined) {
''',
    '''  const restoredAncestorNotebookIds: string[] = [];
  if (body.isTrashed !== undefined) {
''',
    "notes restore accumulator",
)

notes = regex_once(
    notes,
    r'''            db\.prepare\(\s*`UPDATE notebooks\s+SET isDeleted = 0,\s+deletedAt = NULL,\s+updatedAt = datetime\('now'\)\s+WHERE id IN \(\$\{placeholders\}\)`\s*\)\.run\(\.\.\.restoreIds\);''',
    '''            restoredAncestorNotebookIds.push(...restoreIds);''',
    "notes ancestor restore deferred update",
)

notes = replace_once(
    notes,
    '''  if (hasNoteColumnChange) {
    fields.push("version = version + 1");
    if (hasContentFieldChange) {
      fields.push("updatedAt = datetime('now')");
    }
    params.push(id);
    db.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  }
''',
    '''  const needsLegacyHierarchySync = body.notebookId !== undefined
    || body.sortOrder !== undefined
    || body.isTrashed !== undefined
    || body.contentFormat !== undefined;

  if (hasNoteColumnChange) {
    fields.push("version = version + 1");
    if (hasContentFieldChange) {
      fields.push("updatedAt = datetime('now')");
    }
    params.push(id);
    const legacyNoteUpdateTx = db.transaction(() => {
      if (restoredAncestorNotebookIds.length > 0) {
        const placeholders = restoredAncestorNotebookIds.map(() => "?").join(",");
        db.prepare(
          `UPDATE notebooks
              SET isDeleted = 0,
                  deletedAt = NULL,
                  updatedAt = datetime('now')
            WHERE id IN (${placeholders})`,
        ).run(...restoredAncestorNotebookIds);
        for (const notebookId of restoredAncestorNotebookIds) {
          synchronizeLegacyNotebookHierarchy({
            db,
            notebookId,
            actorUserId: userId,
            reason: "restore",
            parentMode: "preserve",
          });
        }
      }

      db.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`).run(...params);
      if (needsLegacyHierarchySync) {
        const reason = body.notebookId !== undefined
          ? "move"
          : body.isTrashed === 1
            ? "delete"
            : body.isTrashed === 0
              ? "restore"
              : body.sortOrder !== undefined
                ? "reorder"
                : "metadata";
        synchronizeLegacyNoteHierarchy({
          db,
          noteId: id,
          actorUserId: userId,
          reason,
          parentMode: body.notebookId !== undefined ? "resource" : "preserve",
        });
      }
    });
    legacyNoteUpdateTx();
  }
''',
    "notes update transaction",
)
notes_path.write_text(notes, encoding="utf-8")


notebooks_path = Path("backend/src/routes/notebooks.ts")
notebooks = notebooks_path.read_text(encoding="utf-8")
notebooks = replace_once(
    notebooks,
    '''import {
  copyPersonalNotebookToWorkspace,
  WorkspaceNotebookTransferError,
} from "../services/workspaceNotebookTransfer";
''',
    '''import {
  copyPersonalNotebookToWorkspace,
  WorkspaceNotebookTransferError,
} from "../services/workspaceNotebookTransfer";
import {
  synchronizeLegacyNoteHierarchy,
  synchronizeLegacyNotebookHierarchy,
} from "../services/legacyKnowledgeHierarchy";
''',
    "notebooks coordinator import",
)

notebooks = replace_once(
    notebooks,
    '''  const id = uuid();
  db.prepare(
    `INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, color, sortOrder)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    workspaceId,
    body.parentId || null,
    body.name,
    body.icon || "📒",
    body.color || null,
    body.sortOrder || 0,
  );
''',
    '''  const id = uuid();
  const legacyNotebookCreateTx = db.transaction(() => {
    db.prepare(
      `INSERT INTO notebooks (id, userId, workspaceId, parentId, name, icon, color, sortOrder)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      workspaceId,
      body.parentId || null,
      body.name,
      body.icon || "📒",
      body.color || null,
      body.sortOrder || 0,
    );
    synchronizeLegacyNotebookHierarchy({
      db,
      notebookId: id,
      actorUserId: userId,
      reason: "create",
      parentMode: "resource",
    });
  });
  legacyNotebookCreateTx();
''',
    "notebooks create transaction",
)

notebooks = replace_once(
    notebooks,
    '''  db.prepare(`UPDATE notebooks SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  const notebook = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(id);
''',
    '''  const legacyNotebookMoveTx = db.transaction(() => {
    db.prepare(`UPDATE notebooks SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    synchronizeLegacyNotebookHierarchy({
      db,
      notebookId: id,
      actorUserId: userId,
      reason: newParentId !== undefined ? "move" : "reorder",
      parentMode: newParentId !== undefined ? "resource" : "preserve",
    });
  });
  legacyNotebookMoveTx();
  const notebook = db.prepare("SELECT * FROM notebooks WHERE id = ?").get(id);
''',
    "notebooks move transaction",
)

notebooks = replace_once(
    notebooks,
    '''      if (hasPermission(permission, "write")) {
        stmt.run(item.sortOrder, item.id);
      }
''',
    '''      if (hasPermission(permission, "write")) {
        stmt.run(item.sortOrder, item.id);
        synchronizeLegacyNotebookHierarchy({
          db,
          notebookId: item.id,
          actorUserId: userId,
          reason: "reorder",
          parentMode: "preserve",
        });
      }
''',
    "notebooks batch reorder",
)

notebooks = replace_once(
    notebooks,
    '''  db.prepare(
    `
    UPDATE notebooks SET name = COALESCE(?, name), icon = COALESCE(?, icon),
    color = COALESCE(?, color), parentId = COALESCE(?, parentId),
    sortOrder = COALESCE(?, sortOrder), isExpanded = COALESCE(?, isExpanded),
    updatedAt = datetime('now')
    WHERE id = ?
  `,
  ).run(
    body.name,
    body.icon,
    body.color,
    body.parentId,
    body.sortOrder,
    body.isExpanded,
    id,
  );
''',
    '''  const legacyNotebookUpdateTx = db.transaction(() => {
    db.prepare(
      `
      UPDATE notebooks SET name = COALESCE(?, name), icon = COALESCE(?, icon),
      color = COALESCE(?, color), parentId = COALESCE(?, parentId),
      sortOrder = COALESCE(?, sortOrder), isExpanded = COALESCE(?, isExpanded),
      updatedAt = datetime('now')
      WHERE id = ?
    `,
    ).run(
      body.name,
      body.icon,
      body.color,
      body.parentId,
      body.sortOrder,
      body.isExpanded,
      id,
    );
    if (body.parentId !== undefined || body.sortOrder !== undefined || body.isExpanded !== undefined) {
      synchronizeLegacyNotebookHierarchy({
        db,
        notebookId: id,
        actorUserId: userId,
        reason: body.parentId !== undefined ? "move" : body.sortOrder !== undefined ? "reorder" : "metadata",
        parentMode: body.parentId !== undefined ? "resource" : "preserve",
      });
    }
  });
  legacyNotebookUpdateTx();
''',
    "notebooks generic update transaction",
)

notebooks = replace_once(
    notebooks,
    '''  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE notebooks
          SET isDeleted = 1,
              deletedAt = datetime('now'),
              updatedAt = datetime('now')
        WHERE id IN (${placeholders}) AND isDeleted = 0`,
    ).run(...nbIds);

    if (trashedNoteIds.length > 0) {
      const noteIn = trashedNoteIds.map(() => "?").join(",");
      db.prepare(
        `UPDATE notes
            SET isTrashed = 1,
                trashedAt = datetime('now'),
                updatedAt = datetime('now')
          WHERE id IN (${noteIn})`,
      ).run(...trashedNoteIds);
    }
  });

  try {
    tx();
''',
    '''  const legacyNotebookDeleteTx = db.transaction(() => {
    db.prepare(
      `UPDATE notebooks
          SET isDeleted = 1,
              deletedAt = datetime('now'),
              updatedAt = datetime('now')
        WHERE id IN (${placeholders}) AND isDeleted = 0`,
    ).run(...nbIds);

    if (trashedNoteIds.length > 0) {
      const noteIn = trashedNoteIds.map(() => "?").join(",");
      db.prepare(
        `UPDATE notes
            SET isTrashed = 1,
                trashedAt = datetime('now'),
                updatedAt = datetime('now')
          WHERE id IN (${noteIn})`,
      ).run(...trashedNoteIds);
    }

    for (const notebookId of nbIds) {
      synchronizeLegacyNotebookHierarchy({
        db,
        notebookId,
        actorUserId: userId,
        reason: "delete",
        parentMode: "preserve",
      });
    }
    for (const noteId of trashedNoteIds) {
      synchronizeLegacyNoteHierarchy({
        db,
        noteId,
        actorUserId: userId,
        reason: "delete",
        parentMode: "preserve",
      });
    }
  });

  try {
    legacyNotebookDeleteTx();
''',
    "notebooks delete transaction",
)
notebooks_path.write_text(notebooks, encoding="utf-8")

print("patched issue #464 legacy hierarchy write paths")
