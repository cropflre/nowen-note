# Docker 内置 MCP

同域入口：客户端 → `POST /mcp` → 每请求 MCP Server/API Client → `app.fetch(/api/...)` → 现有认证、Token scope、笔记本资源授权及 ACL → 现有数据服务。

## 复用边界

- `packages/nowen-mcp/src/embedded-http.ts` 复用工具注册与 API Client，使用 SDK 的 Web Standard Streamable HTTP Transport，无会话、JSON 响应。
- `backend/src/mcp.ts` 管理可选入口、请求大小、Host/Origin 校验、PAT 认证及默认只读限制。
- `Dockerfile` 单独构建 MCP，把生产依赖与产物复制到 `/app/packages/nowen-mcp`；不增加端口、子进程或后台守护服务。
- 后端保持 CommonJS，以原生 ESM 动态导入已打包的 MCP 入口。未包含产物的安装报告 `available=false`，不影响独立 stdio/HTTP。
- 服务配置存入 `system_settings.mcp_server_config`；只允许管理员登录会话修改。个人授权继续使用已有 Token 管理，无新增凭据表或明文 Token 副本。

## 身份与权限

每个请求独立创建客户端，显式传入自己的 Token、fetch 和运行时策略。不导入会修改全局 fetch 的 `scoped-fetch`，不修改 `process.env`，不缓存跨请求身份。
内部 fetch 只允许固定的 `http://localhost/api/` 目标，实际在进程内路由，不经过公网或代理；重新构建请求头，并强制绑定原始请求的 Token。
每次 REST 请求重新验证 scopes 和资源授权，不借用管理员权限、登录 Cookie、全局 Token 或账号密码。

写权限是服务允许写入、Token scopes、资源授权及用户 ACL 的交集。未配置时服务和写入均关闭；管理员在快速连接中点击「连接」会开启服务与写入。管理员仍可通过设置 API 关闭写入，此时只允许 GET/HEAD/OPTIONS 的内部 API 请求，并限制进行中工具的后续 API 调用。
服务器本地路径、危险工具保持禁用，不受独立 MCP 的危险工具环境变量影响。

对外 Host 必须匹配管理员保存的 MCP URL（回环 Host 可用于本机）；Origin 只允许该公开 origin 或匹配的本机 origin。
反向代理应保留公开 Host。公网使用 HTTPS；仅 Bearer Header 认证，不提供 OAuth 授权发现。
请求上限 1 MiB，方法 POST；GET/DELETE 返回 405，无常驻 SSE、会话复用或恢复事件存储。
服务健康不参与主应用健康判定；设置状态报告运行时是否存在、开关与写入状态，连接检测验证真实协议。

## 验证

主界面只呈现一个助手下拉框、笔记本选择与「连接」，不展示协议、Token、JSON 或高级折叠项。
助手下拉框按「国内助手 / 其他助手」分组，不增加新的设置面板。国内选项包括 WorkBuddy、CodeBuddy Code、TRAE 国内版、Qoder、Kimi Code 和 Qwen Code；保留 Claude Code、Cursor、Codex。
`mcpConnections.ts` 复用现有 `/api/tokens` 和 `/api/mcp`，默认全选当前可授权的笔记本，也可通过「全部笔记」全选/取消或逐个调整。创建默认永久、可自定义正整数天数的 restricted 授权，仅包含笔记 CRUD 所需的 `notes:read`、`notebooks:read`、`notes:write`，每个笔记本按当前用户的 `canWrite` 分别授予 write/read，`includeDescendants=false`，确保取消子笔记本时不会仍由父本授权；不使用离线队列，也不在浏览器存储明文。
服务或写入未开启时，仅管理员点击「连接」才会启用。普通用户不能自行启动或提升全局写权限。已有只读授权保持原有权限，需断开后重新连接才使用新授权。
授权只覆盖当前勾选的笔记本，以后新建笔记本需重新连接时选中；不授予笔记本结构写权限。笔记增删改查复用现有工具和 REST 路径；删除先预览并明确确认，只移入回收站，保留版本检查且禁止永久删除。
创建后依次执行 initialize、tools/list、nowen_list_notebooks，成功后才提供接入材料；失败重试复用已创建的授权。
关闭或切换账号后不再保留明文；已有助手从当前用户的授权列表中读取，断开直接调用原有吊销接口，失败时保留原状态。
开发者令牌管理保留在账号安全页面，与普通连接流程分离。

