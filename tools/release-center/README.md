# Nowen Release Center · Phase 3

独立维护者控制台，面向本机单人使用。与 Nowen Note 的前端、后端、Electron 和用户数据隔离。提供只读总览、版本预检、发布计划、Dry Run、隔离桌面调试构建、任务进度、日志和审计；Phase 2A 增加调试产物下载复核与本地验收记录。

**Phase 2B 新增正式候选接管、Draft、审批和发布接口源码；已通过本地隔离 GitHub API 的完整发布链 CI 测试（含真实 ZIP/摘要校验、Draft、16 个文件模拟上传、审批、发布及网络中断恢复），但真实 GitHub Release API 联调、真实签名/安装和商店分发仍未验收。正式写开关继续默认关闭。** 仅接管既有 `release.yml` 的成功完整桌面 Tag 构建，不推 Tag、不 dispatch，不接管其他发布器的 Draft，也不允许调试包晋升。独立构建编排仍待实现，详见 [Phase 2B 原始实现与未验收记录](../../docs/qa/v1.5.2/release-center-phase2b.md) 和 [后续模拟发布闭环验收](../../docs/qa/v1.5.3/release-center-p0-simulation.md)。

Phase 3 增加“渠道分发”页、Store / Docker Hub / NAS 状态观察、不可执行的分发交接计划、JSON 导出与人工平台回执。后续回归已通过工具单元/接口测试、真实浏览器测试和生产构建；外部平台使用隔离夹具，**尚未实际联调或验证渠道自动发布**。正式上传与商店提交仍未开放，须先完成 Phase 2 正式审批和渠道产物校验。

## Phase 2C · 独立桌面候选构建（不发布）

新增 [release-center-candidate.yml](../../.github/workflows/release-center-candidate.yml)，在 GitHub Actions 中手动输入固定源码 SHA、稳定版号 X.Y.Z 和 UUID，即可尝试编译 Windows Full/Lite、macOS Intel/Apple Silicon 与 Linux 候选包。使用服务端只读权限和 `--publish never`，不创建 Tag、Draft、Release，不推 Docker 或 TestFlight。每个平台分别输出安装候选和来源/摘要 JSON 证据；**候选包未签名、未正式审批，不能导入 Phase 2B 作为正式 Tag Release**。

独立工作流须先注册至 GitHub 默认分支、候选 SHA 必须包含 staging 脚本，并经受控实际三平台验证才能作为可靠构建入口。正式发布写权限仍应关闭。细节与未验收项见 [Phase 2C 实现记录](../../docs/qa/v1.5.3/release-center-phase2c.md)。

## 启动

需要 Node.js 24+（使用内置 `node:sqlite`），安装本工具自己的依赖，不需要切换应用的 `better-sqlite3` ABI。

```sh
cd tools/release-center
npm ci
npm run build
npm start
```

