# AI Migration Hub — Phase 1 验证记录

日期：2026-10-29。分支：`codex/ai-migration-hub-v160`，派生自 `release/v1.6.0`。接续 [Phase 0](ai-migration-hub-2026-10-29.md)。全部输入、账号、数据库及附件均为隔离合成资料，未读取用户私人笔记。

## 实现范围

- Notion Markdown/CSV、HTML ZIP 转换为 NMF：页面 UUID、目录、受支持的内部页面链接及本地附件；CSV 属性只暂存并报告，不创建数据库关系或公式。自动识别的文件名规则属于启发式，报告中提示来源推断。
- 思源 `.sy` ZIP 复用既有纯转换器，接入统一任务、预览、审批、附件和报告；原导入入口保留。目录、标签、文档链接及有效时间可以保留；块链接、无时区时间、未知属性与降级组件明确报告。
- 持久化上传会话：固定 4MiB 分块（尾块除外）、每块/全文件 SHA-256、服务端确认偏移、24 小时期限、原操作恢复、异步完成校验、崩溃恢复、限速与临时配额。Web 和 stdio MCP 都复用该协议，不读取远端传入的服务器路径。
- 逐项选择自动判断、保留已有笔记、创建新副本或跳过；每次选择轮换预览摘要并撤销之前的勾选。没有覆盖策略。稳定 Notion/思源 ID 可跨导出识别；完整重复还比较标题、标签和附件原引用/校验和，排除适配器生成的临时路径。
- 复用 P0 的失败重试、分页报告及有保护的整树软删除撤销。更改源数据需要准备新的任务；已经部分解析失败的来源不能被预览成完整导入。
- 可加性数据库 v143–145、REST、OpenAPI、SDK、MCP scope 边界、前端和中英文指南同步更新。

## 功能、安全与兼容

| 检查 | 证据 |
|---|---|
| Notion 官方格式边界、UUID/目录/相对链接、HTML、CSV 引号与歧义 | `migration-notion-adapter.test.ts`；`migration-format-source.test.ts` 的真实 ZIP 分派用例 |
| 思源层级、标签、附件、文档/块链接、时间、AST 深度/节点限制 | `migration-siyuan-adapter.test.ts`；同上 ZIP 分派用例 |
| 分块重复请求、丢失响应、偏移/大小/哈希错误、原操作冲突 | `migration-uploads.test.ts`、前端 `migrations.test.ts`、MCP SDK Client 的 stdio 大文件用例 |
| 数据库重开后保留已确认偏移，文件发布但收据未提交的恢复 | `DCC-003: acknowledged chunks survive database reopening and a pre-receipt file is reconciled` |
| 原 Token、当前 Token、跨账号、权限撤回、过期、取消及后台校验 | `migration-uploads.test.ts`、`migration-upload-security.test.ts` |
| 恢复隔离、旧取消记录不删除较新附件、发布意图与整文件校验 | `migration-upload-security.test.ts`；仅清理本会话拥有且未提交的对象 |
| 来源变化、复制保留原笔记、旧摘要拒绝、跳过/保留策略 | `migration-service.test.ts` 的 DCC-004 用例及决策用例 |
| 正文相同但附件内容变化 | 两个先失败后修复的服务用例：同源必须人工处理；不同来源不能静默跳过 |
| 仅标题或标签变化 | `source title and tag changes require review without changing the existing note (DCC-004)` |
| 存储预检等待期间开启新上传 | `a resumable upload opened during async storage preflight invalidates the pending preview`：事务内再次检查，阻止不完整预览 |
| 旧数据/开发中断 Schema | `migration-schema.test.ts`：重复执行 v143–145，上传收据、偏移、原有笔记与 Item 保留；非法 overwrite 决策拒绝 |
| 真实 HTTP 鉴权、人工审批、重启恢复、附件流、OpenAPI | P0 用例重新运行；PAT 仍不能调用 approve |
| 旧导入与同步 | 思源包、思源元数据、Nowen 无损往返包及 SyncEngine 定向回归；未覆盖全部 Office/手机来源 |

服务端状态和报告不返回大正文或来源凭据。MCP 没有审批工具，撤销工具仍只查询条件；人类在 Nowen Note 中批准新摘要后才开始业务写入。

## 100MiB+ 多端专项（DCC-012 / #820）

`sync-v2-mobile-multidevice.test.ts` 的新增用例使用真实 MigrationService 导入 100 篇笔记与 13 个各 8MiB 的随机 PDF。ZIP 为 109,100,867 字节，附件合计 109,051,904 字节。

通过真实 HTTP Sync V2 路由及三个独立 Native SQLite 客户端运行现有 SyncEngine，逐篇比较正文与版本，逐附件下载并比较 SHA-256/大小。累计下载 327,155,712 字节。另验证离线编辑后重开数据库、另一端并发编辑、双方正文保留、显式冲突解决和丢失 ACK 后稳定 mutation 重试，重复 mutation 为 0。

专项摘要见 [原始测量](migration-hub-phase1-2026-10-29/multidevice.json)。整个多端测试文件也重新运行，覆盖既有删除、附件位置、作用域与冲突行为。此证据使用生产 HTTP 路由、Native 适配器和真实 SQLite，**不代表物理 Android、Electron 安装包或真实 NAS 网络验收**。

