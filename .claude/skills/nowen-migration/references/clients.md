# 客户端交付说明

这些说明适配工作方式，不代表相应产品或版本已经验收。当前自动化覆盖真实 MCP SDK Client 的 stdio 与受保护 Streamable HTTP；WorkBuddy、Qoder/QoderWork、Claude Code、Codex、豆包工作的实际应用版本必须分别记录验证结果。

从 Nowen **让 AI 帮我迁移** 的接入引导生成配置。迁移准备需要个人 API Token、read-write 模式；受限 Token 选择目标笔记本的写权限并包含后代。最小权限按实例能力提示配置；带标签、附件的数据还需要相应写权限。HTTP gateway bearer 与 Nowen API Token 是不同凭据，不向模型或来源文件泄露它们。

## 生成配置与定位连接问题

选择实际使用的客户端和传输方式，再生成对应配置。stdio 运行在 AI 客户端所在设备：Node 启动路径、Nowen MCP launcher 路径和已授权导出文件都必须在该设备可访问；本地白名单使用目标笔记本 ID，迁移需要 `MCP_ACCESS_MODE=read-write` 与 `MCP_INCLUDE_DESCENDANTS=true`。这不替代服务端 Token 的目标及后代授权。

配置中的凭据使用占位符或环境变量引用；在客户端的配置或凭据管理中填入，不粘贴到迁移提示词、来源文件或报告。Codex/Claude Code 的 stdio 示例从客户端环境读取 `NOWEN_API_TOKEN`，HTTP 示例读取 `NOWEN_MCP_HTTP_TOKEN`，需要在启动宿主的环境中设置。HTTP 使用单独部署的 HTTPS Streamable HTTP gateway，gateway 的独立 Bearer 不能用 Nowen 登录凭证替代；gateway 访问 Nowen 后端的 PAT 由服务器管理。未知宿主只交付通用模板，并按它当前版本的官方配置说明转换，不把 JSON/TOML 格式相似当作兼容证明。

页面的只读诊断检查所填配置，并以当前登录身份请求 Nowen 的 `/api/migrations/capabilities`（8 秒超时）；不会替客户端启动本机进程或向任意远端 MCP 地址发送登录凭证。诊断成功也不证明占位 Token 有效、所选目标具有写权限、gateway 鉴权成功、客户端能够读取文件或 MCP 握手与工具调用可用。配置完成后在实际客户端列出工具，运行 `nowen_migration_capabilities`，再用合成小文件准备预览；到此不需要审批或写入正式笔记。若失败，区分配置格式、launcher/运行时、网络、401/403、Token scope、目标白名单与 transport，不反复更换身份或扩大授权。

Phase 1 通过能力查询协商 Notion／思源适配与断点上传。stdio upload 在支持的服务器上自动使用 4 MiB 分块、分块及整文件哈希；中断后重复同一任务和文件可恢复服务端确认偏移，过期会话重新上传。HTTP MCP 继续禁止本地路径，使用 REST 字节上传或标准文件包。SDK 只提供显式会话方法，调用方实现分块循环；关闭浏览器不会继续发送未上传文件。上述能力不代表任意宿主都能访问用户导出文件。

保留原始导出供核对：Notion CSV 只暂存来源属性并报告字段名，不写成笔记属性、标签、日期或数据库；思源按 Markdown 转换，嵌套块引用和特殊组件有降级边界。来源变化的逐项处理在 Nowen 中完成，MCP 不提供决策或覆盖工具；处理后必须检查新预览并重新批准。不要把来源已上传、会话 COMPLETE 或自动化同步测试称为真实设备／NAS／客户端验收。

| 客户端 | 文档依据与交付方式 | 验证与回退 |
| --- | --- | --- |
| WorkBuddy | [官方指南](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)说明用户/项目 `.workbuddy/mcp.json`；stdio 使用 `mcpServers` 的 command/args/env 配置 | HTTP 仅给通用模板，不从 stdio 文档推断其原生 HTTP 格式；实际版本未验收 |
| Qoder / QoderWork | [Qoder MCP 指南](https://docs.qoder.com/user-guide/chat/model-context-protocol)提供 stdio `mcpServers` 示例；[QoderWork 连接器](https://docs.qoder.com/qoderwork/connectors)说明 stdio/Streamable HTTP 表单连接 | 两种产品分别配置和验收；HTTP 通用模板须按具体宿主转换，不假定配置文件相同 |
| Claude Code | [官方 MCP 指南](https://code.claude.com/docs/en/mcp)说明项目 `.mcp.json` 的 `mcpServers`；生成 JSON，HTTP 配置使用 `type: "http"` | CLI 2.1.187 已在隔离合成 provider 下验证双 transport 配置加载、列工具和能力调用；真实模型、文件迁移及 Desktop GUI 未验收。Skill 使用 `.claude/skills/nowen-migration` |
| Codex | [官方 MCP 指南](https://developers.openai.com/codex/mcp/)说明 TOML 的 `mcp_servers`；HTTP 令牌通过 `bearer_token_env_var` 引用客户端环境变量 | 将 Skill 放入项目 `.agents/skills/nowen-migration`；不要把通用 JSON 直接当作 Codex TOML，实际应用未验收 |
| 豆包工作 | 未取得可核验的官方 MCP 配置格式，页面只生成标明为通用模板的 JSON；如当前版本提供连接功能，按其实际设置填写 | 不编造配置文件位置或承诺本机路径、stdio/HTTP 支持；无法接入时交付标准 ZIP |
| 其他 MCP 客户端 | 使用兼容的 stdio 或受保护 Streamable HTTP，先列工具再查询能力 | HTTP 不支持读取服务器本地路径；批准操作在 Nowen 完成 |

以上官方资料核对日期为 2026-10-29，文档格式支持不等于实际宿主验收。每次宿主验收分别记录产品与版本、OS、transport、配置格式、列工具、能力查询、文件访问、预览及失败原因。[发布前客户端记录](../../../../docs/qa/migration-hub-release-2026-10-29/client-acceptance.md)包含 Claude Code CLI 的隔离基础接入证据；其余宿主仍未完成实际接入。该 CLI 结果不证明真实模型或完整迁移流程；仓库 SDK transport、配置生成和页面诊断也不能替代宿主验收。客户端未提供 MCP 时，标准文件包路径仍可使用。

通用任务指令（替换方括号部分）：

> 请把我已授权的 [来源与导出文件位置] 迁移到 Nowen Note 的 [目标位置]。先查询迁移能力，保留目录、时间、标签、附件和支持的内部链接；不删除来源，不覆盖已有笔记。用统一迁移任务准备数据并生成预览，告诉我无法迁移的部分，等待我在 Nowen 中确认。确认后跟踪状态，失败时只重试失败项，最后给我数量与报告。若当前客户端没有可用 MCP，请生成 Nowen 支持的标准文件包供我上传。
