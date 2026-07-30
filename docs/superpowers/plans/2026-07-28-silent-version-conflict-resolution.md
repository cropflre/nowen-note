# 静默版本冲突处理实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 静默采用服务器当前版本，并在清理冲突前保存本地冲突副本。

**架构：** 复用 `resolveNoteConflict(item, "use-server")` 的已确认、幂等副本写入链路；同步引擎负责后台调用。展示层过滤冲突项目，编辑器不再订阅冲突通知。

**技术栈：** React、TypeScript、Vitest、现有离线队列和同步引擎。

---

### 任务 1：锁定服务器版本优先行为

**文件：**
- 修改：`frontend/src/lib/__tests__/conflictResolution.test.ts`
- 修改：`frontend/src/lib/conflictResolution.ts`

- [x] 修改自动处理测试，断言最新本地 payload 被创建为稳定冲突副本，且不调用 `updateNoteConfirmed`。
- [x] 运行该测试并确认因当前 `keep-local` 行为失败。
- [x] 将自动处理改为调用 `resolveNoteConflict(item, "use-server")`。
- [x] 重新运行测试并确认通过。

### 任务 2：移除冲突用户提示

**文件：**
- 修改：`frontend/src/components/__tests__/OfflineIndicatorConflictPresentation.test.ts`
- 修改：`frontend/src/components/common/OfflineIndicator.tsx`
- 修改：`frontend/src/components/EditorPane.tsx`

- [x] 先把展示测试改为断言纯冲突返回 `null`，混合失败只显示非冲突数量，并确认失败。
- [x] 过滤横幅和详情列表中的冲突项目，保留非冲突提示。
- [x] 移除编辑器冲突事件监听及 toast。
- [x] 重新运行展示测试并确认通过。

### 任务 3：回归验证

**文件：**
- 验证：`frontend/src/lib/__tests__/conflictResolution.test.ts`
- 验证：`frontend/src/components/__tests__/OfflineIndicatorConflictPresentation.test.ts`
- 验证：`frontend/src/lib/__tests__/noteSyncSafety.integration.test.ts`
- 验证：`frontend/src/lib/__tests__/offlineQueue.test.ts`

- [x] 运行五个定向测试文件，预期全部通过。
- [x] 运行 `npm run build`，预期退出码为 0。
- [x] 检查 `git diff --check` 和最终差异，只保留本需求相关文件。