访问 [http://127.0.0.1:4318](http://127.0.0.1:4318)。开发模式为 `npm run dev`，Vite 通过同一个服务提供页面，不使用跨域 Token。不要将该控制台反向代理到公网或直接扩展为多人服务；那需要独立身份认证、授权和部署审计。

## 服务端配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `NOWEN_RELEASE_PORT` | `4318` | 只监听 `127.0.0.1` |
| `NOWEN_RELEASE_DATA` | `~/.nowen-release-center` | SQLite 和 WAL 的独立目录，应位于本机磁盘 |
| `NOWEN_RELEASE_GITHUB_TOKEN` | 未配置 | 服务端专用 fine-grained PAT；公开查询可不配置 |
| `NOWEN_RELEASE_DEBUG` | 关闭 | 明确设置为 `1` 才允许 dispatch |
| `NOWEN_RELEASE_WORKFLOW_REF` | `release/v1.5.2` | 管理员控制的可信 workflow 分支；不能由网页输入改变 |
| `NOWEN_RELEASE_STORE_ACCESS_TOKEN` | 未配置 | 服务端 Partner Center Access Token；仅用于 GET 应用/提交查询，不接受浏览器配置，不保存或导出 |
| `NOWEN_RELEASE_PUBLISH_TOKEN` | 未配置 | 独立服务端用户 PAT，正式 Draft/发布使用 Contents 写权限，不能放前端 |
| `NOWEN_RELEASE_MAINTAINER_ID` | `0` | 固定有写权限的 GitHub User 数值 ID；需与发布 PAT 主体一致 |
| `NOWEN_RELEASE_DRAFTS` | 关闭 | `1` 才开放 Draft 与审批；本轮未验收，保持关闭 |
| `NOWEN_RELEASE_PUBLISH` | 关闭 | `1` 才允许已有审批的正式发布，还需每次明确确认；本轮保持关闭 |

只读/调试 Token 最小权限：目标仓库 Contents 读取、Actions 读取；启用调试才需要 Actions 写入，无需 Contents 或 Packages 写入。正式写操作另用发布 PAT，不借用调试 Token；目标提交含 workflow 变更时还可能需要 GitHub 要求的 Workflows 写权限。所有 Token 从服务进程环境读取；不接受浏览器提交，不返回浏览器，不传递到打包脚本，不写入任务数据库。凭据轮换后重启服务，持久化任务继续对账。

启用调试前，应先由维护者审查并将 `.github/workflows/release-center-debug.yml`、`scripts/release-center-assets.mjs` 和工具代码纳入仓库。GitHub 要求 dispatch 工作流在默认分支可被识别；工作流控制分支也必须包含该工作流。2026-10-16 已通过 PR #859 注册默认分支的专用工作流，PR #858 随后合入 `release/v1.5.2`。历史真实调试使用 `NOWEN_RELEASE_WORKFLOW_REF=codex/release-center-debug-v1.5.2`，源码固定为 `f1066e49`。控制分支应受保护、限制修改发布工作流；临时候选分支没有配置保护，不能据此宣称生产发布治理已就绪。服务会比较远端与本地审计过的 workflow 内容，并记录工作流 SHA；还会检查候选源码 SHA 中的 manifest 生成脚本及平台资产清单是否与已审计版本一致，缺失或不一致都不会派发。

网页不会修改版本号。先在独立提交中准备好 root/backend `package.json` 与两份 lockfile 的顶层及 `packages[""]` 版本、Android `versionName`，再预检。计划固定远端分支 SHA；存在同版本 Tag、Draft 或已发布 Release 会阻断，无法查询则标记未知。计划有效期 30 分钟，执行前再次预检；分支或工作流变化需要重新预览。

## 执行语义

- **Dry Run**：仅重新检查计划、版本与冲突并保存审计；不执行 `release.sh`，不编译、不安装应用依赖、不运行正式发布脚本。成功只代表计划检查完成。
- **调试构建**：需要通过预检、服务端开关/凭据和网页明确确认；专用工作流只构建所选 Windows x64、macOS x64/arm64、Linux x64 的 Full 版本。没有 Lite、Store、iOS、Docker、NAS 发布适配。
- **渠道**：stable 支持调试打包；prerelease 支持计划与 Dry Run，其更新元数据渠道适配尚未实现，调试按钮保持禁用。
- **关键测试**：预检展示固定 SHA 的现有 CI 证据；不是正式发布全量门禁。专用工作流的 Ubuntu contracts Job 执行既有发布和 Store 隔离测试。构建使用 Node 22 与已有 Electron 配置及原生模块重建脚本。
- **产物**：打包器固定 `--publish never`，未签名、未公证，只上传 `rc-debug-<task UUID>-<platform>` artifact，保留 7 天。上传前复用 SHA-512、大小、blockmap、更新元数据校验，再生成逐文件 SHA-256 manifest。只从校验后的独立 staging 目录上传。
- **校验层次**：界面展示 GitHub artifact 压缩包的 digest，文件大小、架构和 SHA-256 在内含 manifest 中。在产物管理中点击“下载并复核全部平台”才会建立本机校验任务；完成前仍标记“未下载验证”。校验 archive digest、来源、manifest、每个文件的 SHA-256 和已有更新元数据约束后，显示逐文件结果。人工输入版本并勾选说明才能记录本地调试验收；这不代表正式可发布资产。
- **日志**：每 5 秒对账 GitHub Jobs/Steps；SSE 每 2 秒推送变化。GitHub 完整 Job 日志在 Job 结束后由维护者点击读取；最多读取 2 MB，脱敏后超出 100,000 字符的日志保存首尾摘要，明确标记截断。完整日志可在 GitHub 查看。SQLite 保留所有审计；页面显示最近 100 个任务及 500 条审计。

## 幂等、互斥和恢复

SQLite WAL + FULL 同步持久化计划、任务、状态变更和审计；唯一索引保证同一数据库同时只有一个活动任务，worker PID 防止同一数据库运行两个服务。workflow 自身也采用仓库级 concurrency。服务仅支持本机单实例，不支持共享文件系统多机集群。

网页按计划与模式保存幂等键；重复点击返回原任务，已完成任务也不会因同一个键再次执行。“重新预检并重试”会生成新计划，重新确认后才能建立新任务。

服务在请求 GitHub **之前**原子保存 `dispatch.intent`。崩溃或网络错误后，只通过唯一 run-name 查找对应工作流，绝不自动再次 dispatch。Run ID 固定后继续恢复 Jobs 和 artifact 状态。部分平台失败、缺少或过期 artifact 都不能标记成功。

取消和超时先请求 GitHub 停止；必须收到远端完成状态才释放本地互斥。排队中尚未派发的任务可以直接结束。超过 10 分钟仍找不到 Run 时显示派发结果不明并保留互斥；这可能是“写入意图后、实际请求前”崩溃。需要维护者到 GitHub 核实，**当前不提供危险的自动解锁或自动补发**，不要删除数据库以绕过它。GitHub Token 失效、限流或断网时保留任务；恢复权限后继续对账，限流有退避。

GitHub dispatch 使用可信分支 ref，源码使用独立的固定 SHA。两者分别记录。若实际 workflow SHA 与预检不一致，服务拒绝认领并要求人工检查；受保护控制分支是必要的运行前提，不能靠 UI 校验代替分支治理。

## 产物复核与本地验收

校验使用独立的持久化 `verify` 任务，继承源调试任务的版本、源码 SHA、工作流 SHA 和 Run ID。只接受成功的调试构建，并重新查询 GitHub Run 与 artifact 的来源、有效期、大小及 digest。网络下载仅走固定仓库的 REST API 和 GitHub 返回的 HTTPS 存储地址；不会向存储域转发 Token，签名 URL 会脱敏。

archive 上限 2 GiB，单文件上限 2 GiB，每个平台解压总量上限 6 GiB，文件数上限 64；manifest 上限 128 KB，更新元数据上限 2 MB。单包下载最多 30 分钟，完整校验任务最多 90 分钟；任务截止和用户取消都能提前终止下载。拒绝嵌套路径、路径穿越、链接、重复名称、加密条目、额外文件、缺失文件与 SHA 不符。ZIP 以流方式读取，不执行其中任何文件。重型 SHA 与已有元数据校验在无凭据环境的 worker 中运行，保持 HTTP/SSE 响应；已有 SHA-512 helper 改为固定缓冲区读取，输出契约不变。

下载与解压目录仅为本任务创建的临时目录，结束、失败或取消后清理。数据库保存校验文件名、架构、大小、SHA、archive digest 和时间，不永久缓存安装包。失败保留已完成平台的结果，但不能建立验收记录；重试需要新校验任务。取消和超时等待本地下载/worker 停止后释放互斥，不取消源 GitHub Run。服务停止时中断只读校验，重启后重新下载复核，不重新构建。

本地验收要求全部所选平台通过，输入准确版本号并明确勾选“仅调试验收”。记录绑定源码/工作流 SHA 与产物证据摘要，重复确认幂等，不能覆盖不同证据。它由本机维护者操作，**不是多人身份审批、四眼审批或正式发布许可**。Phase 2B 正式候选使用独立的来源、证据与审批路径，不复用调试验收。

已存在的 Phase 1 JSON 任务与审计可在新版本继续读取；本工具尚未正式发布。

## 验证

```sh
npm test
npm run typecheck
npm run build
npm run test:browser
npm audit
```

浏览器测试使用真实 HTTP/SQLite/React 与模拟 GitHub 边界，不会运行远端构建。服务进程崩溃/重启测试使用真实子进程。真实三平台构建、16 个文件下载复核、CI 和未运行项目见 [最新验收记录](../../docs/qa/v1.5.2/release-center-remote-debug.md)；[Phase 2A 本地记录](../../docs/qa/v1.5.2/release-center-artifact-review.md)和 [Phase 1 历史记录](../../docs/qa/v1.5.2/release-center.md)保留当时结果；架构与实际仓库审计见 [设计记录](../../docs/architecture/release-center.md)。

## Phase 3 渠道追踪与交接

- 输入明确的 `X.Y.Z` 版本，点击“查询渠道”才调用外部只读 API；切换页面和 SSE 只读取本机已保存记录。相同版本并发查询合并，一分钟内复用观察结果。失败也保存为失败观察，历史成功结果仍在历史中，不能用旧成功伪装新状态。
- **Microsoft Store**：复用 `electron/storeIdentity.js` 的保留 Store ID、identityName 和 Publisher。可选 Token 只用于 Partner Center 的 GET 应用及提交查询，逐次核对请求与响应提交 ID，按 `X.Y.Z.0` 包版本关联，其他版本和未知状态不会显示为本版本已发布。同版本已发布记录优先于待审修订并阻止覆盖。Token 过期后在服务端轮换并重启；未实现自动换取/刷新凭据。
- **Docker Hub**：固定公开仓库 `cropflre/nowen-note`，查询明确的 `vX.Y.Z` Tag、manifest digest、架构和大小；不查询 `latest` 替代版本，不登录、不推送、不覆盖 Tag。平台 digest 只是元数据，未下载镜像或验证内容/签名。
- **NAS**：观察同版本已正式发布 GitHub Release 的 FPK / UPK；区分“包库存”和“商店上架”。交接数据包含 Docker digest 固定引用，但包内 manifest、镜像引用和固件兼容仍待核验，不假设飞牛/绿联有通用商店上传 API。
- **交接计划**：只接收已发布 stable Release，解析轻量/annotated Tag 到完整 Commit SHA；排除 Draft、调试包和未发布版本。Store 只关联同 SHA 的独立 AppX 工作流，不将 EXE 或 NAS 包作为 Store 包。计划绑定来源与观察时间，持久化幂等、只读导出 JSON，始终 `executable:false`、`approval:not_connected`。
- **人工回执**：Store/NAS 可记录提交编号、平台状态和无查询参数的 HTTPS 证据链接；版本/SHA 必须与不可变计划一致，明确确认后追加持久化，不覆盖旧回执。证据链接不由服务端访问，人工记录永远 `verifiedByProvider:false`，不能修改平台观察或成为正式审批。
- 新数据表在独立工具 SQLite 中增量创建，原计划/任务与应用数据库不迁移。没有新增执行渠道上传的 API、任意 Shell 或用户可配置外部 API 地址。

[Phase 3 实现范围、回归证据与未验证项](../../docs/qa/v1.5.2/release-center-phase3.md)。前文的历史测试结果不能代替 Phase 3 的验证结果。

## English scope

An independent, loopback-only maintainer console. Phase 2A adds read-only archive downloads, safe extraction, archive/file hash and updater-metadata validation, plus explicit local acceptance of unsigned debug artifacts. Existing read-only visibility, immutable plans, preflight, dry runs and isolated debug builds remain. GitHub credentials remain server-side. SQLite records idempotency, mutual exclusion and audit history; ambiguous dispatches are reconciled and never automatically repeated. Local debug acceptance never grants release authority. The isolated workflow is registered and actual Windows/macOS/Linux debug builds plus all 16 files passed archive/file/updater verification. Physical installation, human acceptance and production branch governance remain pending. Downloads are bounded to 30 minutes per archive and 90 minutes per verification task, with earlier cancellation/deadline enforcement.

Phase 2B adds source implementation for importing completed legacy Tag builds, full desktop artifact verification, owned Draft staging, identity-bound approval and separately confirmed publication. All write switches default off. Runtime, browser, build and provider tests for this addition are explicitly deferred; it is not accepted for publishing. New formal build orchestration remains pending. The console has no tag push, Docker upload or store submission API.

Phase 3 adds persistent channel observations, fixed-source handoff plans and explicitly unverified manual receipts for Microsoft Store, Docker Hub and NAS packages. Provider requests are GET-only; exported plans are non-executable and cannot grant publishing approval. Store credentials stay in the server environment. Submission IDs are checked against the requested IDs, and an already published package version takes precedence over pending revisions and blocks replacement. Follow-up unit/API and real Chromium checks plus the production build passed using isolated provider fixtures. Live provider integration and automatic distribution remain unverified and unavailable.
