# 思源导入性能与进度稳定性实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让思源数据包中的文档只解压解析一次，批量同步知识树，并在设置页以单一稳定卡片展示真实导入阶段。

**架构：** 增强导入器生成内部 `PreparedSiyuanPackage`，沿旧导入包装层传给核心导入器复用 ZIP 条目和 AST；知识树服务提供仅面向新建导入资源的批量同步入口。后台任务通过节流进度回调持久化阶段与计数，前端由 `DataManager` 独占任务进度展示，桥接组件只负责 ZIP 识别。

**技术栈：** TypeScript、Node.js、unzipper、better-sqlite3、React、Vitest、Node Test Runner。

---

## 文件结构

- 修改 `backend/src/services/siyuanPackageImport.ts`：构建并传递已准备数据包，产生扫描和最终处理进度。
- 修改 `backend/src/services/siyuanPackageImportLegacy.ts`：透传内部准备结果与进度回调。
- 修改 `backend/src/services/siyuanPackageImportLegacyCore.ts`：复用 ZIP 条目和 AST，报告转换、持久化阶段，调用批量知识树同步。
- 修改 `backend/src/services/legacyKnowledgeHierarchy.ts`：新增导入专用批量同步入口，缓存目录节点并减少重复读取。
- 修改 `backend/src/services/siyuanImportJobs.ts`：持久化阶段、当前数量和总数量，并节流数据库更新。
- 修改 `frontend/src/lib/api.impl.ts`：扩展现有 `SiyuanImportJob` 类型，保持轮询状态机并向调用方透传阶段计数。
- 修改 `frontend/src/components/DataManager.tsx`：渲染唯一稳定的任务进度卡。
- 修改 `frontend/src/components/SiyuanImportProgressBridge.tsx`：移除后台任务 fetch 监听，仅保留 ZIP 检查。
- 修改 `frontend/src/components/__tests__/SiyuanImportProgressBridge.test.ts`：验证桥接组件不再识别后台任务请求。
- 新增 `frontend/src/components/__tests__/SiyuanImportTaskProgress.test.tsx`：验证进度卡稳定渲染和确定/不确定进度。
- 修改 `backend/tests/siyuan-package-import.test.ts`：覆盖准备结果复用和导入结果完整性。
- 修改 `backend/tests/legacy-knowledge-hierarchy.test.ts`：覆盖批量同步、缓存目录节点、重复节点和回滚行为。
- 新增 `backend/tests/siyuan-import-job-progress.test.ts`：覆盖任务阶段、计数和终态保护。

### 任务 1：单次打开并复用思源文档 AST

**文件：**
- 修改：`backend/src/services/siyuanPackageImport.ts`
- 修改：`backend/src/services/siyuanPackageImportLegacy.ts`
- 修改：`backend/src/services/siyuanPackageImportLegacyCore.ts`
- 测试：`backend/tests/siyuan-package-import.test.ts`

- [ ] **步骤 1：编写失败的单次读取测试**

在现有思源包测试中注入准备结果，并用可计数的 `openArchive`/文档读取函数验证核心导入器不会再次打开 ZIP 或解析 `.sy`：

```ts
test("reuses prepared Siyuan entries and parsed documents", async () => {
  const counters = { open: 0, syBuffer: 0 };
  const result = await importFixtureWithCounters({ counters, documents: 3 });
  assert.equal(result.count, 3);
  assert.equal(counters.open, 1);
  assert.equal(counters.syBuffer, 3);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
node --import tsx --import ./tests/setup-db-isolation.ts --test tests/siyuan-package-import.test.ts
```

预期：FAIL；当前核心导入仍会重新调用 `unzipper.Open.file()` 并读取同一批 `.sy` 条目。

- [ ] **步骤 3：定义内部准备结果和进度接口**

在 `siyuanPackageImportLegacyCore.ts` 导出仅供服务层使用的类型：

```ts
export type SiyuanImportProgress = {
  phase: "scanning" | "converting" | "persisting" | "finalizing";
  message: string;
  current?: number;
  total?: number;
};

export type PreparedSiyuanDocument = {
  id: string;
  path: string;
  title: string;
  updatedAt?: string;
  ast: SiyuanNode;
};

export type PreparedSiyuanPackage = {
  entries: ZipEntryLike[];
  documents: PreparedSiyuanDocument[];
  boxNames: Map<string, string>;
};
```

