# Release Center Phase 2A：产物复核与本地验收

> 历史记录：保留本轮本地验收时的状态。后续工作流部署、真实三平台构建与下载校验结果见 [远端调试验收](./release-center-remote-debug.md)。

2026-10-16，`release/v1.5.2`，本机 macOS / Node `v24.18.0`。本轮完成 Phase 1 的两个本地阻塞修复，以及 Phase 2 第一段的调试产物复核、持久化结果和本地验收。**远端真实构建仍未验收；Draft 创建、正式发布审批与正式发布未实现。**

## 本轮结果

- root lockfile 顶层和 `packages[""]` 的两个版本标签从 `1.5.0` 对齐到应用当前 `1.5.1`，依赖版本未改变，没有升级发行版本。
- macOS 失败根因在 root/backend package 版本替换：BSD sed 的范围地址与空 `s//` 组合会报 `first RE may not be empty`。两处替换改为显式完整正则，GNU 分支、Android versionCode 规则、Dry Run 无写入和原发布职责保留。
- 既有 SHA-512 helper 改为 1 MiB 缓冲区读取。空文件、完整块与尾部不足一块的结果与直接 crypto 摘要一致，避免下载大型安装包时整文件读入内存。
- 修正 Linux 调试产物清单：electron-builder 对 x64 的 AppImage 使用 `x86_64`、deb 使用 `amd64`。新增与已安装 `builder-util.getArtifactArchName` 的契约断言，以及真实 Linux 文件名 ZIP 复核用例；不改变正式产物命名。
- 预检新增固定源码 SHA 的 manifest 生成器及平台清单接口比对，候选提交缺失或接口不一致时，调试构建不能派发。
- 新增只读 `verify` 任务：固定源任务、版本、源码/工作流 SHA 和 Run ID；从固定 GitHub artifact ID 下载，校验 archive digest，再安全解压并复用已有更新资产校验。
- 校验成功后展示逐文件名称、架构、大小、SHA-256、更新元数据和 archive digest；输入准确版本并确认“仅调试验收”才能保存本地验收记录，重复操作幂等。

## 已执行验证

| 命令 | 实际结果 | 证据 |
| --- | --- | --- |
| 工具目录 `npm test` | **58/58 通过** | [单元与集成](../../../tools/release-center/docs/evidence/phase2a/unit-tests.txt) |
| `npm run test:browser` | **4/4 通过**，Chromium | [浏览器结果](../../../tools/release-center/docs/evidence/phase2a/browser-tests.txt) |
| `npm run typecheck` | 通过 | [类型检查](../../../tools/release-center/docs/evidence/phase2a/typecheck.txt) |
| `npm run build` | 通过，JS 约 225 kB / gzip 70 kB | [生产构建](../../../tools/release-center/docs/evidence/phase2a/build.txt) |
| `npm audit` | 本工具依赖 0 漏洞 | [依赖审计](../../../tools/release-center/docs/evidence/phase2a/dependency-audit.json) |
| 根目录 `npm run test:update-release` | **33/33 通过**；原有两项 macOS 失败已解除 | [旧发布回归](../../../tools/release-center/docs/evidence/phase2a/existing-release-tests.txt) |
| 根目录 `npm run test:microsoft-store` | **13/13 通过** | [Store 隔离回归](../../../tools/release-center/docs/evidence/phase2a/existing-store-tests.txt) |

单元测试使用真实 ZIP 文件、SQLite、文件摘要、worker 与本地 HTTP，GitHub 边界使用模拟响应。既有真实子进程崩溃恢复用例继续通过；新校验重启用例验证中断后打开同一数据库恢复，只重复只读下载，不再 dispatch。浏览器测试包含向导、Dry Run、SSE、刷新恢复、窄屏/暗色、下载复核和版本确认，验收后 `/api/publish`、`/api/drafts` 仍返回 404，正式发布按钮仍禁用。

