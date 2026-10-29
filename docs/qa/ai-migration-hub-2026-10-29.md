# AI Migration Hub — Phase 0 验证记录

日期：2026-10-29。开发分支：`codex/ai-migration-hub-v160`，派生自 `release/v1.6.0`。所有数据库、笔记与附件均为隔离的合成测试资料，未迁移用户私人资料。

## 本阶段结果

已实现：NMF v1 与离线包 Schema、Markdown/HTML/TXT/附件 ZIP 适配、持久化 Job/Item/资产与对象意图、REST、预览与真实登录会话审批、后台分批写入、失败重试、暂停/继续/取消、重启恢复、轻量分页报告、安全软删除撤销、统一设置入口、MCP/SDK/OpenAPI、共用 AI Skill 和中英文使用文档。

现有思源、Nowen 无损包与其他格式入口保留。通用导入复用 Knowledge Tree、正文/块/附件/链接索引及 Sync V2 事务触发器；没有用旧整包 Buffer 导入包裹新任务。

本地工程闭环已具备，尚未发布。P1/P2 和设备/生产门禁见下文，不能据此宣称整个 v1.6.0 已完成。

## 功能与安全自动化

| 检查 | 实际结果 / 证据 |
|---|---|
| Schema、路径、UTF-8 字节预算、时间 UTC、未知字段、危险元数据键 | `migration-format-source.test.ts` 通过 |
| Markdown 目录、相对图片、内部链接、HTML 清洗、NMF 哈希、真实示例 | 同文件通过；示例见 `docs/examples/migration/` |
| ZIP traversal、symlink、大小写冲突、解压炸弹、MIME 伪装 | 拒绝用例通过；没有远程 fetch |
| 本地/S3 附件流式写入 | `migration-attachment-stream.test.ts` 通过；S3 是受控 fetch/签名/流契约验证，不是真实 S3 服务验收 |
| 剩余存储容量 | 本地附件按每个输出副本估算并预检；容量不足拒绝审批预览；对象存储配额无法验证时提示，不伪装为已核验 |
| 创建/Item 幂等、跨用户、当前与创建 Token scope、后代资源授权、撤销 Token | `migration-service.test.ts` 通过 |
| 预览摘要轮换、过期/旧摘要、一次性审批、伪造会话头 | 服务测试及生产 HTTP 测试通过 |
| 正式鉴权中间件 | `migration-http.test.ts` 启动真实隔离 HTTP 后端；空 scope PAT 伪造 scope 被拒绝；PAT 无法审批；有效登录会话能完成导入 |
| 目录/笔记/标签/附件/引用/原始时间/同步 feed | 真实 SQLite 持久化重读通过 |
| 部分失败与只重试失败项 | 人为 DB 触发器失败后 PARTIAL；成功 ID 保持，修复后 COMPLETED，无重复 |
| 取消、运行时用户编辑、安全撤销 | 已提交结果保留；后续写入停止；编辑后的正文不覆盖；已修改/混入其他内容的整树撤销拒绝 |
| 部分来源解析失败 | PENDING 来源不能通过重新预览清除错误并伪装为完整成功 |
| 重复附件上传、临时目录过期、崩溃对象补偿 | 已有暂存字节不会被 EEXIST 清理误删；报告保留；仅清理无 DB 引用的未提交对象意图 |
| 真实进程重启 | `migration-restart.test.ts`：第一次 Worker 进程在提交至少 5/100 条后退出；第二进程恢复到 100 条；原 ID 和未确认 Outbox 保留 |
| 旧数据演进 | `migration-schema.test.ts`：可加性 v141/v142、早期开发 Schema 补齐和重复执行，不改变既有用户笔记 |
| OpenAPI/SDK | 严格 NMF、离线 manifest、任务状态、上传字节、审批/撤销边界；SDK 33 项通过 |
| MCP | 全套 34 项通过；迁移专项 4 项使用真实 SDK Client，包含 stdio 和受保护 Streamable HTTP；只读阻止写操作、禁止 HTTP 本地路径、拒绝密码/JWT 回退、无 approve 工具，undo 只查询 |

后端定向检查包含旧 Nowen 包、思源导入、API Token 资源权限和 Sync V2；不是全仓所有格式的全量回归。没有对 Office/手机来源解析器做改动。

最后一轮迁移服务测试 15/15、真实 HTTP 1/1、真实进程重启 1/1、Schema 1/1、NMF 源适配 7/7、OpenAPI 1/1、附件流 1/1；旧导入/权限定向及 SyncEngine 分别通过。构建与测试命令以仓库现有 scripts 为准，数据库用例按文件隔离运行。

## 同步专项

`sync-v2-engine.test.ts` 全部 35 项通过，包含既有思源跨批次导入和新增 Migration Hub 跨批次测试。新增用例用真实迁移服务产生 Outbox，由现有 SyncEngine 合并后应用到独立服务端 SQLite，再拉回自身回声；验证完整正文、版本、树结构、队列收敛与零自冲突。另有 Worker 重启后未确认 Outbox 保留验证。

这属于真实数据库 + SyncEngine/服务端 mutation 应用的自动化证据，远端传输是受控适配器；**没有把 104MiB 性能包在 macOS → NAS → 物理 Android 全链路跑通**。该端到端 #820 门禁仍为 P1 必做项。

适用 DCC-002/003/004/006/007/008 已加入机器可读矩阵；`node scripts/data-consistency-contract.mjs --verify` 通过（12 个不变量、237 个引用）。矩阵检查不替代行为测试。