真实 HTTP 回归发现并修复附件 GET 手动 `Content-Length` 与 Node 适配器重复发头的问题：由适配器选择有效的长度或 chunked framing，保留 `X-Blob-Size` / hash；HEAD 在 Hono 实际 GET 分派路径中只检查对象存在性并返回元信息。`sync-v2-blob-http.test.ts` 验证原始响应头、每个字节、哈希、HEAD 和跨用户拒绝。

## 低总内存实测

Linux arm64 / LinuxKit 6.12.76、Node v24.22.1、本地 Linux 原生依赖镜像 `c1f30777991a`；当前基准源码通过 esbuild 打包，依赖使用镜像中的生产模块。每次独立数据库和目录；容器限制 **512MiB 总内存、无 swap、2 CPU**，V8 old-space 256MiB，网络关闭、根文件系统只读。临时目录为 tmpfs，其文件页也计入 cgroup 总内存，容器退出后删除。

最终测量见 [1,000 篇 + 104MiB](migration-hub-phase1-2026-10-29/cgroup-512m-1000-104mib.json) 及 [10,000 篇](migration-hub-phase1-2026-10-29/cgroup-512m-10000.json)。原始 `.log` 与 JSON 同目录。RSS/heap 每 20ms 采样，cgroup `memory.peak` 与 `memory.events` 在退出时读取；计时包含合成输入生成、扫描、预览、写入及计数校验。

| 数据 | 完成时间 | 采样 RSS 峰值 | 采样 heap 峰值 | cgroup 总内存峰值 | 结果 |
|---|---:|---:|---:|---:|---|
| 1,000 篇 + 104MiB 附件 | 18.75s | 142.4MiB | 27.3MiB | 440.9MiB | 1,000 篇、26 附件，0 失败、0 OOM |
| 10,000 篇 | 189.00s | 174.8MiB | 71.4MiB | 338.7MiB | 10,000 篇，0 失败、0 OOM |

两组分别使用独立的 2 CPU 容器，同时在同一 Docker 主机执行；不能将逻辑 CPU 数 10 当作容器可用 CPU 配额。

此结果补充 P0 的 Electron/macOS 数据，两种运行时和附件存储环境不同，不能据此比较优化倍数或保证所有 512MiB NAS。真实 S3、NAS 磁盘、反向代理中断、磁盘耗尽、物理断电及实际用户大库仍待验收。

复测使用现有 `backend/scripts/benchmark-migration-hub.ts`。打包后挂载到含 Linux 生产依赖的 `/app/backend/`，执行：

```sh
node --max-old-space-size=256 migration-benchmark.cjs 1000 104
node --max-old-space-size=256 migration-benchmark.cjs 10000 0
```

本次 Docker 参数为 `--memory 512m --memory-swap 512m --cpus 2 --network none --read-only --tmpfs /tmp:rw,size=2147483648`；启动预加载脚本在 exit 时读取 `/sys/fs/cgroup/memory.max`、`memory.peak`、`memory.events` 和 `cpu.max`。本机 Electron ABI 的 node_modules 没有重建或拷贝进 Linux 容器。

## 前端与工程检查

前端定向 16 项通过，包含分块读内存预算、丢失响应后读取服务端偏移、账号切换中止、逐项决策使审批勾选失效、未解决项阻止审批，以及取消续传选文件后重新开始任务。

真实 Chromium 320/1280px × 深/浅主题验证逐项决策和断点恢复；无横向溢出。组件模拟后端数据，不是登录真实账号的产品端到端验收。截图和浏览器结果见 [证据目录](migration-hub-phase1-2026-10-29/)。

最终命令与测试摘要见同目录 `checks.json`。TypeScript、backend bundle、frontend build、SDK 和 MCP 构建执行；SDK 34 项及 MCP 全套 35 项通过。MCP 使用真实 SDK Client，包含 stdio 及受保护 Streamable HTTP；宿主 AI 应用尚未实测。

后端 17 个文件共 186 项通过；随后扩展生产 HTTP 用例，实测 PAT 分块上传、后台扫描、逐项决策、旧摘要拒绝与登录会话审批，也单独通过。后端与前端 TypeScript/构建均通过，前端保留既有大 chunk 提示。

全仓前端 `lint:baseline` 仍未通过：1,443 个历史源码错误之外，96 个报错来自已有 `dist.bak/` 和 iOS 生成的 PDF worker 中缺失的 es/sonarjs 规则。未改这些文件或刷新基线。相同检查限于 `frontend/src` 时为 1,443 个历史错误、**0 个新增错误**。DCC 矩阵为 12 个不变量、242 个测试引用；映射校验不代替行为回归。

## 剩余门禁

1. 物理 Android、Electron 安装/升级、真实 NAS/代理和对象存储；生产数据、权限撤回及断电/存储耗尽验收。
2. Notion 数据库关系/公式/历史/评论、思源块级引用与缺失时区等边界持续明确报告，不承诺无损迁移。
3. WorkBuddy、Qoder/QoderWork、豆包工作等宿主及具体版本的实际接入验收；现有 MCP transport 自动化不能替代。
4. P2 的 Source Adapter 扩展规范、更多来源示例、配置生成与接入诊断。
5. 远端推送、对应 commit 的 CI、合并、安装包签名和正式发布。本记录只证明本地实现及列明的自动化验收。
