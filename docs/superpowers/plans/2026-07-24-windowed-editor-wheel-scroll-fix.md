# 窗口化编辑器滚轮修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 消除窗口化富文本编辑器的嵌套纵向滚动，使鼠标滚轮始终驱动统一的章节窗口容器。

**架构：** `WindowedTiptapEditor` 继续作为唯一纵向滚动容器，并向每个 `TiptapEditor` 章节传入外部滚动标记。`TiptapEditor` 仅在该标记开启时取消根节点固定高度和正文内部滚动；普通编辑器维持原有布局。

**技术栈：** React、TypeScript、Tailwind CSS、Vitest、jsdom

---

### 任务 1：锁定窗口化滚动契约

**文件：**
- 修改：`frontend/src/components/__tests__/WindowedTiptapEditor.test.tsx`
- 修改：`frontend/src/components/WindowedTiptapEditor.tsx`

- [x] **步骤 1：编写失败的测试**

在窗口化组件测试中断言已挂载章节都收到 `useParentScrollContainer: true`。

- [x] **步骤 2：运行测试验证失败**

运行：`npm run test:run -- src/components/__tests__/WindowedTiptapEditor.test.tsx`

预期：新测试 FAIL，收到的 `useParentScrollContainer` 为 `undefined`。

- [x] **步骤 3：编写最少实现代码**

向窗口化组件中的全部 `BaseTiptapEditor` 传入 `useParentScrollContainer`。

- [x] **步骤 4：运行测试验证通过**

运行：`npm run test:run -- src/components/__tests__/WindowedTiptapEditor.test.tsx`

预期：该测试文件全部 PASS。

### 任务 2：取消章节内部纵向滚动

**文件：**
- 修改：`frontend/src/components/TiptapEditor.tsx`
- 创建：`frontend/src/lib/tiptapEditorScrollLayout.ts`
- 创建：`frontend/src/lib/__tests__/tiptapEditorScrollLayout.test.ts`

- [x] **步骤 1：编写失败的测试**

为普通模式和父容器滚动模式增加布局契约测试。

- [x] **步骤 2：运行测试验证失败**

运行：`npm run test:run -- src/lib/__tests__/tiptapEditorScrollLayout.test.ts`

预期：FAIL，父容器滚动模式尚未实现。

- [x] **步骤 3：编写最少实现代码**

创建纯函数返回两种布局，并在 `TiptapEditor` 根节点和正文容器中使用；新增可选属性 `useParentScrollContainer?: boolean`。

- [x] **步骤 4：运行定向回归**

运行：`npm run test:run -- src/lib/__tests__/tiptapEditorScrollLayout.test.ts src/components/__tests__/WindowedTiptapEditor.test.tsx src/components/__tests__/TiptapBlockPatchRuntime.test.tsx`

预期：全部 PASS。

- [x] **步骤 5：运行类型检查与生产构建**

运行：`npm run build`

预期：TypeScript 与 Vite 生产构建成功。

### 任务 3：保持窗口化滚动附属功能

**文件：**
- 修改：`frontend/src/components/TiptapEditor.tsx`
- 修改：`frontend/src/components/WindowedTiptapEditor.tsx`
- 修改：`frontend/src/lib/tiptapEditorScrollLayout.ts`
- 测试：`frontend/src/lib/__tests__/tiptapEditorScrollLayout.test.ts`
- 测试：`frontend/src/components/__tests__/WindowedTiptapEditor.test.tsx`

- [x] **步骤 1：编写并运行失败测试**

验证窗口化正文引用解析到外层滚动容器，首章节包装层不再限制共享 sticky 工具栏。

- [x] **步骤 2：实现最小布局修复**

首章节使用 `display: contents` 打平两个包装层；正文 ref 在窗口化模式解析最近的 `data-windowed-tiptap-editor`。

- [x] **步骤 3：重新运行定向测试与生产构建**

运行任务 2 的定向回归与 `npm run build`，预期全部成功。

### 任务 4：收口窗口化回到顶部控件

**文件：**
- 修改：`frontend/src/components/TiptapEditor.tsx`
- 修改：`frontend/src/components/WindowedTiptapEditor.tsx`
- 修改：`frontend/src/lib/tiptapEditorScrollLayout.ts`
- 测试：`frontend/src/components/__tests__/WindowedTiptapEditor.test.tsx`

- [x] **步骤 1：编写并运行失败测试**

验证外层滚动超过阈值后只渲染一份覆盖按钮，点击后滚动外层到顶部。

- [x] **步骤 2：实现最小覆盖层**

为滚动容器增加非滚动定位外壳；父级滚动模式禁止章节内部渲染回顶按钮。

- [x] **步骤 3：重新运行定向测试与生产构建**

运行任务 2 的定向回归与 `npm run build`，预期全部成功。