`ImportParams` 增加内部可选字段：

```ts
preparedPackage?: PreparedSiyuanPackage;
onProgress?: (progress: SiyuanImportProgress) => void;
```

- [ ] **步骤 4：让增强层生成并传递准备结果**

`readPackageMetadata()` 返回安全校验后的 `entries` 和完成别名去重的文档；增强入口将准备结果传给旧包装层：

```ts
const metadata = await readPackageMetadata(zipFilePath, params.onProgress);
const result = await importLegacySiyuanPackage(zipFilePath, {
  ...params,
  contentFormat: forceMarkdown ? "markdown" : params.contentFormat,
  preparedPackage: {
    entries: metadata.entries,
    documents: metadata.documents,
    boxNames: metadata.boxNames,
  },
});
```

核心导入器存在准备结果时直接复用，否则保留当前独立调用兼容路径：

```ts
const entries = params.preparedPackage?.entries ?? await readZipEntries(zipFilePath);
const docs = params.preparedPackage?.documents ?? parseSiyuanDocuments(entries, warnings);
const boxNames = params.preparedPackage?.boxNames ?? readBoxNames(entries, warnings);
```

- [ ] **步骤 5：运行思源包测试验证通过**

运行任务 1 步骤 2 的命令。

预期：相关测试全部 PASS；计数断言为一次打开、每篇 `.sy` 一次读取。

- [ ] **步骤 6：提交任务 1**

```powershell
git add -- backend/src/services/siyuanPackageImport.ts backend/src/services/siyuanPackageImportLegacy.ts backend/src/services/siyuanPackageImportLegacyCore.ts backend/tests/siyuan-package-import.test.ts
git commit -m "perf(思源导入): 复用数据包解析结果"
```

### 任务 2：批量同步导入知识树

**文件：**
- 修改：`backend/src/services/legacyKnowledgeHierarchy.ts`
- 修改：`backend/src/services/siyuanPackageImportLegacyCore.ts`
- 测试：`backend/tests/legacy-knowledge-hierarchy.test.ts`
- 测试：`backend/tests/siyuan-package-import.test.ts`

- [ ] **步骤 1：编写失败的批量同步测试**

关闭测试数据库中的旧同步触发器，创建一个多级目录和多篇同目录笔记，调用新入口并验证节点：

```ts
const result = synchronizeLegacyImportHierarchy({
  db,
  notebookIds: [rootId, childId],
  noteIds: [noteA, noteB, noteC],
  actorUserId: userId,
});
assert.equal(result.notebooks, 2);
assert.equal(result.notes, 3);
assert.equal(readResourceNodes("note", noteA).length, 1);
assert.equal(readResourceNodes("note", noteB)[0].parentId, `notebook:${childId}`);
```

