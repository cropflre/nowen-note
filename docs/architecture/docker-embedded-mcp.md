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

写权限是服务允许写入、Token scopes、资源授权及用户 ACL 的交集。服务默认只读，只允许 GET/HEAD/OPTIONS 的内部 API 请求；关闭写入同时限制进行中工具的后续 API 调用。
服务器本地路径、危险工具保持禁用，不受独立 MCP 的危险工具环境变量影响。

对外 Host 必须匹配管理员保存的 MCP URL（回环 Host 可用于本机）；Origin 只允许该公开 origin 或匹配的本机 origin。
反向代理应保留公开 Host。公网使用 HTTPS；仅 Bearer Header 认证，不提供 OAuth 授权发现。
请求上限 1 MiB，方法 POST；GET/DELETE 返回 405，无常驻 SSE、会话复用或恢复事件存储。
服务健康不参与主应用健康判定；设置状态报告运行时是否存在、开关与写入状态，连接检测验证真实协议。

## 验证

```bash
npm ci --prefix packages/nowen-mcp
npm run build --prefix packages/nowen-mcp
cd backend
node --import tsx --test tests/mcp-embedded.test.ts
```

SQLite 原生模块若为 Electron ABI，使用 Electron 的 `ELECTRON_RUN_AS_NODE=1` 运行同一测试。
`DCC-006` 对应并发用户、笔记本授权、scope、吊销及数据库重开测试；写入仍经现有 REST 路径，不新增同步或恢复机制。
其他覆盖包括默认关闭、管理员会话要求、只读拒绝且原数据保留、Host/Origin、无凭据、过期、账号禁用、大小/格式限制和本地文件禁止。
设置页测试覆盖启停失败、普通用户、旧镜像、配置占位符与协议检测，CI 先构建 MCP 再运行真实权限测试。