## 性能实测

环境：darwin/arm64，OS 27.2.0，10 个逻辑 CPU；Electron 匹配的 Node v24.22.1 与 SQLite 原生模块。本机目录存储、合成 UTF-8 正文；104MiB 附件由 26 个各 4MiB 的随机 PDF 测试载荷组成。每次使用独立数据库与附件目录，运行时限制 V8 heap 为 256MiB，RSS/heap 每 20ms 采样。计时包含构造输入、扫描、预览、写入和校验。

| 数据 | ZIP 实际字节 | 预览时间 | 完成时间 | 采样 RSS 峰值 | 采样 heap 峰值 | 结果 |
|---|---:|---:|---:|---:|---:|---|
| 100 篇 | 15,382 | 0.48s | 2.12s | 217.3MiB | 35.3MiB | 100 篇 / 0 失败 |
| 1,000 篇 + 104MiB 附件 | 109,244,758 | 2.70s | 19.18s | 530.0MiB | 50.1MiB | 1,000 篇、26 附件 / 0 失败 |
| 10,000 篇 | 1,586,782 | 5.66s | 164.49s | 565.7MiB | 75.7MiB | 10,000 篇 / 0 失败 |

原始摘要：[100 篇](migration-hub-2026-10-29/100.json)、[1,000 篇 + 大包](migration-hub-2026-10-29/1000-104mib.json)。[10,000 篇](migration-hub-2026-10-29/10000.json)。

256MiB heap 限制不等于 256MiB 总内存限制。当前合成大包 RSS 超过 512MiB，不能声称 512MiB NAS 已验收。没有真实 NAS、容器 cgroup 内存限制或真实对象存储的性能结论。不同机器、磁盘、正文长度和图片格式会改变结果；20ms 采样也不是 OS 绝对峰值上界。

压力验证中发现并修复：对每条 Item 扫描累计正文 JSON 的二次复杂度、SQLite 原生短寿命查询语句的额外内存压力。改为持久化累计字节与复用查询语句；没有通过加载整个 ZIP/附件来换取速度。

复测命令（仓库根目录进入 backend 后执行）：

```sh
ELECTRON_RUN_AS_NODE=1 ../node_modules/.bin/electron --max-old-space-size=256 --import tsx scripts/benchmark-migration-hub.ts 100 0
ELECTRON_RUN_AS_NODE=1 ../node_modules/.bin/electron --max-old-space-size=256 --import tsx scripts/benchmark-migration-hub.ts 1000 104
ELECTRON_RUN_AS_NODE=1 ../node_modules/.bin/electron --max-old-space-size=256 --import tsx scripts/benchmark-migration-hub.ts 10000 0
```

该 checkout 的 better-sqlite3 ABI 对应 Electron；直接用普通 Node 运行数据库用例会发生 ABI 148/137 不匹配。没有为了测试重建或替换用户现有依赖。

## 前端与构建

- 前端定向 16 项通过：审批点击、顺序多文件扫描、刷新/历史、重试/撤销、非法响应、账号切换、离线边界、分页报告、旧格式选择与旧导入报告。
- Chromium 320/1280px × 浅/深主题，实测页面宽度不超过视口；未勾选时审批禁用，勾选后启用；AI 配置使用 read-write。使用真实组件与模拟任务数据，属于组件浏览器验收，不是完整账号/上传端到端测试。
- 截图：[窄屏深色](migration-hub-2026-10-29/dark-320.png)、[窄屏浅色](migration-hub-2026-10-29/light-320.png)、[桌面深色](migration-hub-2026-10-29/dark-1280.png)、[桌面浅色](migration-hub-2026-10-29/light-1280.png)。
- backend TypeScript、backend bundle、frontend TypeScript + Vite build、MCP build、SDK build 已运行。前端保留现有大 chunk 提示。
- 全仓 `lint:baseline` 未通过：96 个超出基线的错误全部来自已有 `dist.bak/` 与 `ios/App/App/public/assets/pdf.worker-*.mjs` 中未安装的 es/sonarjs 等规则。未修改这些产物或刷新基线。相同 baseline 比较范围限于 `frontend/src` 时为 **1,443 历史错误、0 新错误**；新迁移文件检查未新增 Lint 问题。

## 尚未完成的门禁与下一阶段

1. P1：Notion 专属数据库/组件语义、现有思源任务接入共用中心、分块断点续传、重复项人工修复和更完整锚点/引用支持。
2. P1：真实 100MB+ 思源/Markdown 包在 macOS、NAS、独立客户端与 Android 间的全文/附件哈希收敛；导入时离线编辑、冲突双方、代理断网与真实权限撤回。
3. P1：NAS/cgroup 低总内存与真实 S3，磁盘耗尽和断电验收。不能用本机 V8 heap 限制代替。
4. P2：稳定 Source Adapter 扩展约定与更多来源示例；WorkBuddy、Qoder/QoderWork、豆包工作、Claude Code、Codex 的实际应用/版本接入验收。当前仅 SDK transport 实测，不承诺宿主客户端同等支持。
5. Electron/Android 安装包、签名升级、CI、远端推送、合并与正式发布尚未执行。本阶段只有本地开发和验证，不修改 main/release/v1.5.4。

通用 ZIP 不含可信原始时间、标签或平台属性时不能凭空恢复它们；需要明确保留这些字段时应使用 NMF。未支持的字段名会进入报告，正文、凭据和平台密钥不进入状态响应或日志。
