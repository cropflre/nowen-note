# MCP Token 笔记本资源授权

> Issue #189 Phase 2～3：在服务端把 Personal API Token 限定到指定笔记本，并在设置页完成创建、编辑、审计和吊销。

## 安全模型

API Token 的最终权限取以下各项的交集：

```text
最终权限 = Token scopes ∩ Token 笔记本授权 ∩ 当前团队成员权限 ∩ 资源 ACL ∩ MCP 服务写入开关
```

- 用户本身没有权限的笔记本，不能授权给 Token；团队笔记本还要求当前仍是团队成员，viewer / commenter 只能授予只读。
- `scopes` 决定 Token 可以调用哪类 API，例如 `notes:read`、`notes:write`。
- 笔记本资源授权决定 Token 可以接触哪些具体笔记本。
- 团队成员身份、角色和资源 ACL 在每次请求时重新校验：被移出团队立即失去该团队的访问，降为只读成员后写入立即被拒绝。系统管理员身份、工作区所有者字段、资源作者字段和笔记本单独共享都不能代替团队成员身份。
- `restricted` Token 的资源列表为空时采用 fail-closed，所有笔记本访问均被拒绝。
- 服务端会校验直接通过 `noteId`、附件 ID 或 REST API 发起的请求，不能依赖 Agent 自觉传入筛选参数。笔记列表、全文搜索、块搜索和关系图在数据库查询阶段就限定在当前有效的授权笔记本内；反向链接、内部链接解析和附件引用同样不返回未授权笔记。

## 在设置页创建 Agent Token

进入：

```text
设置 → 连接 AI 助手 → 开发者访问令牌 → 创建令牌
```

普通用户可直接使用「设置 → 连接 AI 助手」，选择助手与笔记本（含团队笔记本）即可自动创建受限授权；所选笔记本全部只读时创建只读连接。下列手动配置用于开发者：

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

已吊销的 Token 会显示“删除”按钮。确认后永久移除令牌记录、授权配置和使用统计，独立审计日志保留；此操作无法恢复。未吊销的令牌（包括已过期令牌）需要先吊销，再删除。

接口保持区分：`DELETE /api/tokens/:id` 仍只吊销；`DELETE /api/tokens/:id/permanent` 永久删除本人已吊销的令牌。删除接口要求正常登录会话，不能使用 API Token 调用。

## MCP 配置

服务端已经保存笔记本资源授权时，MCP 只需配置 Token：

```json
{
  "mcpServers": {
    "nowen-investment": {
      "command": "node",
      "args": ["/home/user/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs"],
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

## 团队空间

- 快速连接（「设置 → 连接 AI 助手」）按「个人空间 / 与我共享 / 团队空间」分组展示可授权笔记本，团队笔记本默认不选中；`GET /api/tokens/notebook-options` 返回 `workspaceId`、`workspaceName`、`shared` 和按角色收紧后的 `canWrite`。
- restricted Token 调用 `GET /api/notebooks` 时返回全部授权笔记本（含团队），每项带 `workspaceName`、`space`（`personal` / `shared` / `workspace`）和 Token 实际可用的 `permission`；可用 `?workspaceId=` 过滤。
- 未指定空间的 `GET /api/notes`、`GET /api/search` 只在授权笔记本内查询，可跨个人与团队空间；指定 `workspaceId` 时再与该空间求交。
- 团队知识树写入只对显式授权团队笔记本的 restricted Token 开放：请求必须带 `workspaceId`，源节点、目标父节点及整个子树都必须属于该团队并在授权范围内，并保留预览版本、冲突检测、确认词和回收站语义。批量、权限和根目录操作仍被拒绝；`unrestricted` Token 仍不能修改团队知识树。
- Token 不能跨空间创建或挂载笔记本（`API_TOKEN_CROSS_SPACE_DENIED`），笔记和知识树节点的跨空间移动同样被拒绝。
- 团队根目录下的文档不属于任何笔记本，暂不能授权给 Token。

## 兼容策略

- 历史 Token 自动标记为 `unrestricted`，保持升级前行为，也不会因为团队授权功能获得团队目录写入等新能力。
- 已有 restricted Token 的授权表不做修改；升级后只是在每次请求时额外校验团队成员身份与角色，可能收窄、不会扩大实际范围。
- 新建 Token 可显式选择 `restricted`。
- restricted Token 空资源列表默认拒绝。
- JWT 登录会话不经过 Token 资源限制，继续使用现有用户和工作区 ACL。
- Token 可独立过期、吊销和审计，不需要修改用户密码。

## 审计事件

系统记录以下 Token 管理和使用事件：

- `api_token_created`、`api_token_resources_updated`（含授权涉及的空间 `spaces`）
- `api_token_revoked`
- `api_token_request`：包含 Token ID、方法、路径、状态码、结果 `result`（`allowed` / `failed` / `denied`）和涉及的资源空间 `spaces`（`personal` 或工作区 ID）。记录范围为：所有被拒绝的 Token 请求（级别 `warn`）、restricted Token 的写请求，以及 restricted Token 读取团队空间资源的请求。

审计日志不会保存 Token 明文、查询串或请求体（笔记正文）。
