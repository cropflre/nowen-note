import { readFileSync, writeFileSync } from "node:fs";

function read(path) {
  return readFileSync(path, "utf8");
}

function write(path, content) {
  writeFileSync(path, content, "utf8");
}

function replaceOnce(source, before, after, label) {
  const index = source.indexOf(before);
  if (index < 0) throw new Error(`Missing patch target: ${label}`);
  if (source.indexOf(before, index + before.length) >= 0) {
    throw new Error(`Patch target is not unique: ${label}`);
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

function replaceAllChecked(source, before, after, expected, label) {
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`Expected ${expected} matches for ${label}, found ${count}`);
  return source.split(before).join(after);
}

{
  const path = "frontend/src/components/KnowledgeTreePanel.tsx";
  let source = read(path);

  source = replaceOnce(
    source,
    '  const [pendingFolderOpenId, setPendingFolderOpenId] = useState<string | null>(null);',
    `  const [pendingFolderAction, setPendingFolderAction] = useState<{\n    nodeId: string;\n    action: "select" | "toggle";\n  } | null>(null);`,
    "pending folder action state",
  );

  source = replaceAllChecked(
    source,
    "setPendingFolderOpenId(null)",
    "setPendingFolderAction(null)",
    6,
    "clear pending folder action",
  );

  source = replaceOnce(
    source,
    `  const openDocument = async (node: KnowledgeTreeNode) => {\n    closeMenu();\n    if (node.nodeType === "folder") {\n      if (!isFolderUnlocked(node, unlockedFolderIds)) {\n        setPendingFolderOpenId(node.id);\n        setPasswordDialog({ node, mode: "unlock" });\n        return;\n      }\n      await toggle(node);\n      return;\n    }`,
    `  const selectFolder = useCallback((node: KnowledgeTreeNode) => {\n    if (node.resourceType !== "notebook") return;\n    actions.setSelectedNotebook(node.resourceId);\n    actions.clearSelectedTags();\n    actions.setSearchQuery("");\n    actions.setViewMode("notebook");\n    actions.setMobileView("list");\n    if (variant === "mobile") actions.setMobileSidebar(false);\n  }, [actions, variant]);\n\n  const openDocument = async (node: KnowledgeTreeNode) => {\n    closeMenu();\n    if (node.nodeType === "folder") {\n      if (!isFolderUnlocked(node, unlockedFolderIds)) {\n        setPendingFolderAction({ nodeId: node.id, action: "select" });\n        setPasswordDialog({ node, mode: "unlock" });\n        return;\n      }\n      selectFolder(node);\n      return;\n    }`,
    "folder click selects notebook instead of toggling disclosure",
  );

  source = replaceOnce(
    source,
    `  const toggleDisclosure = async (node: KnowledgeTreeNode) => {\n    closeMenu();\n    if (node.nodeType === "folder" && !isFolderUnlocked(node, unlockedFolderIds)) {\n      setPendingFolderOpenId(node.id);\n      setPasswordDialog({ node, mode: "unlock" });\n      return;\n    }\n    await toggle(node);\n  };`,
    `  const toggleDisclosure = async (node: KnowledgeTreeNode) => {\n    closeMenu();\n    if (node.nodeType === "folder" && !isFolderUnlocked(node, unlockedFolderIds)) {\n      setPendingFolderAction({ nodeId: node.id, action: "toggle" });\n      setPasswordDialog({ node, mode: "unlock" });\n      return;\n    }\n    await toggle(node);\n  };`,
    "locked disclosure action",
  );

  source = replaceOnce(
    source,
    '    const active = node.resourceType === "note" && state.activeNote?.id === node.resourceId;',
    `    const active = (\n      (node.resourceType === "note" && state.activeNote?.id === node.resourceId)\n      || (\n        node.resourceType === "notebook"\n        && state.viewMode === "notebook"\n        && state.selectedNotebookId === node.resourceId\n      )\n    );`,
    "selected folder active state",
  );

  source = replaceOnce(
    source,
    `            onUnlocked={(nodeId, unlockToken) => {\n              setUnlockedFolderIds(rememberUnlockedFolder(nodeId, unlockToken));\n              if (pendingFolderOpenId === nodeId) {\n                setExpanded((current) => new Set(current).add(nodeId));\n                const target = nodes.find((node) => node.id === nodeId);\n                if (target && !target.sharedRootId) {\n                  void knowledgeTreeApi.update(nodeId, { isExpanded: true }).catch(() => undefined);\n                }\n              }\n            }}`,
    `            onUnlocked={(nodeId, unlockToken) => {\n              setUnlockedFolderIds(rememberUnlockedFolder(nodeId, unlockToken));\n              const pendingAction = pendingFolderAction?.nodeId === nodeId\n                ? pendingFolderAction.action\n                : null;\n              setPendingFolderAction(null);\n              const target = nodes.find((node) => node.id === nodeId);\n              if (pendingAction === "select" && target) {\n                selectFolder(target);\n              } else if (pendingAction === "toggle") {\n                setExpanded((current) => new Set(current).add(nodeId));\n                if (target && !target.sharedRootId) {\n                  void knowledgeTreeApi.update(nodeId, { isExpanded: true }).catch(() => undefined);\n                }\n              }\n            }}`,
    "unlock resumes selection or disclosure intent",
  );

  if (source.includes("pendingFolderOpenId") || source.includes("setPendingFolderOpenId")) {
    throw new Error("Legacy pendingFolderOpenId references remain");
  }
  write(path, source);
}

{
  const path = "frontend/src/components/NoteList.tsx";
  let source = read(path);
  source = replaceOnce(
    source,
    '        const params: Record<string, string> = { notebookId: state.selectedNotebookId, ...sortParams };',
    '        const params: Record<string, string> = { notebookId: state.selectedNotebookId, includeDescendants: "0", ...sortParams };',
    "direct notebook list fetch",
  );
  source = replaceOnce(
    source,
    '        return api.getNotes({ notebookId: state.selectedNotebookId, ...sortParams });',
    '        return api.getNotes({ notebookId: state.selectedNotebookId, includeDescendants: "0", ...sortParams });',
    "direct notebook calendar fetch",
  );
  write(path, source);
}

{
  const path = "backend/src/routes/notes.ts";
  let source = read(path);
  source = replaceOnce(
    source,
    'import { buildFtsSearchTerm } from "../lib/searchQuery";',
    'import { buildFtsSearchTerm } from "../lib/searchQuery";\nimport { resolveNotebookNoteScopeIds } from "../lib/notebookNoteScope";',
    "notebook scope helper import",
  );
  source = replaceOnce(
    source,
    '  const notebookId = c.req.query("notebookId");',
    '  const notebookId = c.req.query("notebookId");\n  // 三栏式目录默认传 0：只显示当前文件夹直属笔记；未传时保持历史递归行为。\n  const includeDescendants = c.req.query("includeDescendants") !== "0";',
    "include descendants query parameter",
  );
  source = replaceOnce(
    source,
    `  } else if (notebookId) {\n    // 递归收集 notebookId 自身 + 全部后代笔记本，使笔记列表能展示子笔记本下的笔记\n    // 用 SQLite 的递归 CTE：从给定 id 出发沿 parentId 反向向下展开\n    const descendantRows = db.prepare(\`\n      WITH RECURSIVE descendants(id) AS (\n        SELECT id FROM notebooks WHERE id = ?\n        UNION ALL\n        SELECT n.id FROM notebooks n\n        INNER JOIN descendants d ON n.parentId = d.id\n      )\n      SELECT id FROM descendants\n    \`).all(notebookId) as { id: string }[];\n    const ids = descendantRows.map((r) => r.id);\n    if (ids.length === 0) {\n      // 给的 notebookId 不存在 → 直接返回空，避免 IN () 语法错误\n      return c.json([]);\n    }\n    const placeholders = ids.map(() => "?").join(",");\n    query += \` AND notes.notebookId IN (\${placeholders}) AND notes.isTrashed = 0\`;\n    params.push(...ids);`,
    `  } else if (notebookId) {\n    const ids = resolveNotebookNoteScopeIds(db, notebookId, includeDescendants);\n    if (ids.length === 0) {\n      // 给的 notebookId 不存在 → 直接返回空，避免 IN () 语法错误\n      return c.json([]);\n    }\n    const placeholders = ids.map(() => "?").join(",");\n    query += \` AND notes.notebookId IN (\${placeholders}) AND notes.isTrashed = 0\`;\n    params.push(...ids);`,
    "notebook direct or recursive scope",
  );
  write(path, source);
}

write(
  "backend/src/lib/notebookNoteScope.ts",
  `import type Database from "better-sqlite3";\n\n/**\n * Resolve the notebook IDs used by the note-list query.\n *\n * Three-column folder navigation requests direct children only, while legacy\n * callers can retain the historical recursive subtree behavior. Keeping this\n * decision server-side prevents every client from downloading descendants and\n * filtering them locally.\n */\nexport function resolveNotebookNoteScopeIds(\n  db: Database.Database,\n  notebookId: string,\n  includeDescendants: boolean,\n): string[] {\n  if (!includeDescendants) {\n    const exists = db.prepare("SELECT id FROM notebooks WHERE id = ?").get(notebookId) as\n      | { id: string }\n      | undefined;\n    return exists ? [exists.id] : [];\n  }\n\n  const rows = db.prepare(\`\n    WITH RECURSIVE descendants(id) AS (\n      SELECT id FROM notebooks WHERE id = ?\n      UNION ALL\n      SELECT n.id FROM notebooks n\n      INNER JOIN descendants d ON n.parentId = d.id\n    )\n    SELECT id FROM descendants\n  \`).all(notebookId) as Array<{ id: string }>;\n\n  return rows.map((row) => row.id);\n}\n`,
);

write(
  "backend/tests/notebook-note-scope.test.ts",
  `import assert from "node:assert/strict";\nimport test from "node:test";\nimport Database from "better-sqlite3";\nimport { resolveNotebookNoteScopeIds } from "../src/lib/notebookNoteScope";\n\ntest("notebook note scope separates direct folder contents from recursive subtree contents", () => {\n  const db = new Database(":memory:");\n  db.exec(\`\n    CREATE TABLE notebooks (\n      id TEXT PRIMARY KEY,\n      parentId TEXT\n    );\n    INSERT INTO notebooks (id, parentId) VALUES\n      ('root', NULL),\n      ('child-a', 'root'),\n      ('child-b', 'root'),\n      ('grandchild', 'child-a'),\n      ('other', NULL);\n  \`);\n\n  assert.deepEqual(resolveNotebookNoteScopeIds(db, "root", false), ["root"]);\n  assert.deepEqual(\n    new Set(resolveNotebookNoteScopeIds(db, "root", true)),\n    new Set(["root", "child-a", "child-b", "grandchild"]),\n  );\n  assert.deepEqual(resolveNotebookNoteScopeIds(db, "missing", false), []);\n  assert.deepEqual(resolveNotebookNoteScopeIds(db, "missing", true), []);\n  db.close();\n});\n`,
);

{
  const path = "frontend/src/lib/__tests__/knowledgeTreeSidebarContract.test.ts";
  let source = read(path);
  source = replaceOnce(
    source,
    `  it("keeps pinned and favorite note states visible beside the tree title", () => {`,
    `  it("separates folder selection from the disclosure arrow in three-column navigation", () => {\n    const panel = source("../../components/KnowledgeTreePanel.tsx");\n    const noteList = source("../../components/NoteList.tsx");\n\n    expect(panel).toContain('action: "select" | "toggle"');\n    expect(panel).toContain('setPendingFolderAction({ nodeId: node.id, action: "select" })');\n    expect(panel).toContain('setPendingFolderAction({ nodeId: node.id, action: "toggle" })');\n    expect(panel).toContain("actions.setSelectedNotebook(node.resourceId)");\n    expect(panel).toContain('actions.setViewMode("notebook")');\n    expect(panel).toContain("selectFolder(node)");\n    expect(panel).toContain("state.selectedNotebookId === node.resourceId");\n    expect(panel).toContain("onClick={() => hasChildren && void toggleDisclosure(node)}");\n    expect(noteList).toContain('includeDescendants: "0"');\n  });\n\n  it("keeps pinned and favorite note states visible beside the tree title", () => {`,
    "three-column folder selection contract test",
  );
  write(path, source);
}

console.log("Applied three-column folder selection patch.");
