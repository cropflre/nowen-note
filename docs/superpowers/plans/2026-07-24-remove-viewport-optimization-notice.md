# 移除视口优化模式提示实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让编辑器进入 `viewport-optimized` 模式时不再显示运行时浮层，同时保留轻量编辑模式提示和所有性能优化。

**架构：** 只收窄 `editorRuntimeStore` 的浮层可见条件，并删除因此失去调用路径的视口提示文案。通过现有 jsdom 测试直接驱动运行时决策，验证视口优化不提示、轻量编辑仍提示。

**技术栈：** TypeScript、Vitest、jsdom、Vite

---

### 任务 1：收窄运行时提示范围

**文件：**
- 修改：`frontend/src/lib/__tests__/editorRuntimeNotice.test.ts`
- 修改：`frontend/src/lib/editorRuntimeStore.ts:125-211`

- [x] **步骤 1：编写失败的回归测试**

在 `editorRuntimeNotice.test.ts` 中增加：

```ts
it("does not show a notice for viewport-optimized mode", () => {
  const decision = resolveEditorRuntimeDecision({
    content: richText(120_000),
    contentFormat: "tiptap-json",
  });
  setActiveEditorRuntimeDecision("viewport-note", decision);

  expect(getActiveEditorRuntimeState().decision.mode).toBe("viewport-optimized");
  expect(document.getElementById("nowen-editor-runtime-notice")?.hidden).toBe(true);
});
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm run test:run -- src/lib/__tests__/editorRuntimeNotice.test.ts`

工作目录：`frontend`

预期：新增用例 FAIL，因为当前浮层在 `viewport-optimized` 模式下可见。

- [x] **步骤 3：编写最少实现代码**

将浮层可见条件收窄为：

```ts
const visible = mode === "lightweight-edit";
```

同时将 `runtimeNoticeCopy` 收窄为轻量编辑模式的中英文文案，删除不再可达的视口优化文案分支。

- [x] **步骤 4：运行聚焦测试验证通过**

运行：`npm run test:run -- src/lib/__tests__/editorRuntimeNotice.test.ts src/lib/__tests__/editorRuntimeStore.test.ts`

工作目录：`frontend`

预期：相关测试全部 PASS。

- [x] **步骤 5：运行前端构建**

运行：`npm run build`

工作目录：`frontend`

预期：TypeScript 检查和 Vite 生产构建均以退出码 0 完成。

- [x] **步骤 6：检查差异边界**

运行：`git diff --check -- frontend/src/lib/editorRuntimeStore.ts frontend/src/lib/__tests__/editorRuntimeNotice.test.ts`

预期：退出码 0，且业务差异仅涉及上述两个文件。
