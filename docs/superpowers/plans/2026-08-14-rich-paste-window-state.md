# 富文本粘贴与窗口状态恢复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 恢复外部富文本的默认源格式粘贴，并让 Electron 主窗口跨重启和升级恢复状态。

**架构：** 用纯函数隔离粘贴路由和窗口边界计算，使两个行为可独立回归测试。主编辑器只调整分支优先级；Electron 继续复用现有原子设置存储，并在窗口生命周期事件中读写状态。

**技术栈：** TypeScript、Vitest、Electron、Node.js `node:test`

---

### 任务 1：富文本优先粘贴

**文件：**
- 创建：`frontend/src/lib/pasteRouting.ts`
- 创建：`frontend/src/lib/__tests__/pasteRouting.test.ts`
- 修改：`frontend/src/components/TiptapEditor.tsx`

- [x] **步骤 1：编写失败测试**

测试 `hasMeaningfulClipboardHtml()`：`<p><strong>标题</strong></p>` 返回 `true`，空字符串和仅元信息返回 `false`；测试 `shouldPreferPlainTextPaste()` 在 HTML 与数字列表纯文本同时存在时返回 `false`，只有纯文本时返回 `true`。

- [x] **步骤 2：验证红灯**

运行：`npm run test:run -- src/lib/__tests__/pasteRouting.test.ts`（目录 `frontend`）

预期：测试因 `pasteRouting` 模块不存在而失败。

- [x] **步骤 3：最少实现**

实现：

```ts
export function hasMeaningfulClipboardHtml(html: string): boolean {
  return /<(?!html\b|head\b|meta\b|body\b)[a-z][^>]*>/i.test(html);
}

export function shouldPreferPlainTextPaste(html: string): boolean {
  return !hasMeaningfulClipboardHtml(html);
}
```

仅在 `TiptapEditor` 的 Markdown 检测条件中增加 `shouldPreferPlainTextPaste(html)`；代码块内粘贴和现有代码检测分支不变。

- [x] **步骤 4：验证绿灯**

运行：`npm run test:run -- src/lib/__tests__/pasteRouting.test.ts`（目录 `frontend`）

预期：全部通过。

### 任务 2：持久化窗口状态

**文件：**
- 创建：`electron/window-state.js`
- 创建：`electron/__tests__/windowState.test.js`
- 修改：`electron/settings.js`
- 修改：`electron/main.js`

- [x] **步骤 1：编写失败测试**

用 `node:test` 覆盖保存状态归一化、有效显示器原位恢复、断开的显示器回退到主屏、最小尺寸限制和最大化标记保留；设置测试确认 `windowState` 写入后再次读取仍存在。

- [x] **步骤 2：验证红灯**

运行：`node --test electron/__tests__/windowState.test.js`

预期：测试因 `window-state.js` 或 `windowState` 设置字段不存在而失败。

- [x] **步骤 3：最少实现**

`window-state.js` 导出 `normalizeStoredWindowState()`、`resolveWindowBounds()` 和 `attachWindowStatePersistence()`。`settings.js` 对有限数值坐标、正尺寸和布尔最大化状态进行白名单归一化。`main.js` 创建窗口时读取计算后的边界，并在需要时最大化。

- [x] **步骤 4：验证绿灯**

运行：`node --test electron/__tests__/windowState.test.js`

预期：全部通过。

### 任务 3：综合验证

**文件：**
- 验证上述全部生产代码和测试文件

- [x] **步骤 1：运行针对性测试**

运行：`npm run test:run -- src/lib/__tests__/pasteRouting.test.ts src/lib/__tests__/pasteForegroundColor.test.ts`（目录 `frontend`）

运行：`node --test electron/__tests__/windowState.test.js electron/__tests__/textContextMenu.test.js`

预期：全部通过且无失败。

- [x] **步骤 2：运行前端构建**

运行：`npm run build`（目录 `frontend`）

预期：TypeScript、Vite 和同步通知界面校验均以退出码 0 完成。

- [x] **步骤 3：检查变更范围**

运行：`git diff --check` 和 `git status --short`

预期：没有空白错误，且仅包含本计划文件、两个修复及其测试；`.workbuddy/` 保持未跟踪且未修改。
