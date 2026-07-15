# MCP Server 使用教程

> 通过 MCP 协议让 AI 助手直接操作你的 nowen-note 笔记库。

---

## 什么是 MCP？

MCP（Model Context Protocol）是一种让 AI 助手连接外部工具的协议。通过 MCP Server，AI 助手（如 Claude Desktop、Cursor 等）可以直接读写你的 nowen-note 笔记。

---

## 安装

```bash
cd packages/nowen-mcp
npm install
npm run build
npm test
```

---

## 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `NOWEN_URL` | 服务器地址 | `http://localhost:3001` |
| `NOWEN_API_TOKEN` | Personal API Token；配置后优先于用户名密码 | — |
| `NOWEN_USERNAME` | 兼容旧配置的登录用户名 | `admin` |
| `NOWEN_PASSWORD` | 兼容旧配置的登录密码 | `admin123` |
| `ALLOWED_NOTEBOOK_IDS` | MCP 可访问的笔记本 ID，多个 ID 用逗号分隔；显式配置为空时拒绝全部笔记本 | 未启用作用域 |
| `MCP_ACCESS_MODE` | `read-only` 或 `read-write` | `read-write` |
| `MCP_INCLUDE_DESCENDANTS` | 是否包含白名单笔记本的全部子笔记本 | `false` |

认证优先级：

1. `NOWEN_API_TOKEN`
2. `NOWEN_USERNAME` + `NOWEN_PASSWORD`

建议为每个 Agent 创建独立 API Token，不要让多个 Agent 共用 admin 密码。

### 在 Claude Desktop 中配置

不限制笔记本范围的兼容配置：

