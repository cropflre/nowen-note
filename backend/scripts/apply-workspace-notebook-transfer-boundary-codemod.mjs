import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.resolve(here, "../src/services/workspaceNotebookTransfer.ts");
let source = fs.readFileSync(filePath, "utf8");

function exact(from, to, label) {
  if (!source.includes(from)) throw new Error(`missing expected fragment: ${label}`);
  source = source.replace(from, to);
}

function regex(pattern, to, label) {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`${label}: expected one match, got ${matches?.length || 0}`);
  }
  source = source.replace(pattern, to);
}

exact(
  'import type Database from "better-sqlite3";\nimport { getDb } from "../db/schema";',
  'import { workspaceNotebookTransferRepository } from "../repositories/workspaceNotebookTransferRepository";',
  "database imports",
);
exact(
  'import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";\nimport { syncNoteLinks } from "../lib/noteLinks";\n',
  "",
  "reference helper imports",
);

exact(
  `function collectNotebookTree(db: Database.Database, source: NotebookRow): NotebookRow[] {\n  const all = db\n    .prepare("SELECT * FROM notebooks WHERE userId = ? AND workspaceId IS NULL AND isDeleted = 0")\n    .all(source.userId) as NotebookRow[];`,
  `function collectNotebookTree(source: NotebookRow): NotebookRow[] {\n  const all = workspaceNotebookTransferRepository.listPersonalNotebooks<NotebookRow>(source.userId);`,
  "collect notebook tree",
);

exact("  const db = getDb();\n", "", "root database handle");
exact(
  "    const result = db.transaction(() => {",
  "    const result = workspaceNotebookTransferRepository.transaction(() => {",
  "transaction start",
);
exact("    })();\n", "    });\n", "transaction end");

exact(
  `      const source = db\n        .prepare("SELECT * FROM notebooks WHERE id = ?")\n        .get(input.sourceNotebookId) as NotebookRow | undefined;`,
  `      const source = workspaceNotebookTransferRepository.findNotebook<NotebookRow>(\n        input.sourceNotebookId,\n      );`,
  "source notebook query",
);
exact(
  `        const parent = db\n          .prepare("SELECT id, workspaceId, isDeleted FROM notebooks WHERE id = ?")\n          .get(targetParentId) as { id: string; workspaceId: string | null; isDeleted: number } | undefined;`,
  `        const parent = workspaceNotebookTransferRepository.findTargetParent<{\n          id: string;\n          workspaceId: string | null;\n          isDeleted: number;\n        }>(targetParentId);`,
  "target parent query",
);
exact(
  "      const notebookTree = collectNotebookTree(db, source);",
  "      const notebookTree = collectNotebookTree(source);",
  "notebook tree call",
);

regex(
  /\n      const insertNotebook = db\.prepare\(`\n        INSERT INTO notebooks[\s\S]*?\n      `\);\n      for \(const nb of notebookTree\) \{\n        const newId = notebookIdMap\.get\(nb\.id\)!;\n        const newParentId = nb\.id === source\.id \? targetParentId : notebookIdMap\.get\(nb\.parentId \|\| ""\) \|\| null;\n        insertNotebook\.run\(\n          newId,\n          actorUserId,\n          targetWorkspaceId,\n          newParentId,\n          nb\.name,\n          nb\.description,\n          nb\.icon,\n          nb\.color,\n          nb\.sortOrder \|\| 0,\n          nb\.isExpanded \?\? 1,\n        \);\n      \}/,
  `\n      for (const nb of notebookTree) {\n        const newId = notebookIdMap.get(nb.id)!;\n        const newParentId = nb.id === source.id ? targetParentId : notebookIdMap.get(nb.parentId || "") || null;\n        workspaceNotebookTransferRepository.insertNotebook({\n          id: newId,\n          userId: actorUserId,\n          workspaceId: targetWorkspaceId,\n          parentId: newParentId,\n          name: nb.name,\n          description: nb.description,\n          icon: nb.icon,\n          color: nb.color,\n          sortOrder: nb.sortOrder || 0,\n          isExpanded: nb.isExpanded ?? 1,\n        });\n      }`,
  "notebook inserts",
);

