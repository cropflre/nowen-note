# MCP 令牌团队空间授权验收（1.6.0）

基线：`release/v1.6.0` @ `67b473803`。实现提交：`56f75b61d`（后端与 MCP 包）、`6890ade4e`（前端），本文与教程在随后的文档提交中。本文记录实现范围、安全边界和本地实测结果。

## 用户流程

「设置 → 连接 AI 助手」：选择助手 → 选择笔记 → 点「连接」。

- 笔记本按「个人空间 / 与我共享 / 团队空间 › 各团队」分组，名称来自 `GET /api/tokens/notebook-options`（真实工作区与笔记本）。每组可展开收起、整组勾选，显示「已选 x/y」；每个笔记本标「可编辑」或「只读」。
- 默认只勾选本人个人空间的笔记本；团队组默认收起且不勾选，「与我共享」也不默认勾选。
- 勾选任一团队笔记本时显示：“AI 助手将可以访问你选中的团队笔记。请确认团队内容允许接入该助手。”
- 所选笔记本全部只读时显示「只读连接」，Token 不申请 `notes:write`，连接后状态旁也标「只读连接」。服务已开启但未允许编辑时，普通用户仍可改选只读笔记本建立只读连接。
- 创建授权或检测连接失败时显示对应错误，不显示「准备好了」，不提供复制/安装入口。
- 高级设置（对可编辑笔记本只授只读、包含子笔记本、`notebooks:write` 目录结构写入）仍在「账号安全 → 开发者访问令牌」，该页的笔记本选项和已授权标签旁标出所属空间，便于区分同名笔记本。
- 组件文案全部走 i18n（新增 `mcpConnect` 命名空间，中英文对齐）。

## 权限模型

```text
最终权限 = Token scopes ∩ Token 笔记本授权 ∩ 当前团队成员权限 ∩ 资源 ACL ∩ MCP 服务写入开关
```

- 新增 `resolveTokenNotebookAccess`：团队笔记本必须有 `workspace_members` 成员行；系统管理员旁路、`workspaces.ownerId`、资源 `userId` 匹配、笔记本单独共享都不能代替成员身份。viewer / commenter 上限只读，editor / admin / owner 上限读写，再与 `resolveNotebookPermission`（知识树受限目录、显式拒绝）取交集。
- Token 中间件每次请求重新计算（请求内缓存）：授权级别 ∩ 上述用户级别。成员被移出、降权、笔记本删除，下一次请求即生效。
- 创建 / 修改 Token 授权与 `notebook-options` 使用同一判定：只读成员不能创建写授权，非成员与系统管理员看不到也不能授权团队笔记本。
- 历史 unrestricted Token 列表范围不变（只补充 `workspaceName` / `space` / `permission` 字段），仍不能修改团队知识树；已有授权表不做任何修改。

## 服务端改动要点

| 位置 | 改动 |
|---|---|
| `backend/src/services/apiTokenNotebookAccess.ts` | 新增 Token 视角的笔记本访问判定与白名单头解析 |
| `backend/src/middleware/api-token-resource-scope.ts` | 授权 ∩ 成员身份 ∩ ACL；目录返回 `workspaceName/space/permission` 并支持 `?workspaceId=`；笔记列表按笔记级 ACL 复核；反向链接、块反向链接按授权过滤；`/api/blocks/resolve` 校验目标笔记；禁止跨空间创建/挂载笔记本；团队知识树写入按请求空间逐节点复核；审计记录结果与空间 |
| `backend/src/routes/notes.ts`、`search.ts` | restricted Token 在 SQL 中限定到当前有效的授权笔记本；未指定空间时跨个人与团队检索 |
| `backend/src/routes/tokens.ts` | 授权校验与选项改用新判定；资源列表带 `workspaceId/workspaceName`；审计带 `spaces` |
| `packages/nowen-mcp` | `nowen_list_notebooks` 返回空间与权限字段；列表 / 搜索 / 笔记本列表可选 `workspaceId`；知识树多空间时要求明确空间；目录写入按 `workspaceId` 执行；子笔记本随父空间创建；独立 MCP 本地白名单支持团队目录 |

## 安全边界与未开放能力

- 只开放笔记、搜索、知识树读取，以及显式授权团队笔记本内的笔记读写和目录写入（目录写入需要 `notebooks:write`，快速连接不授予）。
- 团队中移动、移入回收站沿用知识树默认规则（团队管理员）；批量、权限、密码、根目录、跨空间操作仍拒绝。
- 任务、自动化、个人网盘、文件夹管理、迁移、AI 对话归档维持原有个人空间边界。
- Token 不能管理成员、角色、邀请、分享、服务器配置，不能创建或修改自己的授权（`/api/tokens` 仅限登录会话）。
- 团队根目录下的文档不属于笔记本，暂不能授权。

