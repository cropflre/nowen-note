# 移除侧栏账号入口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删除无效的侧栏账号入口，统一保留独立退出按钮，并保持 Electron 切回本地与设置中的认证恢复能力。

**架构：** 仅调整 `NavRail` 的展示和事件路由，不改变认证、服务器地址或桌面桥协议。通过源码边界测试锁定被删除入口与必须保留的操作，再运行前端构建验证类型和 JSX 分支。

**技术栈：** React、TypeScript、Vitest、Electron renderer bridge

---

## 文件结构

- 修改 `frontend/src/components/NavRail.tsx`：删除账号弹层，统一底部退出按钮，保留切回本地。
- 修改 `frontend/src/components/__tests__/removedConnectionFeatures.test.ts`：增加账号入口删除和保留操作的回归断言。

### 任务 1：移除账号入口并统一退出按钮

**文件：**
- 修改：`frontend/src/components/NavRail.tsx`
- 测试：`frontend/src/components/__tests__/removedConnectionFeatures.test.ts`

- [ ] **步骤 1：编写失败的行为边界测试**

```ts
expect(navRailSource).not.toContain("accountMenuOpen");
expect(navRailSource).not.toContain("sidebar.accountMenu");
expect(navRailSource).not.toContain("当前服务器");
expect(navRailSource).not.toContain("handleDesktopResetLocalAuth");
expect(navRailSource).toContain("handleDesktopLogout");
expect(navRailSource).toContain("handleDesktopCloudButton");
expect(dataManagerSource).toContain("resetDesktopLocalAuth");
```

- [ ] **步骤 2：运行测试并确认旧账号入口导致失败**

运行：`npm run test:run -- src/components/__tests__/removedConnectionFeatures.test.ts`

预期：FAIL，源码仍包含 `accountMenuOpen` 或 `sidebar.accountMenu`。

- [ ] **步骤 3：实现最小 UI 调整**

删除账号状态、监听、Portal 和图标；新增 `handleDesktopLogout` 根据 `canSwitchBackToLocal` 调用现有云端退出或本地会话退出流程；所有平台渲染独立退出按钮；Electron 可切回本地时继续额外渲染本地按钮。

- [ ] **步骤 4：运行定向测试和构建**

运行：`npm run test:run -- src/components/__tests__/removedConnectionFeatures.test.ts src/components/__tests__/LoginPageIcp.test.tsx`

运行：`npm run build`

预期：测试与构建退出码均为 0。

- [ ] **步骤 5：提交实现**

```powershell
git add -- frontend/src/components/NavRail.tsx frontend/src/components/__tests__/removedConnectionFeatures.test.ts
git commit -m "feat: 移除侧栏账号入口"
```