再传入不存在的笔记 ID，确认函数抛错且外围事务回滚。

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
node --import tsx --import ./tests/setup-db-isolation.ts --test tests/legacy-knowledge-hierarchy.test.ts
```

预期：FAIL；`synchronizeLegacyImportHierarchy` 尚未导出。

- [ ] **步骤 3：实现缓存目录节点的批量入口**

新增：

```ts
export function synchronizeLegacyImportHierarchy(input: {
  db: Database.Database;
  notebookIds: string[];
  noteIds: string[];
  actorUserId: string;
}): { notebooks: number; notes: number };
```

实现要求：

- `ensureKnowledgeTreeStorage()` 只调用一次；
- `ensureNotebookNode()` 接受本次调用级别的 `Map<string, KnowledgeNodeRow>` 缓存；
- 笔记按 400 条分批读取，并把已读取的 `NoteRow` 与缓存的笔记本节点传给节点确保逻辑；
- 使用确定性节点 ID，保留唯一节点校验、父级 scope 校验和 `create` 历史；
- 返回实际同步的目录和笔记数量。

- [ ] **步骤 4：导入器改用批量入口**

删除事务内逐篇调用 `synchronizeLegacyNotebookHierarchy()` 与 `synchronizeLegacyNoteHierarchy()` 的路径。笔记和目录写入完成后，在同一事务中调用：

```ts
synchronizeLegacyImportHierarchy({
  db,
  notebookIds: Array.from(createdNotebookIds),
  noteIds: importedNotes.map((note) => note.id),
  actorUserId: params.userId,
});
```

现有批量可见性 SQL 保持为提交前最后一道校验。

- [ ] **步骤 5：运行知识树和思源导入测试**

运行：

```powershell
node --import tsx --import ./tests/setup-db-isolation.ts --test tests/legacy-knowledge-hierarchy.test.ts tests/siyuan-package-import.test.ts
```

预期：全部 PASS，无重复节点，触发器关闭时仍可见。

- [ ] **步骤 6：提交任务 2**

```powershell
git add -- backend/src/services/legacyKnowledgeHierarchy.ts backend/src/services/siyuanPackageImportLegacyCore.ts backend/tests/legacy-knowledge-hierarchy.test.ts backend/tests/siyuan-package-import.test.ts
git commit -m "perf(知识树): 批量同步思源导入节点"
```

### 任务 3：持久化真实任务阶段和计数

**文件：**
- 修改：`backend/src/services/siyuanImportJobs.ts`
- 修改：`backend/src/services/siyuanPackageImport.ts`
- 修改：`backend/src/services/siyuanPackageImportLegacy.ts`
- 修改：`backend/src/services/siyuanPackageImportLegacyCore.ts`
- 新增：`backend/tests/siyuan-import-job-progress.test.ts`

- [ ] **步骤 1：编写失败的任务阶段测试**

测试幂等补列、快照计数和终态保护：

```ts
assert.deepEqual(progressSnapshots.map((item) => item.phase), [
  "scanning",
  "converting",
  "persisting",
  "finalizing",
  "completed",
]);
assert.equal(progressSnapshots.at(-2)?.progressCurrent, 3);
assert.equal(progressSnapshots.at(-2)?.progressTotal, 3);
```

完成任务后再次调用进度写入，断言状态仍为 `completed`。

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
node --import tsx --import ./tests/setup-db-isolation.ts --test tests/siyuan-import-job-progress.test.ts
```

预期：FAIL；任务快照尚无进度计数且导入器没有阶段回调。

- [ ] **步骤 3：扩展任务表和快照**

新建表 SQL 加入：

```sql
progressCurrent INTEGER,
progressTotal INTEGER,
```

`ensureSchema()` 通过 `PRAGMA table_info(siyuan_import_jobs)` 幂等补列。`SiyuanImportJobSnapshot` 增加：

```ts
progressCurrent: number | null;
progressTotal: number | null;
```

- [ ] **步骤 4：实现节流进度写入**

在 `processJob()` 中创建仅允许更新当前 `running` 任务的写入器：

```ts
const reportProgress = createThrottledProgressReporter({
  jobId,
  minIntervalMs: 500,
  write(progress) {
    db.prepare(`UPDATE siyuan_import_jobs
      SET phase = ?, message = ?, progressCurrent = ?, progressTotal = ?, updatedAt = datetime('now')
      WHERE id = ? AND status = 'running'`).run(/* 对应值 */);
  },
});
```

阶段变化立即写入；同一阶段计数更新最多每 500ms 一次；导入返回前 flush；完成或失败后 dispose，禁止晚到回调覆盖终态。

- [ ] **步骤 5：在导入链路报告阶段**

- 元数据开始：`scanning`；
- 每完成一篇文档转换：`converting`，`current/total` 单调递增；
- 事务写入前：`persisting`；
- 富文本增强、远程图片和元数据应用前：`finalizing`。

- [ ] **步骤 6：运行任务进度与现有导入测试**

运行：

```powershell
node --import tsx --import ./tests/setup-db-isolation.ts --test tests/siyuan-import-job-progress.test.ts tests/siyuan-package-import.test.ts tests/siyuan-package-tiptap-fidelity.test.ts
```

预期：全部 PASS，阶段顺序正确且终态不会被覆盖。

- [ ] **步骤 7：提交任务 3**

```powershell
git add -- backend/src/services/siyuanImportJobs.ts backend/src/services/siyuanPackageImport.ts backend/src/services/siyuanPackageImportLegacy.ts backend/src/services/siyuanPackageImportLegacyCore.ts backend/tests/siyuan-import-job-progress.test.ts
git commit -m "feat(思源导入): 展示真实后台处理阶段"
```

### 任务 4：统一前端进度状态源并消除跳动

