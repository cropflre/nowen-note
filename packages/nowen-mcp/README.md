# nowen-mcp

Nowen Note 的本地 stdio MCP Server，让支持 Model Context Protocol 的 AI 客户端在授权范围内搜索、读取和维护笔记。

> 完整用户教程：[中文安装指南](../../docs/tutorials/mcp.md) · [English guide](../../docs/tutorials/mcp.en.md)

## 要求

- Node.js 24.22.1+（24.x LTS）
- npm
- 一个可以从当前电脑访问的 Nowen Note 服务
- 推荐使用 restricted Personal API Token

## 从仓库安装

```bash
git clone https://github.com/cropflre/nowen-note.git
cd nowen-note/packages/nowen-mcp
npm install
npm run build
```

构建产物：

```text
dist/scoped-entry.js
```

该文件是稳定启动器加载的内部构建入口，不应直接配置给 MCP 客户端。

稳定启动器（客户端应配置这个文件）：

```text
bin/nowen-mcp.mjs
```

快速检查：

```bash
node ./bin/nowen-mcp.mjs
```

stdio Server 正常情况下会等待客户端输入并保持静默。没有立即退出或报错即说明脚本可以启动，按 `Ctrl+C` 结束。


## 启动诊断与运行日志

稳定启动器会在真正加载 `dist/scoped-entry.js` 之前检查 Node.js 版本、`NOWEN_URL` 和构建入口，并把结构化日志写入 **stderr**。stdout 仅用于 MCP stdio 协议，不会被普通日志污染。

常见错误会给出稳定错误码和解决建议：

- `ENTRY_NOT_FOUND`：执行 `npm install && npm run build`；
- `DEPENDENCY_NOT_FOUND`：依赖或构建产物不完整，重新安装并构建；
- `INVALID_NOWEN_URL`：修正服务地址；
- `uncaught_exception` / `unhandled_rejection`：日志包含完整 stack；
- `stdin_closed` / `shutdown_signal`：明确记录父进程关闭或信号退出。

调试长会话时可选开启心跳，默认关闭：

```text
NOWEN_MCP_HEARTBEAT_MS=300000
```

心跳只写 stderr，并包含 PID、运行时长和内存使用；允许范围为 10000～86400000 毫秒。
## 最小客户端配置

