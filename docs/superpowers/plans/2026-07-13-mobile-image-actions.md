# 移动端图片操作菜单实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复手机端选中图片后操作菜单立即消失的问题，并提供紧凑一级操作栏与可展开的更多操作。

**架构：** Tiptap 继续负责图片选择和原始操作，`ImageExperienceBridge` 只负责移动端展示，`EditorImageTransformBridge` 继续负责旋转与翻转。通过可测试的选区判断阻止图片节点在收起键盘时因 blur 关闭菜单，并用专用插槽把变换操作放入“更多”面板。

**技术栈：** React 18、Tiptap、TypeScript、Vitest、Tailwind CSS

---

## 文件结构

- 修改 `frontend/src/lib/imageToolbar.ts`：提供图片节点失焦保留判断。
- 修改 `frontend/src/lib/__tests__/imageToolbar.test.ts`：覆盖图片与非图片选区的失焦行为。
- 修改 `frontend/src/components/TiptapEditor.tsx`：在图片节点仍被选中时保留图片菜单。
- 修改 `frontend/src/components/ImageExperienceBridge.tsx`：实现五项紧凑操作栏与“更多”面板。
- 修改 `frontend/src/components/EditorImageTransformBridge.tsx`：把旋转与翻转注入“更多”面板的专用插槽。
- 创建 `frontend/src/components/__tests__/ImageExperienceBridge.test.tsx`：验证手机端一级与二级菜单结构。

### 任务 1：锁定并修复失焦竞态

**文件：**
- 修改：`frontend/src/lib/imageToolbar.ts`
- 修改：`frontend/src/lib/__tests__/imageToolbar.test.ts`
- 修改：`frontend/src/components/TiptapEditor.tsx`

- [ ] **步骤 1：编写失败测试**

在 `imageToolbar.test.ts` 中增加：

```ts
it("keeps mobile image actions open when blur only dismisses the keyboard", () => {
  expect(shouldKeepImageActionsOpenOnBlur({ node: { type: { name: "image" } } })).toBe(true);
  expect(shouldKeepImageActionsOpenOnBlur({ node: { type: { name: "paragraph" } } })).toBe(false);
  expect(shouldKeepImageActionsOpenOnBlur(null)).toBe(false);
});
```

- [ ] **步骤 2：验证测试正确失败**

运行：`cd frontend && npm run test:run -- src/lib/__tests__/imageToolbar.test.ts`

预期：FAIL，提示 `shouldKeepImageActionsOpenOnBlur` 未导出。

- [ ] **步骤 3：实现最少修复**

在 `imageToolbar.ts` 新增：

```ts
export function shouldKeepImageActionsOpenOnBlur(
  selection: { node?: { type?: { name?: string } } } | null | undefined,
): boolean {
  return selection?.node?.type?.name === "image";
}
```

在 `TiptapEditor.tsx` 的 blur 处理里，仅在该函数返回 `false` 时关闭 `imageBubble`。

- [ ] **步骤 4：验证测试通过**

运行：`cd frontend && npm run test:run -- src/lib/__tests__/imageToolbar.test.ts`

预期：该测试文件全部 PASS。

### 任务 2：实现渐进式移动菜单

**文件：**
- 创建：`frontend/src/components/__tests__/ImageExperienceBridge.test.tsx`
- 修改：`frontend/src/components/ImageExperienceBridge.tsx`
- 修改：`frontend/src/components/EditorImageTransformBridge.tsx`

- [ ] **步骤 1：编写失败测试**

渲染 `ImageExperienceBridge` 和一个现有图片 Sheet，断言初始显示五个一级按钮；点击“更多”后出现尺寸按钮、复制、删除和 `data-nowen-image-transform-slot` 插槽。

```tsx
expect(document.querySelectorAll('[data-nowen-image-primary-action="true"]')).toHaveLength(5);
expect(document.querySelector('[data-nowen-image-more-panel="true"]')).toBeNull();
moreButton.click();
expect(document.querySelector('[data-nowen-image-more-panel="true"]')).not.toBeNull();
expect(document.querySelector('[data-nowen-image-transform-slot="true"]')).not.toBeNull();
```

- [ ] **步骤 2：验证测试正确失败**

运行：`cd frontend && npm run test:run -- src/components/__tests__/ImageExperienceBridge.test.tsx`

预期：FAIL，一级操作标记或更多面板不存在。

- [ ] **步骤 3：实现最少 UI 变更**

将移动端 Portal 调整为：

```tsx
<div className="grid grid-cols-5 gap-1.5">
  {/* 查看、下载、替换、编辑、更多 */}
</div>
{moreOpen && (
  <div data-nowen-image-more-panel="true">
    {/* 尺寸、复制、删除 */}
    <div data-nowen-image-transform-slot="true" />
  </div>
)}
```

将 `EditorImageTransformBridge.findCompactMobileSheet()` 改为查找 `[data-nowen-image-transform-slot="true"]`，使旋转与翻转只在更多面板中出现。

- [ ] **步骤 4：验证组件测试通过**

运行：`cd frontend && npm run test:run -- src/components/__tests__/ImageExperienceBridge.test.tsx src/components/__tests__/EditorImageTransformBridge.test.tsx`

预期：两个测试文件全部 PASS。

### 任务 3：回归与构建验证

**文件：**
- 验证以上所有修改文件。

- [ ] **步骤 1：运行图片体验相关测试**

运行：

```powershell
cd frontend
npm run test:run -- src/lib/__tests__/imageToolbar.test.ts src/lib/__tests__/imageExperience.test.ts src/lib/__tests__/mobileImageFocusGuard.test.ts src/components/__tests__/ImageExperienceBridge.test.tsx src/components/__tests__/EditorImageTransformBridge.test.tsx
```

预期：全部 PASS，且无未处理异常。

- [ ] **步骤 2：运行生产构建**

运行：`npm run build:frontend`

预期：TypeScript 与 Vite 构建退出码为 0。

- [ ] **步骤 3：检查变更范围**

运行：`git diff --check` 和 `git status --short`。

预期：仅包含本计划、图片菜单相关源文件和测试；已有 `.superpowers/` 未跟踪内容不纳入实现。
