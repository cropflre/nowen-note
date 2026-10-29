# Migration Hub — 实际客户端验收

日期：2026-10-29。macOS / arm64。代码基线 `a254635ab`；复测脚本为 [`scripts/migration-client-acceptance.mjs`](../../../scripts/migration-client-acceptance.mjs)。原始摘要见 [client-claude.json](client-claude.json) 与 [安装清单](client-inventory.json)。

## Claude Code 2.1.187

本轮从 SDK transport 测试推进到**已安装 Claude Code CLI 本身**：页面共用的 `buildMigrationClientConfig` 生成配置，真实宿主读取环境变量、启动 Nowen MCP / 连接网关、发现工具，实际调用 `nowen_migration_capabilities` 并将结果送回宿主的下一轮请求。

| 路径 | 配置与链路 | 实际结果 |
|---|---|---|
| stdio | 生成的 Claude JSON → 实际 `bin/nowen-mcp.mjs` → 合成 Nowen API | 退出 0；发现 11 个迁移工具；能力结果包含目录版本并回到真实宿主；result 为 success |
| Streamable HTTP | 生成的 `type: http` JSON → 实际受保护 gateway → 合成 Nowen API | 退出 0；发现 11 个迁移工具；能力结果回到真实宿主；不带网关凭据时 HTTP 401 |

每种传输只产生三个业务服务请求：`GET /api/notebooks`、`GET /api/notebooks/shared-with-me`、`GET /api/migrations/capabilities`。没有 POST/PUT/DELETE、正式笔记写入或来源文件修改。HTTP 网关凭据与上游合成 PAT 独立。

宿主执行使用 `--bare`、`--setting-sources ""`、`--strict-mcp-config`、`--no-session-persistence`，内置工具集合为空，仅允许迁移能力工具。所有设置、临时配置与宿主记录使用新的临时目录；测试完成后清理，未修改用户原客户端配置。

模型端为只监听 `127.0.0.1` 的合成 Anthropic 协议响应器，使用新生成的合成凭据，不使用真实模型或付费 API。macOS sandbox 只允许回环出站，并拒绝读取/写入真实 `~/.claude`、`~/.claude.json`、`~/.codex`。因此此结果证明真实宿主的配置、工具发现和调用闭环，**不证明真实 Claude 模型遵循迁移指令、Claude Desktop GUI、真实 Nowen 后端或生产网络已验收**。

复测（需要本机安装 Claude Code、Node 24.x，且 `packages/nowen-mcp/dist/` 已构建）：

```sh
npm --prefix packages/nowen-mcp run build
node scripts/migration-client-acceptance.mjs /tmp/nowen-migration-client-evidence
```

脚本只生成合成数据，失败返回非零退出码；不接收真实 Token。macOS 自动使用 `/usr/bin/sandbox-exec`。其他系统的同一脚本不提供 macOS 的出站防火墙，应在隔离环境复测，不能将本机安全约束扩展为所有平台结论。

实现所用的隔离变量与 bare 行为以[Claude Code 官方环境变量文档](https://code.claude.com/docs/en/env-vars)和本机 `claude --help` 为依据；生成配置的字段依据见[官方 MCP 文档](https://code.claude.com/docs/en/mcp)。

## Codex 与其他桌面应用

- 已安装 Codex CLI `0.165.0-alpha.1.2`。官方 [app-server](https://learn.chatgpt.com/docs/app-server) 提供 `mcpServerStatus/list`，可在无 threadId 时发现服务器；本轮没有调用任何 thread/chat 创建或模型 API。
- 为防止读取当前用户真实配置，尝试在拒绝 `~/.codex` 访问的 OS sandbox 中验证运行时配置；该 CLI 在 bootstrap 读取 `config.toml` 时被明确拒绝。本轮未改变 `CODEX_HOME` 或现有配置，故 **Codex MCP 握手与工具调用仍未执行**。这属于本次隔离验收限制，不是 Nowen 或 Codex 不支持 MCP 的结论。
- 只读安装清单确认 WorkBuddy `5.9.0`、Qoder CN `0.4.8`、Claude Desktop `1.46388.4`、Doubao `2.33.3` 和 Codex++ `1.2.4`。未打开或修改这些应用的现有项目/配置，未将版本清单、通用模板或 SDK 成功等同于宿主验收。

### WorkBuddy / Qoder CN 隔离启动尝试

进一步检查的是安装包，而非用户配置：WorkBuddy 实现中有 `WORKBUDDY_USER_DATA_DIR` 和 `WORKBUDDY_CONFIG_DIR` / `CODEBUDDY_CONFIG_DIR` 独立路径；附带 CLI 包的常规 `bin/codebuddy` wrapper 因缺少 `../dist/codebuddy` 返回 MODULE_NOT_FOUND，直接 `codebuddy-lite-wb.mjs --help` 可运行并列出 `--mcp-config`、`--strict-mcp-config` 和 `--setting-sources`。这不证明 WorkBuddy GUI 已完成接入。Qoder CN 安装包没有发现可用 CLI wrapper，未据此推断其不支持 MCP。

两种桌面二进制随后都实际使用全新的 userdata、extensions、workspace 和合成 MCP 配置启动。WorkBuddy 同时传入上述明确隔离变量；Qoder CN 尝试 `--user-data-dir` / `--extensions-dir`。OS sandbox 拒绝真实 home 文件和 Keychain 服务，只允许回环出站；不会向原实例交接配置。合成 stdio 代理只记录 MCP 方法名，不记录正文或凭据。

两者都出现本次独立进程的 DevTools 端点，但没有到达可验证的 MCP 握手：WorkBuddy 的隔离 CDP 协议初始化在 4 秒内未完成，Qoder CN 没有可用 renderer 页面；两者协议标记均为空。未登录账户、未调用模型，也没有读取用户原窗口或私聊。未能确认登录界面，因此**不将阻塞原因写成“需要登录”，也不将隔离启动限制判作产品兼容缺陷**。

结果见 [client-desktop-probe.json](client-desktop-probe.json)。所有本次创建的进程组、窗口和临时 profile/workspace/config 已清理；未更改既有用户 profile。WorkBuddy / Qoder 的实际 MCP 握手、列工具和能力调用门禁仍未通过。

剩余门禁：WorkBuddy、Qoder/QoderWork、豆包工作和 Codex 的实际应用/具体版本接入；真实模型下的迁移规划、授权文件访问、上传、预览及人工确认；真实设备/NAS/代理/对象存储仍由各专项记录独立验收。
