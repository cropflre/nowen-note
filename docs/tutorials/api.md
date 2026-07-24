# OpenAPI 接入指南

> 通过 REST API 与 nowen-note 集成，构建 CLI、自动化脚本、AI Agent 或自定义客户端。

---

## API 概览

nowen-note 提供完整的 REST API。服务启动后可访问 `/api/openapi.json` 获取 OpenAPI 3.0 规范。

所有业务 API 均使用 JWT Token 认证。

## 认证

### 获取 Token

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | jq -r '.token')
```

后续请求添加：

```text
Authorization: Bearer <token>
```

---

## 笔记内容格式

笔记正文由 `content` 和 `contentFormat` 共同定义：

| `contentFormat` | `content` 内容 |
|---|---|
| `markdown` | Markdown 源文，推荐第三方工具使用 |
| `tiptap-json` | 序列化后的 Tiptap / ProseMirror JSON 字符串 |
| `html` | HTML 内容 |

`contentText` 是服务端从 `content` 派生的纯文本搜索字段，不是正文真源。第三方调用方创建或更新笔记时，应提交 `content` 和对应的 `contentFormat`，不要只写 `contentText`。

Markdown 笔记会在客户端中自动使用 Markdown 编辑器打开，不需要先转换为 Tiptap JSON，也不需要调用独立的格式转换 API。

---

## 示例：创建 Markdown 笔记

### 1. 创建笔记本

```bash
NOTEBOOK_ID=$(curl -s -X POST http://localhost:3001/api/notebooks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"API 测试"}' | jq -r '.id')
```

### 2. 创建笔记

```bash
curl -X POST http://localhost:3001/api/notes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg notebookId "$NOTEBOOK_ID" \
    --arg title "通过 API 创建的 Markdown 笔记" \
    --arg content $'# 标题\n\n正文 **加粗**\n\n- 第一项\n- 第二项' \
    '{
      notebookId: $notebookId,
      title: $title,
      content: $content,
      contentFormat: "markdown"
    }')"
```

服务端会自动生成 `contentText`，并维护搜索索引、块索引和内部链接等派生数据。

---

## 示例：更新 Markdown 笔记

更新标题、正文或内容格式时必须携带当前 `version`，用于乐观锁冲突保护。

```bash
NOTE_ID="<note-id>"
VERSION=$(curl -s http://localhost:3001/api/notes/$NOTE_ID \
  -H "Authorization: Bearer $TOKEN" | jq -r '.version')

curl -X PUT http://localhost:3001/api/notes/$NOTE_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg content $'# 更新后的标题\n\n这是新正文。' \
    --argjson version "$VERSION" \
    '{
      content: $content,
      contentFormat: "markdown",
      version: $version
    }')"
```

当服务端返回 `409 VERSION_CONFLICT` 时，应重新读取最新笔记和版本号，再由调用方决定重试或提示冲突。

---

## API 端点一览

### 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 登录 |
| GET | `/api/auth/verify` | 验证 Token |
| POST | `/api/auth/change-password` | 修改密码 |

### 笔记本

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/notebooks` | 获取笔记本列表 |
| POST | `/api/notebooks` | 创建笔记本 |
| PUT | `/api/notebooks/:id` | 更新笔记本 |
| DELETE | `/api/notebooks/:id` | 删除笔记本 |
| PUT | `/api/notebooks/:id/move` | 移动笔记本 |
| PUT | `/api/notebooks/reorder/batch` | 批量排序 |

### 笔记

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/notes` | 获取笔记列表 |
| GET | `/api/notes/:id` | 获取笔记详情 |
| POST | `/api/notes` | 创建笔记 |
| PUT | `/api/notes/:id` | 更新笔记；内容类更新需携带 `version` |
| DELETE | `/api/notes/:id` | 永久删除笔记 |

### 搜索、标签与任务

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/search?q=关键词` | 全文搜索 |
| GET / POST | `/api/tags` | 获取或创建标签 |
| PUT / DELETE | `/api/tags/:id` | 更新或删除标签 |
| GET / POST | `/api/tasks` | 获取或创建任务 |
| PUT | `/api/tasks/:id` | 更新任务 |

### 附件和文件

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/attachments` | 上传并绑定到笔记，表单字段为 `file`、`noteId` |
| GET | `/api/attachments/:id` | 下载或内联预览附件 |
| DELETE | `/api/attachments/:id` | 删除附件 |
| GET | `/api/files` | 文件管理列表 |
| GET | `/api/files/stats` | 文件统计 |
| GET | `/api/files/:id` | 文件详情和引用信息 |
| POST | `/api/files/upload` | 上传到文件管理 |
| PATCH | `/api/files/:id` | 重命名文件 |
| DELETE | `/api/files/:id` | 删除文件 |
| POST | `/api/files/batch-delete` | 批量删除文件 |

上传成功后返回的附件地址可以直接写入 Markdown：

```markdown
![截图](/api/attachments/<id>)
[下载 PDF](/api/attachments/<id>?download=1)
```

---

## SDK、CLI 和 MCP

- [TypeScript SDK](./sdk.md) — Node.js / TypeScript 集成
- [CLI 工具](./cli.md) — 命令行操作
- [MCP Server](./mcp.md) — Codex、Claude Desktop、Cursor 等 AI 工具集成

OpenAPI 规范是接口契约的最终参考；升级服务后建议重新读取 `/api/openapi.json`。