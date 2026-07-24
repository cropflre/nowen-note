# M7 Subdocument 代际与安全窗口化实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为章节 Subdocument 增加可验证的代际协议、结构重分段和跨章节安全回退，使实验窗口化在离线、并发和结构变化下不丢文。

**架构：** 服务端以 manifest generation 拒绝旧章节更新，结构变化时原子重建章节；前端 pending 队列绑定 generation。跨章节复杂操作不跨多个 ProseMirror 实例执行，而是携带最新物化快照切换单体编辑器。

**技术栈：** TypeScript、Y.js、Hono、React、Tiptap、Vitest、better-sqlite3。

---

## 文件结构

- 创建 `backend/src/db/yjsSubdocumentGenerationMigration.ts`：为 manifest 增加 generation、structureVersion。
- 修改 `backend/src/db/migrations.ts`、`backend/src/db/postgres/schema.base.sql`：注册 SQLite/PostgreSQL schema。
- 修改 `backend/src/services/yjs-subdocuments.ts`：生成清单、校验代际、检测边界变化并重分段。
- 修改 `backend/src/services/yjs.ts`、`backend/src/routes/notes.ts`：传递 generation 和明确冲突响应。
- 修改 `backend/tests/yjs-subdocuments.test.ts`、`backend/tests/yjs-subdocument-route.test.ts`：服务与路由回归。
- 修改 `frontend/src/lib/api.impl.ts`：清单和更新协议携带 generation。
- 修改 `frontend/src/lib/yjsSubdocumentModel.ts`：pending 按 generation 持久化并处理冲突。
- 修改 `frontend/src/components/WindowedTiptapEditor.tsx`：跨章节检测、安全回退和最新值搜索。
- 修改 `frontend/src/components/TiptapEditorRuntime.tsx`：使用回退快照进入单体编辑器。
- 修改对应 Vitest：协议、离线、选择、拖拽、IME、搜索和回退快照。
- 修改 `frontend/src/lib/editorPerformanceProtocol.ts`：记录 A/B 模式与章节峰值。

### 任务 1：数据库代际迁移

**文件：**
- 创建：`backend/src/db/yjsSubdocumentGenerationMigration.ts`
- 修改：`backend/src/db/migrations.ts`
- 修改：`backend/src/db/postgres/schema.base.sql`

- [ ] **步骤 1：编写失败测试**

在 `backend/tests/yjs-subdocuments.test.ts` 断言迁移后 manifest 包含 `generation=1` 和 `structureVersion=1`。

- [ ] **步骤 2：运行红灯**

运行：`node --import tsx --import ./tests/setup-db-isolation.ts --test tests/yjs-subdocuments.test.ts`

预期：列不存在。

- [ ] **步骤 3：实现迁移**

SQLite v58 使用 `PRAGMA table_info` 后按缺失列执行：

```sql
ALTER TABLE note_y_subdocument_manifests ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE note_y_subdocument_manifests ADD COLUMN structureVersion INTEGER NOT NULL DEFAULT 1;
```

PostgreSQL base schema增加同名 INTEGER 列。

- [ ] **步骤 4：运行绿灯**

运行相同测试，预期通过。

### 任务 2：服务端 generation 与结构重分段

**文件：**
- 修改：`backend/src/services/yjs-subdocuments.ts`
- 修改：`backend/src/services/yjs.ts`
- 修改：`backend/tests/yjs-subdocuments.test.ts`

- [ ] **步骤 1：编写失败测试**

覆盖三种行为：旧 generation 更新抛出 `SUBDOCUMENT_GENERATION_CONFLICT`；只改章节文本 generation 不变；新增 H1 或顶层 Block 后章节重分段且 generation、structureVersion 各递增一次。

- [ ] **步骤 2：运行红灯**

运行：`node --import tsx --import ./tests/setup-db-isolation.ts --test tests/yjs-subdocuments.test.ts`

- [ ] **步骤 3：扩展清单与 apply 签名**

```ts
applyYjsSubdocumentUpdate(db, noteId, sectionId, update, userId, expectedGeneration)
```

事务开始读取 manifest 并比较 generation。更新后用 `splitYjsSubdocumentSections` 比较 section id、start/end；边界未变只更新当前快照，边界变化调用内部重分段写入并递增代际。

- [ ] **步骤 4：保持 GUID**

重分段对具有相同首个稳定 Block ID 的章节复用 GUID；删除旧章节前先构造完整 next rows，再在同一事务替换。替换后删除旧 generation 的 update 日志。

- [ ] **步骤 5：运行绿灯**

运行相同服务测试，预期全部通过。

### 任务 3：路由冲突协议

**文件：**
- 修改：`backend/src/routes/notes.ts`
- 修改：`backend/tests/yjs-subdocument-route.test.ts`

- [ ] **步骤 1：编写失败测试**

POST 请求体加入 `generation`。断言旧 generation 返回 409：

```json
{
  "code": "SUBDOCUMENT_GENERATION_CONFLICT",
  "manifest": { "generation": 2, "structureVersion": 2, "sections": [] }
}
```

- [ ] **步骤 2：运行红灯**

运行：`node --import tsx --import ./tests/setup-db-isolation.ts --test tests/yjs-subdocument-route.test.ts`