regex(
  /      const oldNotebookIds = notebookTree\.map\(\(nb\) => nb\.id\);\n      const notebookPlaceholders = oldNotebookIds\.map\(\(\) => "\?"\)\.join\(","\);\n      const sourceNotes = oldNotebookIds\.length\n        \? db[\s\S]*?\n        : \[\];/,
  `      const oldNotebookIds = notebookTree.map((nb) => nb.id);\n      const sourceNotes = workspaceNotebookTransferRepository.listSourceNotes<NoteRow>(\n        oldNotebookIds,\n        actorUserId,\n      );`,
  "source notes query",
);

regex(
  /        const oldNoteIds = sourceNotes\.map\(\(n\) => n\.id\);\n        const notePlaceholders = oldNoteIds\.map\(\(\) => "\?"\)\.join\(","\);\n        const rows = db\n          \.prepare\(`SELECT \* FROM attachments WHERE noteId IN \(\$\{notePlaceholders\}\)`\)\n          \.all\(\.\.\.oldNoteIds\) as AttachmentRow\[\];/,
  `        const oldNoteIds = sourceNotes.map((n) => n.id);\n        const rows = workspaceNotebookTransferRepository.listAttachmentsByNoteIds<AttachmentRow>(\n          oldNoteIds,\n        );`,
  "attachments query",
);

regex(
  /\n      const insertAttachment = db\.prepare\(`\n        INSERT INTO attachments[\s\S]*?\n      `\);\n/,
  "\n",
  "attachment statement",
);

regex(
  /\n      const insertNote = db\.prepare\(`\n        INSERT INTO notes[\s\S]*?\n      `\);\n      for \(const item of pendingNotes\) \{\n        insertNote\.run\(\n          item\.newId,\n          actorUserId,\n          targetWorkspaceId,\n          notebookIdMap\.get\(item\.oldNote\.notebookId\)!,\n          item\.oldNote\.title,\n          item\.content,\n          item\.contentText,\n          item\.oldNote\.contentFormat \|\| "tiptap-json",\n          item\.oldNote\.isPinned \|\| 0,\n          item\.oldNote\.sortOrder \|\| 0,\n        \);\n      \}/,
  `\n      for (const item of pendingNotes) {\n        workspaceNotebookTransferRepository.insertNote({\n          id: item.newId,\n          userId: actorUserId,\n          workspaceId: targetWorkspaceId,\n          notebookId: notebookIdMap.get(item.oldNote.notebookId)!,\n          title: item.oldNote.title,\n          content: item.content,\n          contentText: item.contentText,\n          contentFormat: item.oldNote.contentFormat || "tiptap-json",\n          isPinned: item.oldNote.isPinned || 0,\n          sortOrder: item.oldNote.sortOrder || 0,\n        });\n      }`,
  "note inserts",
);

regex(
  /      for \(const att of pendingAttachments\) \{\n        insertAttachment\.run\(\n          att\.id,\n          att\.noteId,\n          actorUserId,\n          att\.filename,\n          att\.mimeType,\n          att\.size,\n          att\.path,\n          targetWorkspaceId,\n          att\.hash,\n        \);\n      \}/,
  `      for (const att of pendingAttachments) {\n        workspaceNotebookTransferRepository.insertAttachment({\n          ...att,\n          userId: actorUserId,\n          workspaceId: targetWorkspaceId,\n        });\n      }`,
  "attachment inserts",
);

