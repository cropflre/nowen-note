# TypeScript SDK 使用教程

> 在 Node.js / TypeScript 项目中通过 SDK 操作 nowen-note。

---

## 安装

```bash
npm install nowen-sdk
```

在仓库内开发时：

```bash
cd packages/nowen-sdk
npm ci
npm run build
```

---

## 快速开始

```typescript
import { NowenClient } from "nowen-sdk";

const client = new NowenClient({
  baseUrl: "http://localhost:3001",
  username: "admin",
  password: "admin123",
});

const notebooks = await client.listNotebooks();
const targetNotebook = notebooks[0];

const note = await client.createNote({
  notebookId: targetNotebook.id,
  title: "SDK 创建的 Markdown 笔记",
  content: "# 标题\n\n正文 **加粗**\n\n- 第一项\n- 第二项",
  contentFormat: "markdown",
});

console.log(note.id, note.contentFormat);
```

Markdown 源文应写入 `content`，并显式设置 `contentFormat: "markdown"`。`contentText` 是服务端派生的搜索字段，第三方工具不应把它作为正文真源。

---

## 笔记内容格式

SDK 支持以下格式：

```typescript
export type NoteContentFormat = "markdown" | "tiptap-json" | "html";
```

推荐 CLI、AI Agent 和导入工具优先使用 `markdown`：

- 无需加载 Tiptap 或浏览器环境；
- 原始 Markdown 可以继续被外部工具编辑；
- Nowen Note 会自动使用 Markdown 编辑器打开；
- 服务端负责派生 `contentText`、搜索索引和块索引。

不要把 Markdown 包装成单段纯文本 Tiptap JSON，也不需要调用 Markdown → Tiptap 转换接口。

---

## 更新笔记与乐观锁

更新标题、正文或内容格式时，需要携带当前笔记的 `version`：

```typescript
const current = await client.getNote(note.id);

const updated = await client.updateNote(note.id, {
  content: "# 更新后的标题\n\n这是新正文。",
  contentFormat: "markdown",
  version: current.version,
});

console.log(updated.version);
```

当其他客户端已经修改同一笔记时，服务端会返回 `409 VERSION_CONFLICT`。调用方应重新获取最新笔记，再决定合并、覆盖或提示用户。

只更新不需要版本保护的元数据时，可按接口允许的字段直接调用：

```typescript
await client.updateNote(note.id, { isPinned: 1 });
```

---

## 常用 API

### 笔记本

```typescript
const notebooks = await client.listNotebooks();
const notebook = await client.createNotebook({ name: "新笔记本" });
await client.updateNotebook(notebook.id, { name: "重命名" });
await client.deleteNotebook(notebook.id);
```

### 笔记

```typescript
const notes = await client.listNotes({ notebookId: "..." });
const note = await client.getNote("<note-id>");

await client.createNote({
  notebookId: "<notebook-id>",
  title: "Markdown 笔记",
  content: "# Hello",
  contentFormat: "markdown",
});

await client.updateNote(note.id, {
  title: "新标题",
  version: note.version,
});

await client.deleteNote(note.id);
```

### 标签与搜索

```typescript
await client.listTags();
await client.createTag({ name: "新标签", color: "#ff0000" });

const results = await client.search("React");
```

### AI 与任务

```typescript
const answer = await client.aiAsk({
  question: "什么是 useEffect？",
  notebookIds: ["..."],
});

await client.listTasks();
await client.createTask({ title: "新任务", priority: "high" });
```

---

## 完整示例：批量导入 Markdown

```typescript
import { NowenClient } from "nowen-sdk";

async function importNotes() {
  const client = new NowenClient({
    baseUrl: "http://localhost:3001",
    username: "admin",
    password: "admin123",
  });

  const notebook = await client.createNotebook({ name: "导入笔记" });
  const notes = [
    { title: "笔记 1", content: "# 笔记 1\n\n正文一" },
    { title: "笔记 2", content: "# 笔记 2\n\n正文二" },
  ];

  for (const item of notes) {
    await client.createNote({
      notebookId: notebook.id,
      title: item.title,
      content: item.content,
      contentFormat: "markdown",
    });
  }
}

await importNotes();
```

---

## 下一步

- [OpenAPI 接入指南](./api.md) — REST API 契约与 curl 示例
- [MCP Server 教程](./mcp.md) — AI 工具集成
- [CLI 工具教程](./cli.md) — 命令行操作
