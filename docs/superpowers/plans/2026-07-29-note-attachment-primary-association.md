# 笔记附件目录归属关系修复实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让笔记附件目录同时返回首次归属于该笔记和正文实际引用的附件。

**架构：** 保持前端接口不变，只修正 `/api/files` 的 `noteId` SQL 条件。归属关系读取 `attachments.noteId`，正文引用继续读取 `attachment_references`，两者使用 OR 合并且不改写数据。

**技术栈：** TypeScript、Hono、SQLite、Node.js Test Runner

---

## 文件结构

- 修改 `backend/tests/attachment-shared-access.test.ts`：覆盖空白来源笔记拥有附件的回归场景。
- 修改 `backend/src/routes/files.ts`：修正 `noteId` 列表筛选条件。

### 任务 1：回归测试与最小修复

**文件：**
- 测试：`backend/tests/attachment-shared-access.test.ts`
- 修改：`backend/src/routes/files.ts:440-445`

- [x] **步骤 1：编写失败的测试**

```ts
test("note attachment list includes files owned by a blank source note", async () => {
  const response = await app.request(`/files?noteId=${NOTE_ID}`, {
    headers: { "X-User-Id": OWNER_ID },
  });
  assert.equal(response.status, 200);
  const payload = await responseJson<{ items: Array<{ id: string }>; total: number }>(response);
  assert.equal(payload.total, 1);
  assert.deepEqual(payload.items.map((item) => item.id), [attachmentId]);
});
```

- [x] **步骤 2：运行测试验证失败**

运行：`node --import tsx --test tests/attachment-shared-access.test.ts`

预期：新增测试失败，`payload.total` 实际为 0，证明当前接口遗漏 `attachments.noteId`。

- [x] **步骤 3：编写最少实现代码**

```ts
whereParts.push(
  "(a.noteId = ? OR EXISTS(SELECT 1 FROM attachment_references ar WHERE ar.attachmentId = a.id AND ar.noteId = ?))",
);
params.push(noteIdFilter, noteIdFilter);
```

- [x] **步骤 4：运行测试验证通过**

运行：`node --import tsx --test tests/attachment-shared-access.test.ts`

预期：该测试文件全部通过，新增用例返回上传到空白来源笔记的附件。

- [x] **步骤 5：运行构建与范围检查**

运行：`npm run build:tsc`

预期：退出码为 0。随后从仓库根目录运行 `git diff --check` 和限定文件的 `git diff`，确认没有空白错误且不包含现有知识树改动。
