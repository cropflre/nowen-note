# 删除任务后排除统计动态实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删除任务后，从最近动态、任务记录、趋势和热力图使用的统一活动接口中排除该任务，同时保留底层历史流水。

**架构：** 在后端任务活动接口的 SQL 源头增加有效任务存在性过滤。新增路由级回归测试同时验证“流水仍保留”和“接口不返回已删除任务”，前端继续消费同一接口，无需组件级分支逻辑。

**技术栈：** TypeScript、Hono、better-sqlite3、Node.js Test Runner、React/Vite 构建

---

## 文件结构

- 创建：`backend/tests/task-activity-events-route.test.ts`，通过真实 Hono 路由与临时 SQLite 数据库复现删除后动态残留。
- 修改：`backend/src/runtime/task-stats-hardening.ts`，为活动查询添加任务存在性过滤并限定 SQL 字段别名。

### 任务 1：用路由回归测试复现已删除任务动态残留

**文件：**
- 创建：`backend/tests/task-activity-events-route.test.ts`

- [ ] **步骤 1：编写失败的路由测试**

创建以下测试。它先安装真实统计路由和活动触发器，再插入一个保留任务与一个待删除任务，删除后验证底层流水仍存在，最后断言接口只返回保留任务：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-task-activity-route-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let app: Hono;
let getDb: () => Database.Database;
let closeDb: () => void;

test.before(async () => {
  const [statsModule, schemaModule] = await Promise.all([
    import("../src/runtime/task-stats-hardening"),
    import("../src/db/schema"),
  ]);
  app = new Hono();
  statsModule.installTaskStatsRoutes(app);
  statsModule.ensureTaskStatsSchema();
  getDb = schemaModule.getDb;
  closeDb = schemaModule.closeDb;

  const db = getDb();
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run("activity-user", "activity-user", "hash");
  db.prepare("INSERT INTO tasks (id, userId, title, createdAt) VALUES (?, ?, ?, ?)")
    .run("task-live", "activity-user", "保留任务", "2026-07-15 08:00:00");
  db.prepare("INSERT INTO tasks (id, userId, title, createdAt) VALUES (?, ?, ?, ?)")
    .run("task-deleted", "activity-user", "已删除任务", "2026-07-15 09:00:00");
  db.prepare("DELETE FROM tasks WHERE id = ?").run("task-deleted");
});

test.after(async () => {
  closeDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (error?.code !== "EBUSY" || attempt === 4) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

test("activity API excludes deleted tasks while preserving the ledger", async () => {
  const db = getDb();
  const deletedLedgerCount = db.prepare(
    "SELECT COUNT(*) AS count FROM task_activity_events WHERE taskId = ?",
  ).get("task-deleted") as { count: number };
  assert.equal(deletedLedgerCount.count, 1);

  const response = await app.request(
    "/stats/activity-events?workspaceId=personal&from=2026-07-01&to=2026-07-31",
    { headers: { "X-User-Id": "activity-user" } },
  );

  assert.equal(response.status, 200);
  const events = await response.json() as Array<{ taskId: string }>;
  assert.deepEqual(events.map((event) => event.taskId), ["task-live"]);
});
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：

```powershell
cd backend
node --import tsx --test tests/task-activity-events-route.test.ts
```

预期：测试在最终 `deepEqual` 失败，实际结果同时包含 `task-deleted` 与 `task-live`；底层流水数量断言通过，证明失败来自接口未过滤，而不是触发器未写入。

### 任务 2：在统一活动接口过滤已删除任务

**文件：**
- 修改：`backend/src/runtime/task-stats-hardening.ts:160-202`
- 测试：`backend/tests/task-activity-events-route.test.ts`
- 测试：`backend/tests/task-activity-events.test.ts`

- [ ] **步骤 1：为活动查询添加表别名和任务存在性条件**

将活动查询的条件构造改为：

```ts
const where: string[] = [
  "EXISTS (SELECT 1 FROM tasks AS live_task WHERE live_task.id = e.taskId)",
];
const params: unknown[] = [];
if (scope.kind === "workspace") {
  where.push("e.workspaceId = ?");
  params.push(scope.workspaceId);
} else {
  where.push("e.userId = ?", "e.workspaceId IS NULL");
  params.push(userId);
}
if (from) {
  where.push("e.occurredAt >= ?");
  params.push(`${from}T00:00:00.000Z`);
}
if (to) {
  where.push("e.occurredAt <= ?");
  params.push(`${to}T23:59:59.999Z`);
}
```

将查询改为限定活动表别名：

```ts
const rows = getDb().prepare(`
  SELECT e.id, e.taskId, e.taskTitle, e.eventType, e.userId, e.workspaceId,
         e.projectId, e.occurredAt, e.createdAt
  FROM task_activity_events AS e
  WHERE ${where.join(" AND ")}
  ORDER BY e.occurredAt DESC, e.createdAt DESC
  LIMIT ?
`).all(...params);
```

- [ ] **步骤 2：运行新测试并确认绿灯**

运行：

```powershell
cd backend
node --import tsx --test tests/task-activity-events-route.test.ts
```

预期：1 个测试通过，接口只返回 `task-live`。

- [ ] **步骤 3：运行现有流水语义测试**

运行：

```powershell
cd backend
node --import tsx --test tests/task-activity-events.test.ts
```

预期：2 个测试通过，其中“删除后底层流水仍保留”的断言保持不变。

- [ ] **步骤 4：提交最小修复**

```powershell
git add backend/src/runtime/task-stats-hardening.ts backend/tests/task-activity-events-route.test.ts
git commit -m "fix(tasks): 排除已删除任务的统计动态"
```

### 任务 3：完成构建与回归验收

**文件：**
- 验证：`backend/src/runtime/task-stats-hardening.ts`
- 验证：`backend/tests/task-activity-events-route.test.ts`

- [ ] **步骤 1：并行运行相关回归测试与后端类型构建**

运行：

```powershell
cd backend
node --import tsx --test tests/task-activity-events-route.test.ts tests/task-activity-events.test.ts
npm run build:tsc
```

预期：3 个测试全部通过，TypeScript 构建退出码为 0。

- [ ] **步骤 2：运行前端生产构建**

运行：

```powershell
cd frontend
npm run build
```

预期：TypeScript 与 Vite 构建退出码为 0；允许现有动态导入和分块体积警告，不允许编译错误。

- [ ] **步骤 3：检查提交范围**

运行：

```powershell
git diff --check HEAD~1..HEAD
git status --short
git log -2 --oneline
```

预期：提交只包含统计活动路由和新增回归测试；工作树无未提交改动。