## 已执行验证

本机 macOS，后端测试用 Electron 43（Node 24.22.1）运行（better-sqlite3 绑定 Electron ABI）。

| 项目 | 结果 |
|---|---|
| 新增 `backend/tests/mcp-team-space.test.ts`（真实路由 + 内置 HTTP MCP + 独立 stdio MCP 子进程） | 13/13 通过，连续两次 |
| 同一测试套在原版后端（4 个后端文件换回 `67b473803`）上 | 11/13 失败，证明用例能抓到原问题；未变红的 2 项（令牌创建角色校验、吊销/过期）原本就有效，作为回归保护 |
| 既有 `api-token-resource-scope`、`mcp-embedded`、`mcp-knowledge-tree-p0`、`notebook-note-scope`、`mcp-ai-archive`、`api-token-deletion` | 全部通过 |
| 后端串行全量 | 436 个文件 433 通过；3 个失败均为基线：`application-v3-foundation`（原版 release 同样失败）、`attachment-file-share`（PST 时区，`TZ=Asia/Shanghai` 6/6 通过）、`migration-release-upgrade`（需先构建，构建后 2/2 通过） |
| `packages/nowen-mcp` `npm test`（构建 + 策略单测 + stdio/HTTP 集成） | 38/38 通过 |
| 前端全量 vitest（`TZ=Asia/Shanghai`） | 793 个文件、4810 个用例全部通过（含新增 10 个） |
| E2E `frontend/e2e/mcp-team-space.spec.ts`（隔离服务，生产入口 `index.hardened` + 生产前端构建） | 通过：成员在界面勾选一个团队笔记本 → 界面对真实 `/mcp` 检测「准备好了」→ 用界面生成的令牌经内置 HTTP MCP 列表、读取、搜索、修改、新建团队笔记，独立 stdio MCP 读取团队笔记，保密笔记本不可见；降为 viewer 后只读，移出团队后不可读 |
| 类型检查 | 后端 `tsc --noEmit`、前端 `tsc -p tsconfig.app.json --noEmit`、`tsc -b` 通过 |
| 生产构建 | 前端 `vite build`、后端 `npm run build`、MCP 包 `tsc` 通过 |
| 数据一致性契约 `--verify` | 12 条不变量 / 373 条测试引用；新增 14 条 DCC-006 引用 |
| eslint（改动文件） | 无新增问题（原有 `any` 与 hooks 警告数量不变） |

E2E 手动运行方式（需先 `npm run build` 前端、`npm ci && npm run build` MCP 包）：

```bash
cd frontend && NOWEN_QA_NODE=<Electron 可执行文件> npx playwright test --config playwright.mcp-team-space.config.ts
```

## 剩余问题

1. 团队根目录下的文档存放在隐藏容器笔记本中，暂不能授权给 Token。
2. 目录写入的版本前置条件按用户完整视图比对；若授权的文件夹下有未授权子文件夹，或子文件夹授权而父文件夹未授权，目录写入会返回 409（拒绝、不误改）。个人空间原本也是如此，建议授权时包含子笔记本。
3. 快速连接不授予 `notebooks:write`，AI 不能改目录结构；连接后新建的笔记本不在授权内（未开启“包含子笔记本”时）。均为既有行为。
4. 既有路由问题：`POST /api/notebooks` 从请求体取 `workspaceId` 而不是父笔记本，`PUT /api/notebooks/:id` 改父级时不校验空间。本次只在 restricted Token 路径拦截，登录会话和 unrestricted Token 仍可能跨空间挂载，建议单独修复路由。
5. 行为收紧：团队笔记本单独共享给非成员时，非成员不能再通过 Token 访问（需求要求与团队成员身份求交）。
6. 开发者令牌页其余界面仍是既有的中文硬编码，本次新增的空间标签已走 i18n。
7. 只在 SQLite 上验证；未改表结构，无需 PostgreSQL 迁移。外部客户端（Claude Code、Cursor 等）未实机安装验证，协议层由 HTTP / stdio JSON-RPC 真实调用覆盖。
8. restricted Token 读取团队资源也会写审计（受 90 天保留期清理），审计量会增加。
9. 直推 `release/v1.6.0` 不会自动触发 MCP Scope CI 与 DCC CI，需要时手动触发。