新增失败路径覆盖：错误/缺失 archive digest、manifest 来源不符、非更新器引用文件 SHA 被改写、SHA-512 错误、过期或其他 Run 的 artifact、部分平台失败、危险 ZIP 路径/链接/重复名称、额外/缺失文件、解压配额、取消/超时、服务停止/恢复、未知持久化任务类型不得派发工作流，以及下载地址白名单和签名 URL/Token 脱敏。

## 实际运行与截图

正常控制台已更新并运行在 [127.0.0.1:4318](http://127.0.0.1:4318)，继续使用独立的 `/tmp/nowen-release-center-phase1-live/center.sqlite`。没有向真实数据库注入构建成功或验收成功数据。

新页面的交互检查使用独立测试服务与临时 SQLite、真实生成的小 ZIP，**不是 GitHub 安装包，也没有实际 Windows 编译**。截图内显示 `Browser fixture only: not an actual GitHub build`，单个测试安装包仅 48 B；用于证明页面和校验流程运行，不能当作构建验收：

- [逐文件复核结果（测试 ZIP）](../../../tools/release-center/docs/screenshots/phase2a-verified-fixture.jpg)
- [明确确认并刷新后的本地验收记录（测试 ZIP）](../../../tools/release-center/docs/screenshots/phase2a-accepted-fixture.jpg)
- [390px 暗色验收页面（测试 ZIP）](../../../tools/release-center/docs/screenshots/phase2a-mobile-dark-fixture.jpg)

窄屏 DOM 实测 `scrollWidth=390`、`innerWidth=390`，文件表格在自身区域横向滚动。截图测试服务与正常控制台隔离，验证后停止并清理临时数据。

## 边界与风险

| 事项 | 处理与实际限制 |
| --- | --- |
| 下载凭据 | 仅向固定 GitHub REST API 发送服务端 Token；存储域不带 Authorization；只允许 GitHub 返回的受限 HTTPS 存储地址 |
| 下载/解压 | archive、单文件各 2 GiB，平台解压合计 6 GiB，最多 64 个平面文件；manifest 128 KB、更新元数据 2 MB；不执行包内文件 |
| 响应性 | hash 与旧同步元数据校验在无凭据 worker 内执行；下载/解压使用流；失败、取消和超时后清理本任务临时目录 |
| 重启/并发 | 校验任务持久化、与构建共用互斥；服务停止保留任务，重启重新下载复核；取消本地校验不会取消原 GitHub Run |
| 本地验收 | 绑定版本、源码/工作流 SHA、平台、artifact ID 和摘要；不是身份核验、多人审批或正式发布许可 |
| 旧流程 | 旧逻辑只改两处 BSD sed 和 SHA-512 读取方式；新增独立 debug 平台清单契约，三份既有 workflow、正式 publish 职责、Store/EXE 分流均未改 |
| 文件保留 | 只持久化校验证据；临时安装包在校验结束后清理。正式接管、永久保存和发布资产仍待后续设计 |

## 远端状态与未运行项目

本轮只读查询 GitHub：仓库默认分支为 `main`，查询 `release-center-debug.yml` workflow 返回 **404**。未推送本轮代码，远端固定 SHA 仍不含本地修复，因此真实预检仍可能显示远端 root lock 的 `1.5.0` 和缺失 manifest/workflow。不能将本地文件已修复理解为远端已就绪。

以下均**未运行**：远端工作流安装/dispatch；Windows/macOS/Linux 真正打包、安装和启动；真实 GitHub 大型 archive 的下载与全链路验收；GNU/Linux 与 Windows 实机执行；全应用前后端全量回归；Docker、iOS、NAS、Store 发布/设备验收。当前 macOS 回归不能代替这些平台。

下一步应先审查并提交隔离工具与修复，按受控方案让默认分支识别专用 workflow、准备不存在 Tag/Release 冲突的候选版本提交，再进行真实调试构建和下载复核。之后才能推进正式候选构建、Draft、独立发布审批和发布。不得用未签名 debug 的本地验收代替正式发布审批。

没有提交或推送代码，没有推送版本 Tag，没有创建 Draft/正式 Release，也没有上传 Docker、TestFlight 或应用商店。文件清单见 [逐文件交付清单](../../../tools/release-center/docs/evidence/file-list.txt)。
