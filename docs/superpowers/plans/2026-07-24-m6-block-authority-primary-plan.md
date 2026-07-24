# M6 Block 权威灰度主读实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在默认 shadow 模式保持旧客户端兼容，并提供可显式开启、可回退的 Block primary 读取与跨库持久化边界。

**架构：** 模式解析与权威内容选择保持纯函数；SQLite 同步 store 继续承担当前运行时原子写入，DatabaseAdapter Repository 增加跨库原子替换能力。所有既有写入口保留同事务 Block 重建，恢复/导入路径增加显式健康同步。

**技术栈：** TypeScript、Hono、better-sqlite3、DatabaseAdapter、Node test runner。

---

## 文件结构

- 创建 `backend/src/lib/blockAuthorityMode.ts`：解析灰度模式并选择返回来源。
- 创建 `backend/tests/block-authority-mode.test.ts`：覆盖 shadow、primary、未知值和 mismatch。
- 修改 `backend/src/lib/blockAuthorityStore.ts`：导出可供跨库 Repository 使用的权威快照类型和历史语义。
- 修改 `backend/src/repositories/blockAuthorityRepository.ts`：增加原子替换文档、记录、附件引用和操作历史的方法。
- 修改 `backend/tests/block-authority-repository.test.ts`：验证跨库 SQL、事务语句和字符串载荷。
- 修改 `backend/src/routes/notes.ts`：按模式选择读取来源，保持读修复限制。
- 修改 `backend/src/services/nowenPackageImportV2.ts`、`backend/src/services/nowenRoundTripSync.ts`：导入完成后同步 Block 健康状态。
- 创建 `backend/src/services/blockAuthorityRecovery.ts`：批量健康同步的单一入口。
- 创建 `backend/tests/block-authority-recovery.test.ts`：覆盖恢复成功和 mismatch 保留。

### 任务 1：灰度模式与读取选择

**文件：**
- 创建：`backend/src/lib/blockAuthorityMode.ts`
- 创建：`backend/tests/block-authority-mode.test.ts`
- 修改：`backend/src/routes/notes.ts`

- [ ] **步骤 1：编写失败测试**

```ts
test("shadow 始终返回兼容快照，primary 只采用健康 Block", () => {
  assert.equal(resolveBlockAuthorityMode("primary"), "primary");
  assert.equal(selectBlockAuthorityRead("shadow", healthy, "snapshot").content, "snapshot");
  assert.equal(selectBlockAuthorityRead("primary", healthy, "snapshot").content, "blocks");
  assert.equal(selectBlockAuthorityRead("primary", mismatch, "snapshot").content, "snapshot");
});
```

- [ ] **步骤 2：运行红灯**

运行：`node --import tsx --test tests/block-authority-mode.test.ts`

预期：因 `blockAuthorityMode` 模块不存在而失败。

- [ ] **步骤 3：实现最少模式选择**

```ts
export type BlockAuthorityMode = "shadow" | "primary";

export function resolveBlockAuthorityMode(value = process.env.NOWEN_BLOCK_AUTHORITY_MODE): BlockAuthorityMode {
  return value === "primary" ? "primary" : "shadow";
}
```

`selectBlockAuthorityRead` 在 shadow 返回 `notesContent`，在 primary 且权威状态健康时返回 Block 内容，否则返回兼容快照并保留原状态。

- [ ] **步骤 4：接入单笔记 GET**

`backend/src/routes/notes.ts` 继续调用 `readAuthoritativeNoteContent` 完成校验，再调用 `selectBlockAuthorityRead` 决定实际返回内容。只在状态 `missing` 时允许 read-repair；`mismatch` 不自动重建。

- [ ] **步骤 5：运行绿灯**

运行：`node --import tsx --import ./tests/setup-db-isolation.ts --test tests/block-authority-mode.test.ts tests/block-authority-store.test.ts`

预期：全部通过。

### 任务 2：跨库原子替换 Repository

**文件：**
- 修改：`backend/src/repositories/blockAuthorityRepository.ts`
- 修改：`backend/tests/block-authority-repository.test.ts`

- [ ] **步骤 1：编写失败测试**

使用记录型 `DatabaseAdapter` 调用：

```ts
await repository.replaceAuthorityState({
  document,
  records: [record],
  attachmentRefs: [{ noteId, blockId, attachmentId }],
  operation,
});
```

断言只调用一次 `executeStatements`，语句顺序为删除旧引用、删除旧记录、插入记录、插入引用、upsert 文档、插入历史；所有 JSON 字段参数保持字符串。

- [ ] **步骤 2：运行红灯**

运行：`node --import tsx --test tests/block-authority-repository.test.ts`

预期：`replaceAuthorityState` 不存在。

- [ ] **步骤 3：实现 DTO 与原子方法**

新增 `BlockAuthorityWriteState`，将全部 SQL 交给 `adapter.executeStatements`。使用共同 SQL：

```sql
INSERT INTO note_block_documents (...) VALUES (?, ...)
ON CONFLICT(noteId) DO UPDATE SET contentFormat = excluded.contentFormat, ...
```

时间戳由 DTO 的 ISO 字符串传入；不使用数据库方言时间函数。历史存在 `operationId` 时仍依赖唯一索引幂等，无 `operationId` 时每次写入。

- [ ] **步骤 4：运行绿灯与 PostgreSQL schema 检查**

运行：`node --import tsx --test tests/block-authority-repository.test.ts tests/block-authority-postgres-schema.test.ts`

预期：全部通过。

### 任务 3：恢复与导入健康同步

**文件：**
- 创建：`backend/src/services/blockAuthorityRecovery.ts`
- 创建：`backend/tests/block-authority-recovery.test.ts`
- 修改：`backend/src/services/nowenPackageImportV2.ts`
- 修改：`backend/src/services/nowenRoundTripSync.ts`

- [ ] **步骤 1：编写失败测试**

建立两个笔记：合法 Tiptap 与损坏 Markdown。调用 `synchronizeRecoveredBlockAuthority(db, noteIds)`，断言合法笔记为 healthy，失败笔记保留 `notes.content` 并进入 failures，不覆盖正文。

- [ ] **步骤 2：运行红灯**

运行：`node --import tsx --import ./tests/setup-db-isolation.ts --test tests/block-authority-recovery.test.ts`

预期：恢复服务不存在。

- [ ] **步骤 3：实现受控恢复**

逐笔记事务执行 `syncNoteBlocks` 和 `rebuildBlockAuthorityStore`，`operationType` 使用 `recovery-sync`。单笔失败调用 `markBlockAuthorityMismatch`；失败不能中止其他笔记，也不能修改原始正文。

- [ ] **步骤 4：接入导入完成点**

两个导入服务在笔记与附件事务完成后，把实际导入的 note IDs 交给恢复服务；警告进入现有 warnings/errors 结构，不把可回退的 shadow 失败升级成整批导入失败。

- [ ] **步骤 5：运行绿灯**

运行：`node --import tsx --import ./tests/setup-db-isolation.ts --test tests/block-authority-recovery.test.ts tests/block-authority-store.test.ts`

预期：全部通过。

### 任务 4：M6 集成验证

- [ ] **步骤 1：运行 M6 定向测试**

```powershell
node --import tsx --import ./tests/setup-db-isolation.ts --test tests/block-authority-mode.test.ts tests/block-authority-store.test.ts tests/block-authority-repository.test.ts tests/block-authority-recovery.test.ts tests/block-history-route.test.ts
```

- [ ] **步骤 2：运行后端类型检查**

运行：`npm run build:tsc`

- [ ] **步骤 3：检查差异**

运行：`git diff --check`

