# 知识树滚动条视觉重设计实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Web 端和桌面端知识树实现低干扰、可发现的“静谧胶囊”滚动条。

**架构：** 保留现有自定义滚动条的 DOM、几何计算、拖动逻辑和性能修复，只调整 `knowledgeTreeScrollbarBridge.ts` 注入的状态样式，并同步收敛 `Sidebar.tsx` 中原生滚动条兜底样式。移动端规则保持隐藏。

**技术栈：** TypeScript、CSS、React、Vitest、Vite

---

### 任务 1：实现静谧胶囊视觉状态

**文件：**
- 修改：`frontend/src/lib/__tests__/knowledgeTreeScrollbarRuntimeContract.test.ts`
- 修改：`frontend/src/lib/knowledgeTreeScrollbarBridge.ts:91-139`
- 修改：`frontend/src/components/Sidebar.tsx:38-66`

- [x] **步骤 1：编写失败的视觉契约测试**

在 `knowledgeTreeScrollbarRuntimeContract.test.ts` 增加：

```ts
it("uses the quiet pill visual treatment on web and desktop", () => {
  const bridge = source("../knowledgeTreeScrollbarBridge.ts");
  const sidebar = source("../../components/Sidebar.tsx");

  expect(bridge).toContain("left: 2.5px");
  expect(bridge).toContain("right: 2.5px");
  expect(bridge).toContain("opacity: 0.58");
  expect(bridge).toContain("left: 1.5px");
  expect(bridge).toContain("right: 1.5px");
  expect(bridge).toContain("opacity: 0;");
  expect(sidebar).toContain("border: 2.5px solid transparent");
  expect(sidebar).toContain("border-width: 1.5px");
});
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm run test:run -- src/lib/__tests__/knowledgeTreeScrollbarRuntimeContract.test.ts`

工作目录：`frontend`

预期：新增用例 FAIL，因为当前滑块占据约 `7px`，且不可滚动状态仍以 `0.45` 透明度显示。

- [x] **步骤 3：实现最小视觉改动**

在自定义滚动条样式中保持 `9px` 热区，将滑块默认边距改为：

```css
left: 2.5px;
right: 2.5px;
opacity: 0.58;
```

悬停、聚焦和拖动时改为：

```css
left: 1.5px;
right: 1.5px;
opacity: 0.95;
```

轨道交互底色收敛为 `color-mix(in srgb, var(--pm-scrollbar) 12%, transparent)`；不可滚动状态将滑块设为 `opacity: 0` 和 `pointer-events: none`。同步将原生 WebKit 兜底滑块边框从 `2px` 改为默认 `2.5px`，悬停时 `1.5px`。

- [x] **步骤 4：运行聚焦测试验证通过**

运行：`npm run test:run -- src/lib/__tests__/knowledgeTreeScrollbarRuntimeContract.test.ts src/lib/__tests__/knowledgeTreeScrollbarBridge.test.ts src/lib/__tests__/knowledgeTreeScrollbarContract.test.ts`

工作目录：`frontend`

预期：相关测试全部 PASS。

- [x] **步骤 5：运行前端构建**

运行：`npm run build`

工作目录：`frontend`

预期：TypeScript 检查和 Vite 生产构建以退出码 0 完成。

- [x] **步骤 6：检查工作区边界**

运行：`git diff --check -- frontend/src/lib/knowledgeTreeScrollbarBridge.ts frontend/src/components/Sidebar.tsx frontend/src/lib/__tests__/knowledgeTreeScrollbarRuntimeContract.test.ts`

预期：退出码 0；视觉改动仅位于样式和视觉契约测试，现有性能修复逻辑保持不变。本轮不创建混合提交。
