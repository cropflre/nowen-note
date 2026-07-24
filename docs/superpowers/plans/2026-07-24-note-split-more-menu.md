# “拆分文档”入口移入更多菜单实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 删除编辑器右下角的拆分悬浮按钮，并在桌面端和移动端更多菜单中提供同一拆分操作。

**架构：** `EditorPaneRuntime` 保留拆分条件和弹窗状态，通过两个可选属性把可用性与触发回调传给 `EditorPane`。`EditorPane` 只负责在两个更多菜单中渲染菜单项和关闭菜单，不复制任何拆分业务逻辑。

**技术栈：** React 18、TypeScript、Vitest、Tailwind CSS、Lucide React

---

## 文件结构

- 修改 `frontend/src/components/EditorPaneRuntime.tsx`：移除悬浮按钮，向主编辑器传递拆分能力。
- 修改 `frontend/src/components/EditorPane.tsx`：声明可选属性，并在桌面端、移动端更多菜单中渲染拆分入口。
- 修改 `frontend/src/components/__tests__/EditorPaneRuntimeLayout.test.tsx`：验证运行时传参、弹窗触发以及无悬浮入口。
- 修改 `frontend/src/components/__tests__/EditorPaneMobileHeader.test.ts`：验证两个更多菜单均包含拆分入口。

### 任务 1：建立失败的交互回归测试

**文件：**
- 修改：`frontend/src/components/__tests__/EditorPaneRuntimeLayout.test.tsx`
- 修改：`frontend/src/components/__tests__/EditorPaneMobileHeader.test.ts`

- [ ] **步骤 1：验证 Runtime 通过属性委托拆分动作**

将 `EditorPane` mock 改为记录 `canSplitDocument` 和 `onSplitDocument`，使用包含两个同级标题的可写笔记渲染 Runtime，并断言：

```tsx
expect(mocks.editorPaneProps?.canSplitDocument).toBe(true);
expect(host.textContent).not.toContain("拆分文档");
await act(async () => mocks.editorPaneProps?.onSplitDocument?.());
expect(host.querySelector('[data-testid="note-split-dialog"]')).not.toBeNull();
```

- [ ] **步骤 2：验证桌面端和移动端更多菜单源码均包含入口**

在现有源码结构测试中分别截取 `showMobileMenu` 和 `showDesktopMoreMenu` 区域，并断言：

```ts
expect(mobileMenu).toContain("onSplitDocument");
expect(mobileMenu).toContain("<Scissors");
expect(desktopMenu).toContain("onSplitDocument");
expect(desktopMenu).toContain("<Scissors");
```

- [ ] **步骤 3：运行测试并确认按预期失败**

运行：

```powershell
npm run test:run -- src/components/__tests__/EditorPaneRuntimeLayout.test.tsx src/components/__tests__/EditorPaneMobileHeader.test.ts --reporter=verbose
```

预期：测试因 `EditorPane` 尚无拆分属性、更多菜单尚无剪刀入口而失败。

### 任务 2：实现菜单入口并移除悬浮按钮

**文件：**
- 修改：`frontend/src/components/EditorPaneRuntime.tsx`
- 修改：`frontend/src/components/EditorPane.tsx`

- [ ] **步骤 1：为 EditorPane 增加可选属性**

```tsx
interface EditorPaneProps {
  canSplitDocument?: boolean;
  onSplitDocument?: () => void;
}

export default function EditorPane({
  canSplitDocument = false,
  onSplitDocument,
}: EditorPaneProps) {
```

- [ ] **步骤 2：Runtime 通过属性传递能力并删除悬浮按钮**

```tsx
<EditorPane
  canSplitDocument={canSplit}
  onSplitDocument={() => setDialogOpen(true)}
/>
```

保留现有 `NoteSplitDialog`，删除绝对定位的悬浮 `<button>`。

- [ ] **步骤 3：在两个更多菜单中加入菜单项**

两个菜单都在 `canSplitDocument && onSplitDocument` 时渲染，点击后调用回调并关闭各自菜单：

```tsx
<button onClick={() => { onSplitDocument(); setShowDesktopMoreMenu(false); }}>
  <Scissors size={15} className="text-accent-primary" />
  <span>拆分文档</span>
</button>
```

移动端使用同样逻辑并关闭 `showMobileMenu`。

- [ ] **步骤 4：运行定向测试确认通过**

运行：

```powershell
npm run test:run -- src/components/__tests__/EditorPaneRuntimeLayout.test.tsx src/components/__tests__/EditorPaneMobileHeader.test.ts --reporter=verbose
```

预期：两个测试文件全部通过。

### 任务 3：验证构建与真实交互

**文件：**
- 验证：`frontend/src/components/EditorPaneRuntime.tsx`
- 验证：`frontend/src/components/EditorPane.tsx`

- [ ] **步骤 1：运行相关滚动与窗口化回归**

```powershell
npm run test:run -- src/components/__tests__/EditorPaneRuntimeLayout.test.tsx src/components/__tests__/EditorPaneMobileHeader.test.ts src/components/__tests__/WindowedTiptapEditor.test.tsx src/lib/__tests__/tiptapEditorScrollLayout.test.ts --reporter=verbose
```

预期：全部通过，确保入口移动没有破坏上一项滚动修复。

- [ ] **步骤 2：运行前端生产构建**

```powershell
npm run build
```

预期：TypeScript 和 Vite 构建退出码为 0。

- [ ] **步骤 3：真实页面验证**

打开可拆分长笔记，确认右下角无悬浮按钮；打开桌面端更多菜单，确认“拆分文档”存在；点击后确认更多菜单关闭且拆分预览弹窗打开。

- [ ] **步骤 4：提交代码**

```powershell
git add -- frontend/src/components/EditorPaneRuntime.tsx frontend/src/components/EditorPane.tsx frontend/src/components/__tests__/EditorPaneRuntimeLayout.test.tsx frontend/src/components/__tests__/EditorPaneMobileHeader.test.ts docs/superpowers/plans/2026-07-24-note-split-more-menu.md
git commit -m "feat: 将拆分文档移入更多菜单"
```
