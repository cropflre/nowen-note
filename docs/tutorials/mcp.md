# MCP Server 使用教程

> 通过 MCP 协议让 AI 助手直接操作你的 nowen-note 笔记库。

---

## 安装

```bash
cd packages/nowen-mcp
npm install
npm run build
npm test
```

---

## 推荐配置：服务端 restricted Token

进入 Nowen Note：

```text
设置 → 个人访问令牌 → 创建令牌
```

为每个 Agent 创建独立 Token，并设置：

- 能力 scopes，例如 `notes:read`、`notes:write`；
- 资源范围选择“限定笔记本”；
- 每个笔记本配置“只读”或“读写”；
- 按需开启“自动包含子笔记本”；
- 设置合理过期时间。

服务端最终权限为：

```text
用户 ACL ∩ Token scopes ∩ Token 笔记本资源授权
```

restricted Token 即使被拿去绕过 MCP 直接调用 REST API，也不能访问未授权笔记本。历史 Token 默认保持 `unrestricted`，兼容升级前行为。

详细设计参见：[MCP Token 笔记本资源授权](./mcp-token-resource-scope.md)。

---

## MCP 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `NOWEN_URL` | 服务器地址 | `http://localhost:3001` |
| `NOWEN_API_TOKEN` | Personal API Token；配置后优先于用户名密码 | — |
| `NOWEN_USERNAME` | 兼容旧配置的登录用户名 | `admin` |
| `NOWEN_PASSWORD` | 兼容旧配置的登录密码 | `admin123` |
| `ALLOWED_NOTEBOOK_IDS` | MCP 实例侧的第二道笔记本白名单，逗号分隔；显式空值代表拒绝全部 | 未启用本地作用域 |
| `MCP_ACCESS_MODE` | `read-only` 或 `read-write` | `read-write` |
| `MCP_INCLUDE_DESCENDANTS` | 本地白名单是否包含全部子笔记本 | `false` |

认证优先级：

1. `NOWEN_API_TOKEN`
2. `NOWEN_USERNAME` + `NOWEN_PASSWORD`

服务端 restricted Token 已经保存资源范围时，最简配置如下：

```json
{
  "mcpServers": {
    "nowen-investment": {
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

也可以叠加 MCP 本地白名单作为第二道限制：

```json
{
  "mcpServers": {
    "nowen-charging": {
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

两层同时启用时，实际范围是服务端授权与本地白名单的交集。

---

## 安全行为

### 服务端 Token 资源防火墙

restricted Token 会在所有受保护 REST API 上强制执行资源范围：

- 笔记本列表、详情、创建、更新和移动；
- 笔记列表、搜索、详情、创建、更新、移动和删除；
- 文件与附件列表、详情、上传和修改；
- 标签读取以及笔记标签关联；
- 知识库问答；
- scope 管理的导入导出能力。

通过 `noteId` 或附件 ID 直接访问时，服务端会反查所属笔记本再校验，不能通过猜测 ID 绕过。

API Token 不能调用 Token 管理接口创建或扩张自己的权限。授权变更必须使用正常登录会话完成。

### MCP 实例侧防火墙

配置 `ALLOWED_NOTEBOOK_IDS` 后，MCP 还会执行一层本地校验：

- 列表和搜索结果与本地白名单取交集；
- 读写笔记前反查所属笔记本；
- 移动笔记时校验原笔记和目标笔记本；
- `read-only` 拒绝创建、更新、删除、上传和标签变更；
- 显式空白名单采用 fail-closed；
- 无法映射到笔记本的备份、审计、Webhook、插件等全局能力默认拒绝。

---

## 可用工具

### 笔记本

| 工具 | 说明 |
|---|---|
| `nowen_list_notebooks` | 列出当前 Token 可以访问的笔记本 |
| `nowen_create_notebook` | 创建笔记本；restricted 模式下需拥有目标父笔记本写权限 |

### 笔记

| 工具 | 说明 |
|---|---|
| `nowen_list_notes` | 列出授权范围内的笔记 |
| `nowen_read_note` | 读取笔记，服务端会根据 `noteId` 校验笔记本范围 |
| `nowen_create_note` | 在拥有写权限的笔记本创建笔记 |
| `nowen_update_note` | 更新授权范围内笔记 |
| `nowen_delete_note` | 删除授权范围内笔记 |

### 搜索

| 工具 | 说明 |
|---|---|
| `nowen_search` | 全文搜索，结果自动限定在 Token 和本地白名单交集中 |

### 附件

| 工具 | 说明 |
|---|---|
| `nowen_upload_attachment` | restricted 模式必须绑定到有写权限的笔记 |
| `nowen_list_attachments` | 只返回授权笔记本中的附件 |
| `nowen_attach_to_note` | 将附件插入有写权限的 Markdown 笔记 |

### 标签

| 工具 | 说明 |
|---|---|
| `nowen_list_tags` | restricted Token 只返回授权笔记关联的标签 |
| `nowen_manage_tags` | 只允许修改授权范围内笔记的标签关联 |

### AI

| 工具 | 说明 |
|---|---|
| `nowen_ai_ask` | 按指定笔记本进行知识库问答 |
| `nowen_ai_process` | AI 处理调用方直接提供的文本 |
| `nowen_knowledge_stats` | 未限定到笔记本的全局统计在本地 scoped 模式下默认拒绝 |

restricted Token 调用知识库问答时必须指定笔记本：

```text
nowen_ai_ask({
  question: "总结该知识库的投资策略",
  notebookId: "investment-notebook-id",
  includeChildren: true
})
```

`includeChildren=true` 时，涉及的子笔记本也必须属于授权范围；否则服务端拒绝请求。

---

## 常见问题

### 所有笔记本请求都被拒绝

检查以下两处：

1. 设置页中 restricted Token 是否配置了至少一个笔记本；
2. MCP 环境中是否显式配置了空的 `ALLOWED_NOTEBOOK_IDS`。

两者都是 fail-closed 设计。

### 读操作成功但写操作被拒绝

需要同时满足：

- 用户本人对该笔记本具有写权限；
- Token 包含对应写 scope，例如 `notes:write`；
- Token 对该笔记本的资源权限设置为“读写”；
- 本地 MCP 未设置为 `MCP_ACCESS_MODE=read-only`。

### 子笔记本没有显示

服务端授权中开启“自动包含子笔记本”；使用本地白名单时还需设置：

```env
MCP_INCLUDE_DESCENDANTS=true
```

### 知识库问答提示必须指定 notebookId

restricted Token 不允许无范围的全库问答。调用 `nowen_ai_ask` 时明确传入目标笔记本 ID。

### 工具没有出现

确认 MCP Server 已重新构建，并重启 Claude Desktop、Cursor 或其他 MCP 客户端。

---

## 下一步

- [MCP Token 笔记本资源授权](./mcp-token-resource-scope.md)
- [OpenAPI 接入指南](./api.md)
- [SDK 使用教程](./sdk.md)

> 本教程已覆盖 Issue #189 的 MCP 本地作用域、服务端 Token 资源强制校验和管理 UI。