```json
{
  "mcpServers": {
    "nowen-note": {
      "command": "node",
      "args": [
        "/absolute/path/to/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs"
      ],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

必须替换：

- `args` 中的脚本绝对路径；
- `NOWEN_URL`；
- `NOWEN_API_TOKEN`。

Windows JSON 路径示例：

```json
"C:\\Users\\YourName\\nowen-note\\packages\\nowen-mcp\\bin\\nowen-mcp.mjs"
```

Linux、macOS 和 WSL 必须填写以 `/` 开头的真实绝对路径，例如 `/home/user/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs`，不能省略开头的 `/`。

VS Code 的 `.vscode/mcp.json` 使用顶层 `servers` 字段：

```json
{
  "servers": {
    "nowen-note": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs"
      ],
      "env": {
        "NOWEN_URL": "http://192.168.1.20:3001",
        "NOWEN_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

## Claude Code

```bash
claude mcp add nowen-note --scope user \
  --env NOWEN_URL=http://192.168.1.20:3001 \
  --env NOWEN_API_TOKEN=nkn_xxx \
  -- node /home/user/nowen-note/packages/nowen-mcp/bin/nowen-mcp.mjs
```

验证：

```bash
claude mcp get nowen-note
claude mcp list
```

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `NOWEN_URL` | Nowen Note 服务地址 | `http://localhost:3001` |
| `NOWEN_API_TOKEN` | Personal API Token | — |
| `NOWEN_USERNAME` | 可选显式用户名认证 | 不设置 |
| `NOWEN_PASSWORD` | 可选显式密码认证 | 不设置 |
| `ALLOWED_NOTEBOOK_IDS` | MCP 本地笔记本白名单，逗号分隔 | 未启用 |
| `MCP_ACCESS_MODE` | `read-only` 或 `read-write` | `read-write` |
| `MCP_ENABLE_DANGEROUS_TOOLS` | 是否开放插件执行、工作流运行、Webhook 创建、备份创建 | `false` |
| `MCP_INCLUDE_DESCENDANTS` | 本地白名单是否包含子笔记本 | `false` |
| `NOWEN_MCP_HEARTBEAT_MS` | 可选 stderr 心跳间隔（毫秒），0/off 关闭 | `0` |

认证优先级：

1. `NOWEN_API_TOKEN`
2. `NOWEN_USERNAME` + `NOWEN_PASSWORD`

## 常用命令

```bash
npm run dev
npm run build
npm start
npm test
```

- `npm run dev`：监听源码并启动开发 Server。
- `npm run build`：编译到 `dist/`。
- `npm start`：运行已构建的 Server。
- `npm test`：构建并执行作用域策略测试。

## 更新

```bash
git pull
cd packages/nowen-mcp
npm install
npm run build
```

更新后重启 MCP 客户端或在客户端中 Restart Server。

## 安全建议

- 每个 AI 客户端使用独立 Token。
- 先用只读 Token 验证，再按需增加写权限。
- 不要把 Token 提交到 Git 仓库。
- `NOWEN_URL` 指向 NAS 时，先从客户端电脑浏览器验证地址可访问。
- 权限结果为：用户 ACL、Token scopes、Token 笔记本授权以及本地 MCP 白名单的交集。

## v1.5.2 MCP 能力扩展

新增以下 MCP 工具，均复用原有 REST 业务逻辑和服务端 ACL：

| 能力 | MCP 工具 |
| --- | --- |
| 个人任务更新 | `nowen_update_task` |
| 创建个人子任务 | `nowen_create_subtask` |
| 完成后的任务树归档/恢复 | `nowen_archive_task` |
| 个人项目 | `nowen_list_task_projects`、`nowen_create_task_project`、`nowen_update_task_project` |
| 任务与个人项目关联 | `nowen_assign_task_project` |
| 笔记元数据 | `nowen_set_note_flags`（收藏/置顶） |
| 安全移动笔记 | `nowen_move_note`（默认预览；实际操作必须传入预览版本） |
| 统一知识树查询 | `nowen_get_knowledge_tree`（只读；可按工作区查询） |

### 重要权限说明

- 任务和项目工具使用 `tasks:read` / `tasks:write` Token scopes，且 **只支持本人个人空间**。创建子任务、关联项目时，后端会核对父任务和项目实际归属。
- 知识树查询使用 `notebooks:read`，restricted Token 只返回授权笔记本以及所允许的子树。未授权节点及对应笔记的密码授权元数据不会返回。
- 笔记移动依赖 `notes:write`，当前源笔记与目标笔记本必须都有权限。执行前先调用 `nowen_move_note`（省略 `dryRun`），随后在确认移动方案后提交 `dryRun=false` 和 `expectedVersion`。发生版本冲突时重新预览。
- `MCP_ACCESS_MODE=read-only` **独立于** `ALLOWED_NOTEBOOK_IDS` 生效；本地白名单未设置时也会拦截写入请求。仅受限知识库问答和登录认证用途的 POST 例外；AI Chat 可能触发副作用，因此也会被阻止。
- 系统级自动化、Webhook、备份、管理员操作仍遵循已有 Token 权限约束；restricted Token 不会因为此次扩展获得这些权限。
- P2 已增加**独立、默认关闭的 Streamable HTTP 网关**及个人工作流预览/执行，**没有**开放公网直连、系统级事件重放、任意插件自动执行或团队自动化操作；跨客户端真实部署仍需验收。

### 开发验证

```bash
cd packages/nowen-mcp
npm ci
npm test
```

GitHub Actions 见 `.github/workflows/mcp-scope-and-tools-ci.yml`。

## P0 安全能力与集成验收

### 知识树安全闭环

新增 `nowen_preview_knowledge_tree_change` 与 `nowen_apply_knowledge_tree_change`：

1. 先用预览工具选择 `create`、`rename`、`move`、`trash`、`restore`，查看标题、目标目录、受影响节点数、`revision`（移动、删除、恢复还返回 `subtreeRevision`）。
2. 向用户确认操作对象和范围；**AI 返回预览并不代表用户已经授权执行**。
3. 再用执行工具传入完全相同的参数、预览生成的 `expectedRevision`、必要的 `expectedSubtreeRevision`，以及明确的 `confirmation`。删除使用 `MOVE_TREE_TO_TRASH`，恢复使用 `RESTORE_TREE`，其他使用 `APPLY_TREE_CHANGE`。
4. 后端检查父目录、当前节点、所有后代的授权和预览版本；不符返回 403/409，必须重新预览。删除始终进入可恢复的回收站，绝不执行永久删除。

P0 仅支持**本人个人空间**内普通文件夹和 Markdown 笔记的创建、重命名、移动、软删除、恢复。受限 PAT 必须授予 `notebooks:read`、`notebooks:write`，操作笔记还需要 `notes:write`；本地白名单适用时，在受限文件夹下创建/恢复子目录还需要 `MCP_INCLUDE_DESCENDANTS=true`。跨工作区、高级文件类型、批量删除、权限管理不属于此阶段。

### 笔记删除及账号安全

- `nowen_delete_note` 默认预览。执行软删除需提供 `dryRun=false`、匹配的 `expectedVersion` 和 `confirmation=MOVE_TO_TRASH`。设置 `permanent=true` 总是被拒绝；永久删除只能通过主应用回收站完成。
- `MCP_ACCESS_MODE=read-only` 即使没有配置 `ALLOWED_NOTEBOOK_IDS` 也会拒绝写入；同时拒绝可能触发插件和任务副作用的 AI Chat。
- **不再默认使用 `admin/admin123` 登录**。推荐 `NOWEN_API_TOKEN`，或者同时显式设置 `NOWEN_USERNAME` 与 `NOWEN_PASSWORD`。PAT 无效时不会回退到账号密码。
- 插件执行、工作流手动运行、Webhook 创建及备份创建等外部/管理副作用工具默认关闭；仅管理员充分审查 Token 权限与 MCP 客户端授权流程后，才可以显式设置 `MCP_ENABLE_DANGEROUS_TOOLS=true`。此开关不是服务端授权的替代，Token scopes 和 ACL 仍会执行。
- 预览修订值、确认字符串是操作安全防线，不是用户身份验证；实际人机确认仍由 MCP 宿主客户端提供，服务端会独立验证 ACL 与 Token grants。

### 已自动化验证的 P0 场景

`npm test` 包含：MCP 构建、笔记本范围和只读策略、被删除子目录授权、修订指纹/子树冲突、真实 MCP SDK stdio 客户端调用（使用隔离的模拟 HTTP 后端）。CI 中另运行真实知识树路由 + SQLite 的 API Token 集成测试，覆盖越权节点、未授权目标、预览冲突、回收站删除/恢复。**仍需要在实际 Claude Desktop/Codex 客户端、真实账号和多端同步环境执行发布验收。**

## v1.5.2 P1：个人网盘与任务成果复盘

本阶段新增以下 **8 个** MCP 工具，复用既有网盘 API 与任务快照业务服务，不另建文件存储与任务数据库：

| 功能 | MCP 工具 |
| --- | --- |
| 网盘文件夹列表 | `nowen_list_file_folders` |
| 网盘文件搜索、分页 | `nowen_list_managed_files` |
| 文件回收站 | `nowen_list_file_trash` |
| 网盘整理预览 | `nowen_preview_file_change` |
| 网盘整理执行 | `nowen_apply_file_change` |
| 任务成果转笔记预览 | `nowen_preview_task_to_note` |
| 任务成果转笔记执行 | `nowen_save_task_to_note` |
| 单任务顺序调整 | `nowen_reorder_task` |

### 网盘整理的傻瓜式流程

1. 通过 `nowen_list_file_folders`、`nowen_list_managed_files` 查看文件与目录；通过 `nowen_list_file_trash` 查看回收站。
2. 调用 `nowen_preview_file_change` 选择 `create_folder`、`update_folder`、`rename_file`、`move_files`、`restore_files`。其中 `update_folder` 支持仅改名、仅移动或同时调整；`move_files` 单次最多 50 个，`parentId=null` 表示未归档。
3. AI 将预览结果（文件名、数量、源目录、目标目录）展示给用户，**仅在宿主客户端获得明确授权后**，传同一组参数、`expectedRevision` 和 `confirmation` 调用 `nowen_apply_file_change`。恢复必须使用 `RESTORE_FILES`，其他使用 `APPLY_FILE_CHANGE`。
4. 后端再次校验 Token scopes、用户归属、源文件夹/名称或回收站时间。如果数据变化，返回 409，AI 必须重新预览。网盘目录同步尚未完成时不得强行写入。

**网盘安全约束**：由于现有 `attachment_folders` 是用户级数据、没有笔记本资源字段，网盘 MCP 工具**必须使用未绑定 `ALLOWED_NOTEBOOK_IDS` 的个人 API Token**。受限笔记本资源的 Token 暂不能访问网盘目录，防止跨笔记本泄露；建议新建仅包含 `notes:read`、`attachments:write` 的专用个人 Token，避免与普通笔记 Agent 共用。只允许管理 `uploadSource=file_manager`、归属于本人个人空间的文件；禁止跨团队操作、永久清理、直接整理编辑器附件。无需也不允许为此放开 `MCP_ENABLE_DANGEROUS_TOOLS`。

### 任务成果与排序

- `nowen_preview_task_to_note` 会读取任务的现有标题、Markdown 详情、最后修改时间，预览保存位置。用户确认后调用 `nowen_save_task_to_note` 并传 `expectedRevision` 与 `confirmation=SAVE_TASK_NOTE`；后端验证个人任务归属、目标笔记本写权限及任务未被修改，并使用幂等请求号。**原任务不删除、不转移；附件由现有服务安全复制，笔记可独立保存**。
- `nowen_reorder_task` 默认预览；确认后传 `dryRun=false`、`expectedUpdatedAt`、`expectedSortOrder`、`confirmation=REORDER_TASK`。单任务排序不会改变父子关系和项目归属。
- 这些功能使用 `tasks:read`/`tasks:write` 和笔记快照所需的 `notes:write` scopes。restricted Token 保存任务笔记时，还必须对目标笔记本具有写入授权。首次运行建议用非正式数据检验多端同步。

### 验证与边界

专项 CI 包括真实 MCP SDK stdio 客户端 + 隔离 HTTP 后端的 P1 端到端调用，以及后端 API Token 安全测试。涉及文件位置、名称和回收站恢复的预览冲突均必须阻止危险操作。**P1 未开放跨空间文件搬运、自动永久删除、全量批量操作以及会破坏原笔记附件引用关系的重写**。正式发布仍需 Windows/macOS/Android 及浏览器实际回归。

## P2：自动化管理、HTTP 网关与可视化连接中心

新增 5 个 MCP 工具：

- `nowen_get_workflow`：读取个人工作流详情、版本和触发规则
- `nowen_list_workflow_runs`：读取该工作流的运行历史
- `nowen_preview_workflow_change`：预览创建、编辑、启停和删除，返回修订指纹
- `nowen_apply_workflow_change`：用户确认后执行，后端再次验证 Token ACL 和修订版本
- `nowen_mcp_diagnostics`：查看传输模式、只读状态与危险操作授权情况（不输出密钥）

管理个人自动化的 PAT 需要新增的 `automations:read`、`automations:write` scopes。所有 PAT 无论 restricted/unrestricted 都只能读取、修改**自己创建的个人工作流**。系统状态、工作区自动化、事件重放、直接手动运行等端点不由此开放。新增工作流默认禁用；更新前必须先停用。含插件 Action 或 Webhook 的定义要求 `MCP_ENABLE_DANGEROUS_TOOLS=true` 明确开启，且仍由后端校验插件是否存在。删除需要 `DELETE_WORKFLOW` 确认。**应当在 MCP 宿主客户端显示预览并征得用户明确同意，模型自行填写确认词不等于人工批准。**

### 远程 Streamable HTTP（默认关闭）

`npm run start:http` 只有在提供单独网关密钥及 Nowen PAT 时才会启动。

```bash
cd packages/nowen-mcp
npm ci
npm run build
export NOWEN_URL="http://127.0.0.1:3001"
export NOWEN_API_TOKEN="nkn_your_personal_api_token"
export NOWEN_MCP_HTTP_TOKEN="$(openssl rand -hex 32)"
export MCP_ACCESS_MODE="read-only"
export NOWEN_MCP_HTTP_HOST="127.0.0.1"
export NOWEN_MCP_HTTP_PORT="3133"
npm run start:http
```

随后可在本机用 `http://127.0.0.1:3133/mcp` 连接 MCP 客户端，在请求头发送 `Authorization: Bearer <NOWEN_MCP_HTTP_TOKEN>`。这个**独立网关密钥不是 Nowen PAT**，不可互相替代。服务器固定绑定回环地址；从公网使用时，请在可信的 HTTPS 反向代理（含 Host 转发和认证控制）之后暴露 `/mcp`，**不可直接绑定 0.0.0.0**。如果使用浏览器 Origin 请求，须明确配置 `NOWEN_MCP_HTTP_ALLOWED_ORIGINS` 精确域名列表；默认拒绝所有带 Origin 的请求。

默认只读；如确需写入，必须同时设置 `MCP_ACCESS_MODE=read-write` 和 `NOWEN_MCP_HTTP_ALLOW_WRITE=true`。建议始终先创建短期、最小权限 PAT，浏览器和其他代理不能共享该 Token。服务端限制 Host、Origin、请求体积，并提供非认证健康探测 `/health`（只报告服务活性，不泄露凭据）。HTTP 使用 **stateless JSON response** 模式，不支持会话恢复及服务端主动推送事件；后续若需长连接或公网多用户 OAuth，必须另做权限隔离方案。

### 可视化管理入口

设置 → 访问令牌 → **MCP 连接中心**。可选择 stdio/Streamable HTTP 示例，复制客户端 JSON 配置，检测 Nowen 后端连通性；下方直接复用原有 PAT 创建、笔记本授权、吊销与使用统计。示例中的秘钥均为占位符，本页面不会保存 Token 或私密密钥。HTTP 网关的启停与 TLS/反向代理由服务器运维管理，并不由网页设置直接更改系统环境变量。

### 自动化验收范围

CI 运行 HTTP 网关认证/Origin/Host/超大负载测试、后端 PAT 所有权/启停/并发版本测试，以及原有 P0/P1 MCP stdio 协议测试。真实多客户端并发、HTTPS 代理和全部桌面/移动端联调尚未执行，不应将专项 CI 通过误认为已经可以合并整个 v1.5.2。

## 发行说明

当前仓库保证的是源码构建方式。除非 Nowen Note 的 Release 或官方文档明确宣布 npm / DXT 包，避免假设 `npx nowen-mcp` 或一键 DXT 已经可用。
