# 树列表滚动条性能修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 移除自绘滚动条的整页 DOM 监听，同时保持桌面树列表滚动条可见并可自动恢复。

**架构：** 应用启动只安装样式和基础协调器；桌面侧栏通过显式入口通知桥接挂载。运行期只观察树滚动容器及其直接父节点，不处理编辑器或其它页面区域的 DOM 变化。

**技术栈：** React、TypeScript、MutationObserver、ResizeObserver、Vitest、jsdom

---

### 任务 1：锁定全局监听性能回归

**文件：**
- 测试：`frontend/src/lib/__tests__/knowledgeTreeScrollbarBridge.test.ts`

- [x] **步骤 1：编写失败测试**

```ts
it("ignores unrelated document mutations", async () => {
  cleanupScrollbarBridge = installKnowledgeTreeScrollbarBridge();
  await waitForScrollbarReconcile();
  const query = vi.spyOn(document, "querySelectorAll");
  document.body.appendChild(document.createElement("div"));
  await waitForScrollbarReconcile();
  expect(query).not.toHaveBeenCalled();
});
```

- [x] **步骤 2：验证红灯**

运行：`npm run test -- --run src/lib/__tests__/knowledgeTreeScrollbarBridge.test.ts`

预期：测试失败，证明无关 DOM 变化仍触发 `document.querySelectorAll`。

### 任务 2：改为侧栏主动协调和局部观察

**文件：**
- 修改：`frontend/src/lib/knowledgeTreeScrollbarBridge.ts`
- 修改：`frontend/src/components/Sidebar.tsx`
- 测试：`frontend/src/lib/__tests__/knowledgeTreeScrollbarBridge.test.ts`

- [x] **步骤 1：导出协调入口并删除全局观察器**

```ts
export function refreshKnowledgeTreeScrollbars(): void {
  if (!installed) return;
  scheduleReconcile();
}
```

- [x] **步骤 2：在桌面侧栏生命周期中调用入口**

```ts
useEffect(() => {
  if (variant !== "desktop") return;
  refreshKnowledgeTreeScrollbars();
  return refreshKnowledgeTreeScrollbars;
}, [variant]);
```

- [x] **步骤 3：父节点局部监听轨道移除**

只对滚动容器直接父节点启用 `{ childList: true }`，轨道断开时调用协调入口，并在控制器销毁时断开观察器。

- [x] **步骤 4：验证绿灯**

运行：`npm run test -- --run src/lib/__tests__/knowledgeTreeScrollbarBridge.test.ts src/lib/__tests__/knowledgeTreeScrollbarRuntimeContract.test.ts`

预期：全部通过。

- [x] **步骤 5：生产构建**

运行：`npm run build`

预期：退出码为 0。
