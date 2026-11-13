# AI Migration Hub — Phase 2 验证记录

日期：2026-10-29。开发分支：`codex/ai-migration-hub-v160`，接续 P1 提交 `3c486e395`。所有测试使用隔离合成账号、文件和 Token，不读取用户私人笔记或真实平台账户。

## 本阶段交付

1. **Source Adapter v1**：提供版本化的可信内置接口、固定顺序的注册调度和可发现目录。安全解包后依次选择 NMF、思源、Notion、显式华为文件、通用文件；已匹配解析器失败不会降级成另一个解析器。每次输出受 NMF 校验、10,000 篇限额和取消检查约束。没有动态加载上传代码或第二套写入/附件/权限链路。
2. **来源发现**：现有 `/api/migrations/capabilities` 返回 `adapterApiVersion: 1` 和 `adapters`，保留 P1 `sourceAdapters` 兼容字段。REST、OpenAPI、SDK、MCP 摘要及页面使用同一目录；目录说明范围，不证明平台账户已连接或获授权。
3. **华为文件与离线扩展示例**：显式 `source.platform: "huawei"` 接受 TXT/HTML、本地资源及其 ZIP；通用手动入口仍可导入同类文件。另提供可运行的受限 JSON → NMF 离线示例、合成输入和双语扩展规范。
4. **客户端配置与诊断**：复用 MigrationHub 的客户端选择和 McpConnectionPanel 入口，生成 Codex TOML、官方文档可核验的 JSON，以及明确标记的通用模板。stdio 必须选择具体目标、完整 launcher 路径，包含 read-write 和后代限制；HTTP 使用独立 gateway 凭据引用/占位符。页面不接收、保存或读取真实 PAT。
5. **只读检查**：校验本地配置格式并以当前 Nowen 登录请求能力，8 秒超时，可重试；不向输入的 MCP 地址发送请求，不替代 AI Token、目标 ACL、本机 runtime、MCP 握手或宿主验收。账号切换和卸载会拒绝迟到结果/中止诊断。
6. **文档与 Skill**：中英文教程、架构、发布草稿、MCP 说明及 `.agents` / `.claude` 镜像同步；复用既有一键迁移指令和文件包回退。

设计和可运行示例见 [Source Adapter 中文规范](../architecture/migration-source-adapters.md)、[英文规范](../architecture/migration-source-adapters.en.md)、[离线示例](../examples/migration-adapter/README.md)。

## 自动化证据

| 范围 | 结果与实测边界 |
|---|---|
| 后端 7 文件 | **53/53 通过**：目录/接口/限额、NMF 优先、华为文件、示例往返与拒绝覆盖，原 Markdown/HTML/NMF、Notion、思源、迁移服务、真实 HTTP 鉴权/审批与 OpenAPI 回归 |
| 前端 4 文件 | **32/32 通过**：6 客户端 × 2 transport 的配置分支、安全 URL/路径/目标校验，配置复制、仅当前服务诊断、401/403、超时、卸载与账号切换；P1 上传/预览/决策回归 |
| SDK | **35/35 通过**：新增只读目录读取，原任务/上传/决策/审批拒绝等行为保持 |
| MCP | **35/35 通过**：真实 SDK Client stdio 与受保护 Streamable HTTP；新增目录字段经过摘要白名单，额外正文不返回 |
| 配置实际启动 | 用页面助手生成的 Claude stdio JSON 启动真实 `bin/nowen-mcp.mjs`；将环境引用替换为隔离测试 PAT 后，真实 SDK Client 列工具、查询目录、准备/上传/预览成功；仍无 approve 工具、undo 不写入 |
| 独立配置解析 | **12/12 通过**：Python 3.12 `tomllib` 解析 2 份 Codex TOML，`json` 解析其余 10 份；核对反代前缀、具体目录、read-write、后代范围和独立 HTTP 凭据引用 |
| 工程 | backend TypeScript / bundle、frontend TypeScript / Vite build、SDK/MCP build 通过。前端保留既有大 chunk 提示 |
| Lint | `frontend/src` 对既有基线 **1,443 历史错误，0 新增**；全仓 baseline 仍因既有 `dist.bak/` 与 iOS PDF worker 的 96 个缺失规则报错失败，未修改产物或刷新基线 |
| DCC | 12 个不变量 / **243 个测试引用** 校验通过；新增 DCC-006 的账号切换后正文解析拒绝映射。矩阵不代替行为测试 |

最终命令、计数、环境与解析摘要见 [checks.json](migration-hub-phase2-2026-10-29/checks.json)。stdio 配置启动属于 launcher + SDK 自动化，环境变量替换由测试夹具完成，**不是 Claude Code 宿主实际读取配置的验收**。

P2 未改变 MigrationService 的业务写入或 SyncEngine，不重新宣称全部旧导入、生产数据库或所有来源压力验收。P1 的 104MiB 三库 HTTP 同步、512MiB cgroup 和万篇实测保留于 [Phase 1 记录](ai-migration-hub-phase1-2026-10-29.md)，不能自动扩大为所有 P2 来源或部署环境的性能保证。

## 浏览器验收

Chromium 153.0.8010.12，320/1280px × 浅/深主题，高 900px，`prefers-reduced-motion: reduce`。真实 MigrationHub → McpConnectionPanel → MigrationConnectionSetup，使用隔离浏览器上下文、合成 API 和登录数据。

四组均验证 Codex/Claude 配置生成与复制，缺少目标/launcher 禁止复制，凭据 URL 拒绝，豆包通用模板标识；页面和 body 不超出视口，代码块独立滚动。记录中没有外部 origin 请求、业务写请求或 pageerror。320px 深色组实际等待 8 秒，验证中止、超时文案和按钮恢复。

8 张完整截图和步骤见 [浏览器验收记录](migration-hub-phase2-2026-10-29/browser-validation.md) 与 [机器可读结果](migration-hub-phase2-2026-10-29/browser-validation.json)。复用现有语义 surface/background/text/border/accent token，未新增全站动画或背景；使用原生表单与可聚焦代码区，加载动画支持 reduced-motion。没有改普通 MCP 连接中心的既有功能。

## 支持边界与待执行门禁

- 华为[官方说明](https://consumer.huawei.com/cn/support/content/zh-cn16070761/)列出 TXT/HTML 等导出方式；实际格式依设备/内容而异。目前验收合成文件，不是华为云连接、私有备份、手写 OCR、语音结构、原始时间/标签或物理手机导出验收。
- Codex、Claude Code、WorkBuddy、Qoder/QoderWork 的文档格式依据与豆包回退见 [客户端参考](../../.agents/skills/nowen-migration/references/clients.md)。所有宿主的**具体应用版本实测仍未执行**；官方格式存在、配置可解析和 SDK transport 通过是独立证据。
- 目录只发现当前服务器内置转换能力，不自动登录来源平台、不发现或安装任意远端代码。用户自定义来源走已授权离线转换 → NMF → 共用预览/审批。
- 真实 NAS/代理/S3、物理 Android、Electron 安装升级、生产数据及物理断电/磁盘耗尽仍待环境验收。
- 本阶段仅本地开发与提交。远端推送、对应 commit 的 CI、合并、签名和发布未作为本记录的执行结果。
