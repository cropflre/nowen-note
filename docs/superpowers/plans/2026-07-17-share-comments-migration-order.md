# Share Comments 旧库升级崩溃修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复旧数据库因 `share_comments.sourceType` 尚未迁移却被提前用于建索引而无法启动的问题。

**架构：** 保持 `initSchema` 负责新库基线、版本化迁移负责旧库增量的现有边界。删除基线 SQL 中依赖增量字段的索引创建，让 v50 迁移先幂等补列再创建索引；用真实临时 SQLite 文件覆盖完整 `getDb()` 初始化路径。

**技术栈：** TypeScript、Node.js Test Runner、better-sqlite3、tsx

---

## 文件结构

- 创建：`backend/tests/share-comments-schema-migration.test.ts`，复现 1.3.1 旧表结构并验证完整升级结果。
- 修改：`backend/src/db/schema.ts`，移除过早创建的 `idx_share_comments_source`，说明索引由 v50 迁移负责。

### 任务 1：建立旧库升级回归测试

**文件：**
- 创建：`backend/tests/share-comments-schema-migration.test.ts`

- [ ] **步骤 1：编写失败的测试**

```typescript
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-share-comments-migration-"));
const dbPath = path.join(tmpDir, "legacy.db");

process.env.DB_PATH = dbPath;
process.env.ELECTRON_USER_DATA = tmpDir;

const legacyDb = new Database(dbPath);
legacyDb.exec(`
  CREATE TABLE share_comments (
    id TEXT PRIMARY KEY,
    noteId TEXT NOT NULL,
    userId TEXT,
    guestName TEXT,
    guestIpHash TEXT,
    parentId TEXT,
    content TEXT NOT NULL,
    anchorData TEXT,
    isResolved INTEGER DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO share_comments (id, noteId, content)
  VALUES ('legacy-comment', 'legacy-note', '旧评论');
`);
legacyDb.close();

let closeDb: typeof import("../src/db/schema").closeDb;

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("getDb upgrades legacy share_comments before creating the source index", async () => {
  const schema = await import("../src/db/schema");
  closeDb = schema.closeDb;

  const db = schema.getDb();
  const columns = db.prepare("PRAGMA table_info(share_comments)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  assert.ok(columnNames.has("sourceType"));
  assert.ok(columnNames.has("sourceId"));
  assert.ok(columnNames.has("isHidden"));

  const index = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_share_comments_source'",
  ).get() as { name: string } | undefined;
  assert.equal(index?.name, "idx_share_comments_source");

  const legacyComment = db.prepare(
    "SELECT id, content, sourceType FROM share_comments WHERE id = ?",
  ).get("legacy-comment");
  assert.deepEqual(legacyComment, {
    id: "legacy-comment",
    content: "旧评论",
    sourceType: "note_share",
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
cd backend
node --import tsx --test tests/share-comments-schema-migration.test.ts
```

预期：FAIL，`getDb()` 抛出 `SqliteError: no such column: sourceType`。

### 任务 2：实施最小迁移顺序修复

**文件：**
- 修改：`backend/src/db/schema.ts:419`
- 测试：`backend/tests/share-comments-schema-migration.test.ts`

- [ ] **步骤 1：移除提前创建索引并记录职责**

将 `CREATE INDEX IF NOT EXISTS idx_share_comments_source ...` 替换为中文注释：

```sql
-- 注意：idx_share_comments_source 不在这里建。
-- 老库的 share_comments 表缺少 sourceType/sourceId，索引必须由 v50 迁移
-- 在补齐字段后创建，否则 initSchema 会先于 runMigrations 抛错。
```

- [ ] **步骤 2：运行新增测试验证通过**

运行：

```bash
cd backend
node --import tsx --test tests/share-comments-schema-migration.test.ts
```

预期：PASS；旧评论保留，三个新字段和索引均存在。

- [ ] **步骤 3：运行迁移相关测试**

运行：

```bash
cd backend
node --import tsx --test \
  tests/share-comments-schema-migration.test.ts \
  tests/notebook-members-migration.test.ts \
  tests/notebook-share-links-migration.test.ts \
  tests/tasks-completed-at-migration.test.ts \
  tests/user-ai-settings-migration.test.ts
```

预期：全部 PASS。

- [ ] **步骤 4：运行后端完整测试**

运行：

```bash
cd backend
npm test
```

预期：全部 PASS，无新增错误。

- [ ] **步骤 5：提交实现**

```bash
git add backend/src/db/schema.ts backend/tests/share-comments-schema-migration.test.ts \
  docs/superpowers/plans/2026-07-17-share-comments-migration-order.md
git commit -m "fix(db): migrate share comment source fields before indexing"
```

