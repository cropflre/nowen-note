# 备份面板全量任务接入实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让“备份与灾备”中的手动全量备份使用现有后台任务接口，并在任务执行期间持续显示状态。

**架构：** `DataManager` 继续让仅数据库备份调用同步 `api.backup.create`；全量备份改为调用既有 `runFullBackupJob(api.backup.fullJobs)`，复用短请求轮询。轮询消息写入现有创建结果区域，按钮在任务结束前保持禁用，完成后刷新备份列表。

**技术栈：** React、TypeScript、Vitest、现有备份 API 客户端

---

**文件结构：**

- 修改：`frontend/src/components/DataManager.tsx`，按备份类型选择同步或后台任务路径并渲染运行状态。
- 创建：`frontend/src/components/__tests__/DataManagerFullBackupJob.test.ts`，锁定入口接线与状态回显契约。

### 任务 1：锁定全量备份入口契约

**文件：**
- 创建：`frontend/src/components/__tests__/DataManagerFullBackupJob.test.ts`
- 修改：`frontend/src/components/DataManager.tsx:23-59,3459-3460,3574-3605,4090-4095`

- [x] **步骤 1：编写失败的测试**

```ts
expect(source).toContain('import { runFullBackupJob } from "@/lib/fullBackupJobClient";');
expect(createSource).toContain('type === "full"');
expect(createSource).toContain('runFullBackupJob(');
expect(createSource).toContain('api.backup.fullJobs');
expect(createSource).toContain('onStatus: (text) => setCreateMsg({ type: "progress", text })');
expect(createSource).toContain('api.backup.create(type, tk)');
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm test -- --run src/components/__tests__/DataManagerFullBackupJob.test.ts`

预期：FAIL，提示 `DataManager.tsx` 尚未导入或调用 `runFullBackupJob`。

- [x] **步骤 3：编写最少实现代码**

```ts
const action = type === "full"
  ? (tk: string) => runFullBackupJob(
      api.backup.fullJobs,
      tk,
      "数据管理：手动全量备份",
      { onStatus: (text) => setCreateMsg({ type: "progress", text }) },
    )
  : (tk: string) => api.backup.create(type, tk);
```

将 `createMsg.type` 扩展为 `"ok" | "err" | "progress"`，进度状态使用旋转图标与蓝色文本。

- [x] **步骤 4：运行测试验证通过**

运行：`npm test -- --run src/components/__tests__/DataManagerFullBackupJob.test.ts src/lib/__tests__/fullBackupJobClient.test.ts`

预期：两个测试文件全部 PASS。

- [x] **步骤 5：验证前端构建**

运行：`npm run build`

预期：TypeScript、Vite 构建和同步通知 UI 校验全部退出码为 0。

- [x] **步骤 6：检查变更范围**

运行：`git diff -- frontend/src/components/DataManager.tsx frontend/src/components/__tests__/DataManagerFullBackupJob.test.ts docs/superpowers/plans/2026-08-14-backup-panel-full-job.md`

预期：只有全量备份入口、进度展示、回归测试和本计划发生变化。