**文件：**
- 修改：`frontend/src/components/DataManager.tsx`
- 修改：`frontend/src/components/SiyuanImportProgressBridge.tsx`
- 修改：`frontend/src/components/__tests__/SiyuanImportProgressBridge.test.ts`
- 新增：`frontend/src/components/__tests__/SiyuanImportTaskProgress.test.tsx`
- 修改：`frontend/src/lib/api.impl.ts`

- [ ] **步骤 1：编写失败的单卡进度测试**

将任务卡提取为 `SiyuanImportTaskProgress`，测试连续 rerender：

```tsx
const view = render(<SiyuanImportTaskProgress job={scanningJob} />);
view.rerender(<SiyuanImportTaskProgress job={convertingJob} />);
expect(screen.getAllByRole("status")).toHaveLength(1);
expect(screen.getByText("12 / 30")).toBeInTheDocument();
```

测试没有总数时只显示一个不确定进度条，完成后显示 100%。

- [ ] **步骤 2：运行测试验证失败**

运行：

```powershell
npm run test:run -- src/components/__tests__/SiyuanImportTaskProgress.test.tsx src/components/__tests__/SiyuanImportProgressBridge.test.ts
```

工作目录：`frontend`

预期：FAIL；任务卡尚未提取，桥接组件仍接管后台 fetch。

- [ ] **步骤 3：实现稳定任务卡**

创建同文件导出组件或小型专用组件，固定外层节点，不给阶段更新分配新 key：

```tsx
export function SiyuanImportTaskProgress({ job }: { job: SiyuanImportJob }) {
  const determinate = Number.isFinite(job.progressTotal) && Number(job.progressTotal) > 0;
  const percent = determinate
    ? Math.min(100, Math.round((Number(job.progressCurrent) / Number(job.progressTotal)) * 100))
    : null;
  return <div role="status">{/* 稳定卡片、阶段文案和单一进度条 */}</div>;
}
```

`DataManager` 的 `onProgress` 保存完整任务快照，而不是映射成永远为 `0/1` 的上传状态。

- [ ] **步骤 4：缩减桥接组件职责**

删除 `isSiyuanImportRequest()`、`patchedFetch` 及对应的后台状态卡逻辑。保留文件 change 捕获、ZIP 内容检查、文件名规范化和短暂检查提示。检查提示使用稳定 key 或不使用 `AnimatePresence` 的替换动画。

- [ ] **步骤 5：运行前端相关测试**

运行任务 4 步骤 2 的命令。

预期：全部 PASS；连续轮询只存在一个状态节点。

- [ ] **步骤 6：提交任务 4**

```powershell
git add -- frontend/src/components/DataManager.tsx frontend/src/components/SiyuanImportProgressBridge.tsx frontend/src/components/__tests__/SiyuanImportProgressBridge.test.ts frontend/src/components/__tests__/SiyuanImportTaskProgress.test.tsx frontend/src/lib/api.impl.ts
git commit -m "fix(思源导入): 稳定任务进度展示"
```

### 任务 5：完整回归验证

**文件：**
- 检查：本计划涉及的全部文件

- [ ] **步骤 1：运行后端思源与知识树测试**

```powershell
node --import tsx --import ./tests/setup-db-isolation.ts --test tests/siyuan-package-import.test.ts tests/siyuan-package-tiptap-fidelity.test.ts tests/siyuan-import-metadata.test.ts tests/siyuan-package-tag-invariants.test.ts tests/siyuan-package-zip-budget.test.ts tests/legacy-knowledge-hierarchy.test.ts tests/siyuan-import-job-progress.test.ts
```

工作目录：`backend`

预期：全部 PASS。

- [ ] **步骤 2：运行前端相关测试**

```powershell
npm run test:run -- src/components/__tests__/SiyuanImportProgressBridge.test.ts src/components/__tests__/SiyuanImportTaskProgress.test.tsx
```

工作目录：`frontend`

预期：全部 PASS。

- [ ] **步骤 3：运行构建**

```powershell
npm run build
```

分别在 `backend` 与 `frontend` 目录执行，预期退出码均为 0。

- [ ] **步骤 4：检查提交范围与空白错误**

```powershell
git diff --check HEAD~4..HEAD
git status --short
```

预期：无空白错误；仅保留任务开始前已有的 `.workbuddy/` 未跟踪目录。
