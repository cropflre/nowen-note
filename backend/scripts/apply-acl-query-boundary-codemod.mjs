import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.resolve(here, "../src/middleware/acl.ts");
let source = fs.readFileSync(filePath, "utf8");

function replaceExact(from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`acl.ts: missing expected fragment: ${label}`);
  }
  source = source.replace(from, to);
}

replaceExact(
  'import { getDb } from "../db/schema";\n',
  "",
  "database import",
);

replaceExact(
  'import { noteAclRepository, workspaceMembersRepository } from "../repositories";',
  `import {
  aclQueryRepository,
  noteAclRepository,
  workspaceMembersRepository,
} from "../repositories";`,
  "repository imports",
);

replaceExact(
  `  const db = getDb();
  const note = db
    .prepare("SELECT userId, workspaceId FROM notes WHERE id = ?")
    .get(noteId) as { userId: string; workspaceId: string | null } | undefined;`,
  `  const note = aclQueryRepository.getNoteOwnerScope(noteId);`,
  "note owner scope query",
);

replaceExact(
  `  const db = getDb();
  const nb = db
    .prepare("SELECT userId, workspaceId FROM notebooks WHERE id = ?")
    .get(notebookId) as { userId: string; workspaceId: string | null } | undefined;`,
  `  const nb = aclQueryRepository.getNotebookOwnerScope(notebookId);`,
  "notebook owner scope query",
);

replaceExact(
  ` * SQL WHERE 片段：筛选出用户可见的笔记/笔记本
 * 用法：
 *   const { where, params } = buildVisibilityWhere(userId, 'notes');
 *   db.prepare(\`SELECT * FROM notes \${where}\`).all(...params);`,
  ` * SQL WHERE 片段：筛选出用户可见的笔记/笔记本。
 * 调用方把返回的 where / params 交给对应 Repository 执行。`,
  "visibility documentation",
);

replaceExact(
  `  const db = getDb();
  const row = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role?: string } | undefined;
  return row?.role === "admin";`,
  `  return aclQueryRepository.getSystemRole(userId)?.role === "admin";`,
  "system admin query",
);

replaceExact(
  `  const db = getDb();
  const row = db
    .prepare("SELECT enabledFeatures FROM workspaces WHERE id = ?")
    .get(workspaceId) as { enabledFeatures?: string } | undefined;`,
  `  const row = aclQueryRepository.getWorkspaceFeatures(workspaceId);`,
  "workspace feature query",
);

fs.writeFileSync(filePath, source);
console.log("Applied ACL query boundary codemod.");
