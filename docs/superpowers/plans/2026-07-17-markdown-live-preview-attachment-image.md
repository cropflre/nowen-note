# Markdown 实时预览附件图片修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Markdown 实时预览使用当前有效的附件签名 URL 显示图片，同时保持 Markdown 源文不变。

**架构：** 在共用的 `MarkdownPreview` 图片渲染边界调用现有 `resolveAttachmentUrl()`。这样实时预览和完整预览共享同一解析行为，不需要放宽附件访问桥对可编辑 DOM 的保护。

**技术栈：** React、React Markdown、TypeScript、Vitest、jsdom

---

## 文件结构

- 修改 `frontend/src/components/MarkdownPreview.tsx`：渲染图片时解析附件访问 URL。
- 修改 `frontend/src/components/__tests__/MarkdownPreview.test.tsx`：覆盖附件签名 URL 与源 Markdown 保持不变。

### 任务 1：为 Markdown 图片附件签名增加回归测试

**文件：**
- 修改：`frontend/src/components/__tests__/MarkdownPreview.test.tsx`

- [x] **步骤 1：编写失败的测试**

在测试中注册一个附件签名映射，渲染附件图片，并断言最终 `<img>` 使用含 `sig` 的地址：

```tsx
const markdown = `![附件图片](/api/attachments/${ATTACHMENT_ID})`;
registerAttachmentAccessUrls(
  { [ATTACHMENT_ID]: `/api/attachments/${ATTACHMENT_ID}?exp=2000000000&sig=preview-signature&scope=v2.scope` },
  "http://localhost/api/attachments/access/urls?noteId=note-1",
);

await act(async () => {
  root.render(<MarkdownPreview markdown={markdown} />);
});

const imageUrl = new URL(host.querySelector("img")!.src);
expect(imageUrl.searchParams.get("sig")).toBe("preview-signature");
expect(markdown).toBe(`![附件图片](/api/attachments/${ATTACHMENT_ID})`);
```

- [x] **步骤 2：运行测试验证失败**

运行：`npm run test:run -- src/components/__tests__/MarkdownPreview.test.tsx`

预期：新增用例 FAIL，图片 `src` 没有 `sig=preview-signature`。

### 任务 2：在图片渲染边界解析附件 URL

**文件：**
- 修改：`frontend/src/components/MarkdownPreview.tsx`
- 测试：`frontend/src/components/__tests__/MarkdownPreview.test.tsx`

- [x] **步骤 1：编写最少实现代码**

导入 `resolveAttachmentUrl`，并在 `PreviewImage` 中只对渲染地址进行解析：

```tsx
const resolvedSrc = resolveAttachmentUrl(src);

<img
  src={resolvedSrc}
  onClick={() => window.open(resolvedSrc, "_blank", "noopener,noreferrer")}
/>
```

- [x] **步骤 2：运行定向测试验证通过**

运行：`npm run test:run -- src/components/__tests__/MarkdownPreview.test.tsx src/lib/__tests__/markdownLivePreview.test.tsx src/lib/__tests__/noteAttachmentAccessBridge.test.ts`

预期：全部 PASS。

- [x] **步骤 3：运行前端构建和差异检查**

运行：`npm run build`

预期：退出码 0。

运行：`git diff --check`

预期：退出码 0，无空白错误。

- [x] **步骤 4：提交修复**

```bash
git add frontend/src/components/MarkdownPreview.tsx frontend/src/components/__tests__/MarkdownPreview.test.tsx docs/superpowers/plans/2026-07-17-markdown-live-preview-attachment-image.md
git commit -m "fix markdown live preview attachment images"
```