- [ ] **步骤 3：实现输入校验和错误映射**

generation 必须是正整数；冲突映射 409，章节不存在映射 404，非法 update 映射 400，大小超限保持 413。

- [ ] **步骤 4：运行绿灯**

运行相同路由测试，预期通过。

### 任务 4：前端 generation pending

**文件：**
- 修改：`frontend/src/lib/api.impl.ts`
- 修改：`frontend/src/lib/yjsSubdocumentModel.ts`
- 修改：`frontend/src/lib/__tests__/apiYjsSubdocuments.test.ts`
- 修改：`frontend/src/lib/__tests__/yjsSubdocumentModel.test.ts`

- [ ] **步骤 1：编写失败测试**

断言 pending JSON 包含 generation；相同 generation 可恢复并 flush；不同 generation 不发送、保留原始 base64，并通过 `onGenerationConflict` 返回最新清单。

- [ ] **步骤 2：运行红灯**

运行：`npx vitest run src/lib/__tests__/apiYjsSubdocuments.test.ts src/lib/__tests__/yjsSubdocumentModel.test.ts`

- [ ] **步骤 3：实现协议**

REST transport `send(sectionId, update, generation)` 返回更新结果或抛出带 manifest 的冲突。localStorage 结构升级为：

```ts
{ version: 2, generation, sections: Record<string, string> }
```

旧 version 1 队列在 generation=1 时兼容读取；其他代际停止自动发送。

- [ ] **步骤 4：运行绿灯**

运行相同测试，预期通过。

### 任务 5：跨章节安全回退与生命周期

**文件：**
- 修改：`frontend/src/components/WindowedTiptapEditor.tsx`
- 修改：`frontend/src/components/TiptapEditorRuntime.tsx`
- 修改：`frontend/src/components/__tests__/WindowedTiptapEditor.test.tsx`
- 修改：`frontend/src/components/__tests__/TiptapBlockPatchRuntime.test.tsx`

- [ ] **步骤 1：编写失败测试**

覆盖：selection anchor/focus 位于不同 section 时调用 `onFallback(reason, snapshot)`；跨章节 drag/drop 同样回退；snapshot 包含当前 valuesRef 而非旧 props；composition 期间 IntersectionObserver 离场不卸载；搜索使用最新已编辑值定位章节。

- [ ] **步骤 2：运行红灯**

运行：`npx vitest run src/components/__tests__/WindowedTiptapEditor.test.tsx src/components/__tests__/TiptapBlockPatchRuntime.test.tsx`

- [ ] **步骤 3：实现安全回退载荷**

`onFallback` 扩展为：

```ts
(reason: string, snapshot?: { content: string; contentText: string }) => void
```

Windowed 先抓取已挂载编辑器，再合并全部章节值。Runtime 保存 snapshot 到 note override state，下一次渲染 BaseTiptapEditor 时使用该内容，并清理窗口化 pending 生命周期。

- [ ] **步骤 4：实现事件检测**

容器监听 `selectionchange`，仅当 anchor/focus 的最近 `[data-windowed-tiptap-section]` 不同才回退。dragstart 记录源 section，drop 到不同 section 时阻止窗口内结构操作并回退。IME 集合继续阻止卸载。

- [ ] **步骤 5：运行绿灯**

运行相同组件测试，预期通过。

### 任务 6：A/B 性能标签

**文件：**
- 修改：`frontend/src/lib/editorPerformanceProtocol.ts`
- 修改：`frontend/src/lib/editorPerformanceHarness.ts`
- 修改：对应性能测试。

- [ ] **步骤 1：编写失败测试**

报告必须包含 `editorMode`、`sectionCount`、`peakMountedSections`，缺失时预算判定 fail closed。

- [ ] **步骤 2：运行红灯**

运行：`npx vitest run src/lib/__tests__/editorPerformanceProtocol.test.ts src/lib/__tests__/editorPerformanceHarness.test.ts`

- [ ] **步骤 3：实现最少字段与采集接口**

collector 增加 `recordEditorWindow(mode, sectionCount, mountedSections)`，harness 从 driver 读取当前编辑器模式与章节计数。

- [ ] **步骤 4：运行绿灯**

运行相同测试，预期通过。

### 任务 7：M7 集成验证

- [ ] **步骤 1：后端定向测试**

运行：`node --import tsx --import ./tests/setup-db-isolation.ts --test tests/yjs-subdocuments.test.ts tests/yjs-subdocument-route.test.ts tests/block-authority-store.test.ts`

- [ ] **步骤 2：前端定向测试**

运行：`npx vitest run src/lib/__tests__/apiYjsSubdocuments.test.ts src/lib/__tests__/yjsSubdocumentModel.test.ts src/components/__tests__/WindowedTiptapEditor.test.tsx src/components/__tests__/TiptapBlockPatchRuntime.test.tsx src/lib/__tests__/editorPerformanceProtocol.test.ts src/lib/__tests__/editorPerformanceHarness.test.ts`

- [ ] **步骤 3：类型与构建**

运行：后端 `npm run build:tsc`；前端 `npm run build`；Android `gradlew.bat :app:compileDebugJavaWithJavac --console=plain`。

- [ ] **步骤 4：差异审计**

运行：`git diff --check`，确认 `.superpowers/` 未进入 staged files。