regex(
  /        const oldNoteIds = sourceNotes\.map\(\(n\) => n\.id\);\n        const notePlaceholders = oldNoteIds\.map\(\(\) => "\?"\)\.join\(","\);\n        const noteTags = db\n          \.prepare\(`SELECT noteId, tagId FROM note_tags WHERE noteId IN \(\$\{notePlaceholders\}\)`\)\n          \.all\(\.\.\.oldNoteIds\) as Array<\{ noteId: string; tagId: string \}>;\n        const oldTagIds = Array\.from\(new Set\(noteTags\.map\(\(nt\) => nt\.tagId\)\)\);\n        const selectTargetTag = db\.prepare\([\s\S]*?\n        const insertTag = db\.prepare\(\n          "INSERT INTO tags \(id, userId, workspaceId, name, color\) VALUES \(\?, \?, \?, \?, \?\)",\n        \);/,
  `        const oldNoteIds = sourceNotes.map((n) => n.id);\n        const noteTags = workspaceNotebookTransferRepository.listNoteTags(oldNoteIds);\n        const oldTagIds = Array.from(new Set(noteTags.map((nt) => nt.tagId)));`,
  "tag query setup",
);

regex(
  /          const tagPlaceholders = oldTagIds\.map\(\(\) => "\?"\)\.join\(","\);\n          const tags = db\n            \.prepare\(`SELECT \* FROM tags WHERE id IN \(\$\{tagPlaceholders\}\)`\)\n            \.all\(\.\.\.oldTagIds\) as TagRow\[\];/,
  `          const tags = workspaceNotebookTransferRepository.listTagsByIds<TagRow>(oldTagIds);`,
  "tag list query",
);

exact(
  `            let targetTag = targetWorkspaceId\n              ? (selectTargetTag.get(actorUserId, tag.name, targetWorkspaceId) as TagRow | undefined)\n              : (selectPersonalTargetTag.get(actorUserId, tag.name) as TagRow | undefined);`,
  `            let targetTag = targetWorkspaceId\n              ? workspaceNotebookTransferRepository.findWorkspaceTagByName<TagRow>(\n                  actorUserId,\n                  tag.name,\n                  targetWorkspaceId,\n                )\n              : workspaceNotebookTransferRepository.findPersonalTagByName<TagRow>(\n                  actorUserId,\n                  tag.name,\n                );`,
  "target tag lookup",
);

exact(
  `                insertTag.run(newTagId, actorUserId, targetWorkspaceId, tag.name, tag.color || "#58a6ff");`,
  `                workspaceNotebookTransferRepository.insertTag({\n                  id: newTagId,\n                  userId: actorUserId,\n                  workspaceId: targetWorkspaceId,\n                  name: tag.name,\n                  color: tag.color || "#58a6ff",\n                });`,
  "tag insert",
);
exact(
  `                targetTag = selectAnyTagByName.get(actorUserId, tag.name) as TagRow | undefined;`,
  `                targetTag = workspaceNotebookTransferRepository.findAnyTagByName<TagRow>(\n                  actorUserId,\n                  tag.name,\n                );`,
  "fallback tag lookup",
);

exact(
  `        const insertNoteTag = db.prepare("INSERT OR IGNORE INTO note_tags (noteId, tagId) VALUES (?, ?)");\n        for (const nt of noteTags) {\n          const newNoteId = noteIdMap.get(nt.noteId.toLowerCase());\n          const targetTagId = tagIdMap.get(nt.tagId);\n          if (newNoteId && targetTagId) insertNoteTag.run(newNoteId, targetTagId);\n        }`,
  `        for (const nt of noteTags) {\n          const newNoteId = noteIdMap.get(nt.noteId.toLowerCase());\n          const targetTagId = tagIdMap.get(nt.tagId);\n          if (newNoteId && targetTagId) {\n            workspaceNotebookTransferRepository.insertNoteTag(newNoteId, targetTagId);\n          }\n        }`,
  "note tag inserts",
);

exact(
  `      for (const item of pendingNotes) {\n        if (item.content.indexOf("/api/attachments/") >= 0) {\n          syncAttachmentReferences(db, item.newId, item.content);\n        }\n        syncNoteLinks(db, actorUserId, item.newId, item.content);\n      }`,
  `      for (const item of pendingNotes) {\n        workspaceNotebookTransferRepository.syncDerivedReferences(\n          actorUserId,\n          item.newId,\n          item.content,\n        );\n      }`,
  "derived references",
);

if (/\bgetDb\s*\(|\.prepare\s*\(|\.transaction\s*\(|better-sqlite3/.test(source)) {
  throw new Error("database driver access remains in workspaceNotebookTransfer.ts");
}

fs.writeFileSync(filePath, source);
console.log("Applied workspace notebook transfer database boundary codemod.");