```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "node",
      "args": ["/path/to/nowen-mcp/dist/scoped-entry.js"],
      "env": {
        "NOWEN_URL": "http://localhost:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

只允许充电 Agent 访问指定笔记本：

```json
{
  "mcpServers": {
    "nowen-note-charging": {
      "command": "node",
      "args": ["/path/to/nowen-mcp/dist/scoped-entry.js"],
      "env": {
        "NOWEN_URL": "http://localhost:3001",
        "NOWEN_API_TOKEN": "nkn_xxx",
        "ALLOWED_NOTEBOOK_IDS": "charging-notebook-id",
        "MCP_ACCESS_MODE": "read-write",
        "MCP_INCLUDE_DESCENDANTS": "true"
      }
    }
  }
}
```

只读 Agent：

```json
{
  "env": {
    "NOWEN_API_TOKEN": "nkn_xxx",
    "ALLOWED_NOTEBOOK_IDS": "knowledge-base-id",
    "MCP_ACCESS_MODE": "read-only"
  }
}
```

---

## 笔记本作用域安全模型

配置 `ALLOWED_NOTEBOOK_IDS` 后，MCP 入口会安装统一的请求作用域防火墙：

- 笔记本、笔记、搜索结果和附件列表只返回白名单范围内的数据。
- 通过 `noteId` 读取、更新或删除前，会先反查笔记所属笔记本并校验。
- 创建笔记和上传附件时，目标笔记必须属于白名单。
- 移动笔记时，原笔记和目标笔记本都必须在白名单内。
- `read-only` 模式拒绝创建、更新、删除、上传和标签变更。
- 显式设置空白名单时采用 fail-closed 行为，拒绝所有笔记本访问。
- 工具传入的 `notebookId` 只能缩小范围，不能扩大环境变量配置的白名单。

当前 MCP 侧作用域会安全禁用无法可靠限定到笔记本的全局能力，包括：

- 全知识库 `nowen_ai_ask`
- 全局标签列表和标签创建
- 备份、审计、Webhook、插件及其他未授权系统端点
- 未绑定笔记的文件管理上传

`nowen_ai_process` 仅处理调用方直接传入的文本，不检索知识库，因此在 scoped MCP 中仍可使用。

> 说明：本地 MCP 作用域可以保护通过该 MCP 实例发出的请求。后续仍应在后端实现 Token 与笔记本资源绑定，才能保证同一 Token 被拿去直接调用 REST API 时也无法越过资源范围。

---

## 可用工具

MCP Server 提供多组工具：

### 笔记本

| 工具 | 说明 |
|---|---|
| `nowen_list_notebooks` | 列出所有笔记本；scoped 模式下自动过滤 |
| `nowen_create_notebook` | 创建笔记本；scoped 模式下仅允许在白名单父笔记本下创建子笔记本 |

### 笔记

| 工具 | 说明 |
|---|---|
| `nowen_list_notes` | 列出笔记 |
| `nowen_read_note` | 读取笔记 |
| `nowen_create_note` | 创建笔记 |
| `nowen_update_note` | 更新笔记 |
| `nowen_delete_note` | 删除笔记 |

### 搜索

| 工具 | 说明 |
|---|---|
| `nowen_search` | 全文搜索笔记；scoped 模式下结果与白名单取交集 |

### 附件

| 工具 | 说明 |
|---|---|
| `nowen_upload_attachment` | 上传本地文件；scoped 模式必须绑定作用域内笔记 |
| `nowen_list_attachments` | 列出文件管理中的附件，支持按笔记、类型、关键词等筛选 |
| `nowen_attach_to_note` | 把已上传附件插入指定 Markdown 笔记 |

### 标签

| 工具 | 说明 |
|---|---|
| `nowen_list_tags` | 列出标签；scoped 模式暂时拒绝全局标签列表 |
| `nowen_manage_tags` | 管理标签；scoped 模式仅允许对作用域内笔记添加或移除标签 |

### AI

| 工具 | 说明 |
|---|---|
| `nowen_ai_ask` | 全知识库问答；scoped 模式暂时禁用 |
| `nowen_ai_process` | AI 处理调用方提供的文本 |
| `nowen_knowledge_stats` | 知识库统计；scoped 模式不授权全局统计端点 |

### 任务与系统工具

未配置笔记本作用域时，现有任务、插件、Webhook、审计和备份工具保持兼容行为。配置作用域后，这些无法映射到指定笔记本的全局端点默认拒绝访问。

---

## 使用示例

配置好 MCP Server 后，在 AI 助手中可以这样对话：

- “帮我列出当前 Agent 可以访问的笔记本”
- “搜索包含 React 的笔记”
- “在这个笔记本创建一篇标题为《学习计划》的笔记”
- “把 `C:\Users\me\Pictures\screenshot.png` 上传并插入到这篇笔记”
- “列出这篇笔记引用过的附件”

### 上传图片并插入笔记

AI 助手会按这个流程调用工具：

1. `nowen_upload_attachment` 上传本地图片，传入 `filePath` 和 `noteId`
2. 获取返回的 `/api/attachments/<id>` URL
3. 如需插入已有附件，调用 `nowen_attach_to_note`，生成 Markdown 图片语法

`nowen_attach_to_note` 只处理 Markdown 笔记；如果目标笔记是富文本 JSON，请先在客户端转换或改用编辑器上传。

---

## 常见问题

### Q：连接失败？

1. 确认 nowen-note 服务器正在运行。
2. 检查 `NOWEN_URL` 是否正确。
3. 使用 Token 时确认 Token 未过期、未吊销，并拥有对应 API scopes。
4. 使用用户名密码时检查账号密码是否正确。

### Q：所有笔记本请求都被拒绝？

检查是否配置了空的 `ALLOWED_NOTEBOOK_IDS`。该变量一旦显式存在，即启用作用域；空值代表拒绝全部访问。

### Q：子笔记本没有显示？

将 `MCP_INCLUDE_DESCENDANTS` 设置为 `true`，并确认 Token 对这些笔记本本身也具有后端 ACL 权限。

### Q：为什么知识库问答在 scoped 模式不可用？

当前后端知识库问答还不能可靠接收笔记本白名单。为避免回答混入其他笔记本内容，MCP 采用 fail-closed 策略。后端支持资源级 Token 作用域后再开放。

### Q：工具没有出现？

确认 MCP Server 已正确配置并重启了 AI 助手。

---

## 下一步

- [OpenAPI 接入指南](./api.md) — REST API
- [SDK 使用教程](./sdk.md) — TypeScript SDK

---

> 本教程已包含 Issue #189 的 MCP 侧笔记本作用域 MVP。后端资源级 Token 强制范围仍需后续实现。
