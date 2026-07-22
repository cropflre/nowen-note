# MCP Token 笔记本资源授权

> Issue #189 Phase 2～3：在服务端把 Personal API Token 限定到指定笔记本，并在设置页完成创建、编辑、审计和吊销。

## 安全模型

API Token 的最终权限取三者交集：

```text
最终权限 = 用户 ACL ∩ Token scopes ∩ Token 笔记本资源授权
```

- 用户本身没有权限的笔记本，不能授权给 Token。
- `scopes` 决定 Token 可以调用哪类 API，例如 `notes:read`、`notes:write`。
- 笔记本资源授权决定 Token 可以接触哪些具体笔记本。
- `restricted` Token 的资源列表为空时采用 fail-closed，所有笔记本访问均被拒绝。
- 服务端会校验直接通过 `noteId`、附件 ID 或 REST API 发起的请求，不能依赖 Agent 自觉传入筛选参数。

## 在设置页创建 Agent Token

进入：

```text
设置 → 个人访问令牌 → 创建令牌
```

建议配置：

1. 每个 Agent 创建独立 Token。
2. 资源范围选择“限定笔记本”。
3. 只需查询知识库时选择“只读”。
4. 需要创建或修改笔记时选择“读写”，并同时授予对应写入 scope。
5. 按需开启“自动包含子笔记本”。
6. 设置合理的过期时间；明文 Token 只显示一次。

创建后，设置页会展示：

- Token 当前状态
- scopes
- restricted / unrestricted 模式
- 已授权笔记本
- 每个笔记本的只读/读写权限
- 是否包含子笔记本
- 最近使用时间和 IP
- 使用量统计

未吊销的 Token 可以随时修改笔记本资源授权，不需要轮换明文。

## MCP 配置

服务端已经保存笔记本资源授权时，MCP 只需配置 Token：

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

`ALLOWED_NOTEBOOK_IDS` 仍可作为 MCP 实例侧的第二道限制。两者同时配置时，实际范围是服务端授权与本地白名单的交集。

## 知识库问答

restricted Token 调用 `nowen_ai_ask` 时必须指定 `notebookId`：

```text
nowen_ai_ask({
  question: "总结本笔记本中的投资策略",
  notebookId: "investment-notebook-id",
  includeChildren: true
})
```

- `notebookId` 必须属于 Token 授权范围。
- `includeChildren=true` 时，所有被检索的子笔记本也必须位于授权范围内。
- 未指定笔记本时，restricted Token 会拒绝请求，防止回答混入其他知识域。

## REST API 强制约束

资源授权不是 MCP 客户端侧过滤。使用同一个 Token 直接调用 REST API 时，以下入口同样受到服务端限制：

- 笔记本列表、读取、创建、移动和更新
- 笔记列表、搜索、读取、创建、更新、移动和删除
- 文件与附件列表、详情、上传和修改
- 标签读取及笔记标签关联
- 知识库问答
- 导入导出及其他受 scope 管理的能力

API Token 不能调用 Token 管理接口创建或扩张自己的权限，必须使用正常登录会话操作。

## 兼容策略

- 历史 Token 自动标记为 `unrestricted`，保持升级前行为。
- 新建 Token 可显式选择 `restricted`。
- restricted Token 空资源列表默认拒绝。
- JWT 登录会话不经过 Token 资源限制，继续使用现有用户和工作区 ACL。
- Token 可独立过期、吊销和审计，不需要修改用户密码。

## 审计事件

系统记录以下 Token 管理和使用事件：

- `api_token_created`
- `api_token_resources_updated`
- `api_token_revoked`
- `api_token_request`（写请求，包含 Token ID、方法、路径和状态）

审计日志不会保存 Token 明文。
