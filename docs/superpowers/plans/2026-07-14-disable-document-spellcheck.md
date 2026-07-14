# 全端关闭文档拼写检查实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在桌面端、移动端和网页端共用的富文本与 Markdown 编辑器中，始终关闭标题和正文的原生拼写检查。

**架构：** 只修改共享前端编辑器入口。Tiptap 通过 `editorProps.attributes` 设置 ProseMirror 根节点属性，CodeMirror 通过 `EditorView.contentAttributes` 设置内容根节点属性；两个标题输入框直接使用 React 的 `spellCheck` 属性。

**技术栈：** React 18、TypeScript、Tiptap 3、CodeMirror 6、Vitest

---

## 文件结构

- 创建：`frontend/src/components/__tests__/EditorSpellcheck.test.ts`，验证四个编辑入口均明确关闭拼写检查。
- 修改：`frontend/src/components/TiptapEditor.tsx`，关闭富文本标题与正文拼写检查。
- 修改：`frontend/src/components/MarkdownEditorImpl.tsx`，关闭 Markdown 标题与正文拼写检查。

### 任务 1：关闭所有文档编辑入口的拼写检查

**文件：**

- 创建：`frontend/src/components/__tests__/EditorSpellcheck.test.ts`
- 修改：`frontend/src/components/TiptapEditor.tsx:1847-1851,4585-4592`
- 修改：`frontend/src/components/MarkdownEditorImpl.tsx:1040-1120,1732-1741`

- [x] **步骤 1：编写失败的回归测试**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const tiptapEditorSource = readFileSync(path.resolve(__dirname, "../TiptapEditor.tsx"), "utf8");
const markdownEditorSource = readFileSync(path.resolve(__dirname, "../MarkdownEditorImpl.tsx"), "utf8");

describe("editor spellcheck", () => {
  it("disables spellcheck for the rich text title and document body", () => {
    expect(tiptapEditorSource).toContain("spellCheck={false}");
    expect(tiptapEditorSource).toContain('spellcheck: "false"');
  });

  it("disables spellcheck for the Markdown title and document body", () => {
    expect(markdownEditorSource).toContain("spellCheck={false}");
    expect(markdownEditorSource).toContain('EditorView.contentAttributes.of({ spellcheck: "false" })');
  });
});
```

- [x] **步骤 2：运行测试并验证因缺少属性而失败**

运行：`npm run test:run -- src/components/__tests__/EditorSpellcheck.test.ts`

预期：2 个测试失败，分别报告缺少 `spellCheck={false}`、`spellcheck: "false"` 或 `EditorView.contentAttributes`。

- [x] **步骤 3：编写最少实现**

在 Tiptap 的 `editorProps.attributes` 中加入：

```ts
spellcheck: "false",
```

在 Tiptap 标题输入框加入：

```tsx
spellCheck={false}
```

在 CodeMirror 扩展列表加入：

```ts
EditorView.contentAttributes.of({ spellcheck: "false" }),
```

在 Markdown 标题输入框加入：

```tsx
spellCheck={false}
```

- [x] **步骤 4：运行新增测试并验证通过**

运行：`npm run test:run -- src/components/__tests__/EditorSpellcheck.test.ts`

预期：1 个测试文件、2 个测试全部通过。

- [x] **步骤 5：运行前端构建**

运行：`npm run build`

预期：TypeScript 检查和 Vite 构建退出码为 0。

- [x] **步骤 6：检查差异并提交**

```powershell
git diff --check
git add frontend/src/components/__tests__/EditorSpellcheck.test.ts frontend/src/components/TiptapEditor.tsx frontend/src/components/MarkdownEditorImpl.tsx
git commit -m "fix(editor): 全端关闭文档拼写检查"
```