## 客户端材料

Cursor 与 TRAE 国内版生成官方协议的安装链接；其余助手生成可直接交给所选 Agent 的接入说明。接入说明指定用户级私有配置，要求合并已有设置、保护凭据，并通过真实工具调用确认连接。

各客户端的 HTTP 字段存在差异，不能把同一 JSON 模板直接套用：

| 客户端 | 远程配置 | 用户级目标或接入方式 | 官方依据 |
| --- | --- | --- | --- |
| WorkBuddy | `type: "streamableHttp"`、`url`、`headers` | `~/.workbuddy/mcp.json` | [连接器规范](https://open.workbuddy.cn/docs/connector)、[MCP 指南](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide) |
| CodeBuddy Code | `type: "http"`、`url`、`headers` | `~/.codebuddy/.mcp.json`；兼容旧文件时保留官方优先级 | [MCP 文档](https://www.codebuddy.cn/docs/cli/mcp) |
| TRAE 国内版 | `url`、`headers` | `trae-cn://` 安装链接，`type=http`，编码单个服务对象 | [HTTP 配置](https://docs.trae.cn/ide_add-mcp-servers)、[安装链接](https://docs.trae.cn/ide_mcp-server-install-links) |
| Qoder | `type: "http"`、`url`、`headers` | `~/.qoder/settings.json` | [MCP 参考](https://docs.qoder.com/cli/mcp-reference) |
| Kimi Code | `url`、`headers`；HTTP 不额外指定 `transport` | `~/.kimi-code/mcp.json` | [MCP 文档](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html) |
| Qwen Code | `httpUrl`、`headers` | `~/.qwen/settings.json`；`url` 在该客户端表示旧 SSE | [官方 MCP 文档](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/mcp.md) |
| Claude Code | `type: "http"`、`url`、`headers` | 用户级 MCP 配置 | [MCP 文档](https://code.claude.com/docs/en/mcp) |
| Cursor | `url`、`headers` | 官方安装链接 | [配置](https://prod.cursor.com/docs/mcp)、[安装链接](https://prod.cursor.com/docs/mcp/install-links) |
| Codex | `url`、`http_headers` | `~/.codex/config.toml` | [MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) |

上述适配依据官方文档，不代表已逐个完成真实客户端安装与运行验收。Kimi Code 是支持 MCP 的开发工具，不能据此将普通 Kimi 网页聊天视为可直连；普通豆包、DeepSeek 网页聊天也不在本次已确认范围内。

## 验证命令

```bash
npm ci --prefix packages/nowen-mcp
npm run build --prefix packages/nowen-mcp
cd backend
node --import tsx --test tests/mcp-embedded.test.ts
```

SQLite 原生模块若为 Electron ABI，使用 Electron 的 `ELECTRON_RUN_AS_NODE=1` 运行同一测试。
`DCC-006` 对应并发用户、笔记本授权、scope、吊销及数据库重开测试；写入仍经现有 REST 路径，不新增同步或恢复机制。
其他覆盖包括默认关闭、管理员会话要求、只读拒绝且原数据保留、Host/Origin、无凭据、过期、账号禁用、大小/格式限制和本地文件禁止。
设置页测试覆盖简易界面、服务检查失败重试、普通用户、客户端接入、检测重试不重复创建授权、断开失败保留状态和跨账号迟到响应；CI 先构建 MCP 再运行真实权限测试。
