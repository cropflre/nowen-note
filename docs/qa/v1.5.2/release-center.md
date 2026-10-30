# Release Center Phase 1 验收记录

> 本文保留首次交付的历史结果。后续修复与 Phase 2A 产物复核见 [最新记录](./release-center-artifact-review.md)。

2026-10-16，本机 macOS、Node `v24.18.0`；开发分支 `release/v1.5.2`。**本地 Phase 1 实现和模拟边界回归通过；远端调试工作流尚未部署和实际构建；不能视为正式发布系统已验收。** Phase 2/3 未实现。

## 实际运行

执行 `cd tools/release-center && npm run build && npm start`，生产静态页面由本机 Node 服务提供，[http://127.0.0.1:4318](http://127.0.0.1:4318)。运行时未配置 GitHub Token、未启用调试派发，GitHub 只读查询使用真实公开 REST API。数据库位于 `/tmp/nowen-release-center-phase1-live/center.sqlite`，与应用数据隔离。

真实总览读到最新正式版本 `v1.5.1`。真实预检固定远端源码 `7dcc450ae6920aaf266790d6d8af59b3c360e370`，识别 root `package-lock.json` 为 `1.5.0`、目标/其他版本文件为 `1.5.1`；同时识别 `v1.5.1` Tag/Release 冲突，以及专用 workflow 尚不存在。调试按钮不可用；实际执行一次 Dry Run 后也按预期以 `preflight.failed` 结束（任务 `9050db6f-e9d3-4a69-86a3-379cf6c10456`，11:34:48–11:34:53），没有调用 dispatch 或执行构建。本次没有将这些结果伪装成通过。

截图来自真实运行的页面，包含真实 GitHub 只读结果，无填充假版本、假进度或假成功记录：

- [桌面总览](../../../tools/release-center/docs/screenshots/overview-desktop.jpg)
- [桌面向导](../../../tools/release-center/docs/screenshots/wizard-desktop.jpg)
- [实际预检阻断](../../../tools/release-center/docs/screenshots/preflight-desktop.jpg)
- [真实 Dry Run 阻断与审计](../../../tools/release-center/docs/screenshots/dry-run-blocked-desktop.jpg)
- [390px 窄屏向导](../../../tools/release-center/docs/screenshots/wizard-mobile.jpg)
- [390px 暗色向导](../../../tools/release-center/docs/screenshots/wizard-mobile-dark.jpg)

桌面检查尺寸 1440×1040，窄屏 390×844；窄屏页面宽度实测未超过视口。截图不代表桌面安装包或远端 CI 成功。

## 已执行验证

| 命令 | 实际结果 | 证据 |
| --- | --- | --- |
| `cd tools/release-center && npm test` | **38/38 通过**；真实 HTTP/SQLite/子进程，GitHub 边界模拟 | [单元与集成结果](../../../tools/release-center/docs/evidence/unit-tests.txt) |
| `npm run typecheck` | 通过；生产 build 亦先执行相同 `tsc --noEmit` | [类型检查结果](../../../tools/release-center/docs/evidence/typecheck.txt) |
| `npm run build` | 通过；Vite production bundle，JS 约 220 kB，gzip 约 69 kB | [构建结果](../../../tools/release-center/docs/evidence/build.txt) |
| `npm run test:browser` | **3/3 通过**；Chromium、真实页面和服务，GitHub 数据为测试 fixture | [浏览器结果](../../../tools/release-center/docs/evidence/browser-tests.txt) |
| `npm audit` | 本工具依赖 **0 漏洞**；不代表根应用依赖审计通过 | [npm audit JSON](../../../tools/release-center/docs/evidence/dependency-audit.json) |
| 根目录 `npm run test:microsoft-store` | **13/13 通过** | [既有 Store 回归](../../../tools/release-center/docs/evidence/existing-store-tests.txt) |
| 根目录 `npm run test:update-release` | **27/29 通过，2 失败**，没有忽略 | [既有发布回归全文](../../../tools/release-center/docs/evidence/existing-release-tests.txt) |

既有发布测试的两个失败：`Android release sync preserves a higher code for the same version`、`Android next release increments a code above the semver formula`，均报 `sed: first RE may not be empty`。测试使用临时 fixture，没有修改真实版本文件。旧脚本及测试没有改动；本机 BSD sed 兼容问题保留，不能报告旧发布套件全绿。新 debug workflow 的 contracts Job 选择 Ubuntu 执行这些既有测试，但**远端 Ubuntu 实际执行未运行**。

新依赖最初尝试沿用 Tailwind 3/PostCSS 旧版本，安装审计发现告警；最终使用独立 Tailwind 4/Vite 插件和已修复 PostCSS，当前工具依赖审计为 0。根应用依赖没有因此升级。

## 用户要求的场景

| 场景 | 实际验证 | 限制 |
| --- | --- | --- |
| 版本与 Tag 冲突 | 真实预检命中已有 Tag；模拟测试覆盖 Tag/Release/Draft | 不实际创建冲突 Tag |
| 版本文件不一致 | 真实预检命中 root lock；测试覆盖 lock 双位置和 Android | 没有自动修复版本 |
| 部分平台失败 | 模拟 Jobs 一成功一失败，整体失败并保留产物 | 未实际启动 Windows/macOS/Linux CI |
| 超时与取消 | 模拟超时、取消等待远端、取消与预检竞态 | 未取消真实 GitHub 工作流 |
| 重复点击 | 持久化幂等键，完成前后重复返回原任务；浏览器操作防重复 | 不保证人工在 GitHub 外部重复派发相同 UUID 的行为；发现重复会拒绝认领 |
| 服务重启 | 真实子进程在记录派发后退出 77，另一个进程打开同库、接管 stale worker、恢复 Run；dispatch 计数始终 1 | 远端 API 用 fixture，无真实远端写入 |
| API 限流/Token 失效 | 模拟 REST 429/403/401、退避、恢复与错误状态 | 不故意耗尽真实配额，不创建/撤销 Token |
| 产物缺失/SHA 错误 | 临时真实文件 SHA-512/大小/blockmap 校验，缺包和损坏阻断；过期 artifact 不能通过 | 大型真实安装包、远端 archive 下载与端到端 SHA 复核未运行 |
| Store 与 GitHub EXE 隔离 | 既有 13 项回归 + 新 workflow 无 Store publisher；manifest 拒绝 AppX/Lite | Store 安装、签名、认证、提交未运行 |
| 未确认不可正式发布 | 后端 publish/tag/docker/store/shell 路由全部 404，UI 禁用；debug 缺确认也被后端拒绝 | Phase 1 根本没有正式发布实现；Phase 2 仍须建立审批契约 |
| 已发布版本不可覆盖 | Tag/Release/Draft 冲突阻断；没有 asset upload/clobber 路由 | 不修改真实已发布 Release 进行破坏性测试 |
| 旧流程兼容 | 旧两份发布脚本、三份工作流均无 diff；既有测试按实际结果记录 | 两个 macOS sed 失败未修复；不能宣称旧流程端到端发版验证通过 |

## 文件清单

[逐文件交付清单](../../../tools/release-center/docs/evidence/file-list.txt)（包含后续新增内容；首次交付为 51 个文件）。

| 路径 | 内容 |
| --- | --- |
| `.gitignore` | 精确放行原本被 `release-*/` 忽略的工具目录 |
| `tools/release-center/package.json`、`package-lock.json` | 独立依赖和启动/检查/构建命令 |
| `tools/release-center/{index.html,tsconfig.json,vite.config.ts,tailwind.config.cjs,playwright.config.ts,.gitignore}` | 独立编译、样式、浏览器测试配置 |
| `tools/release-center/shared.ts` | 计划、任务、审计、GitHub 只读数据契约 |
| `tools/release-center/server/{index,app,errors,github,planner,store,engine}.ts` | 本机 API、Token 隔离、GitHub REST、预检、持久化、恢复和互斥 |
| `tools/release-center/src/main.tsx`、`src/style.css`、`src/components/ui.tsx` | 六页控制台、SSE、响应式和暗色模式、shadcn/ui 基础模式 |
| `.github/workflows/release-center-debug.yml` | 仅所选平台、固定 SHA 的无发布调试工作流 |
| `scripts/release-center-assets.mjs` | 复用已有校验、严格资产清单、SHA-256 manifest 和独立 staging |
| `tools/release-center/tests/` | planner/engine/GitHub/HTTP/manifest/workflow/restart 测试与浏览器 fixture |
| `tools/release-center/README.md` | 运行、权限、恢复语义、限制与英文概要 |
| `docs/architecture/release-center.md` | 实际审计、方案、页面、实施步骤和风险矩阵 |
| 本文、`tools/release-center/docs/{evidence,screenshots}/` | 实测结果、原始输出与截图 |

## 未运行 / 未交付

- 远端 debug workflow 安装与 dispatch；跨平台完整编译、原生重建、Electron 安装/启动、真实取消/超时、真实 artifact 下载验收。
- 真实 GitHub Token 权限探测与失效演练；实际权限最终由 GitHub API 判定，界面的服务端配置就绪不等于写权限证明。
- 全应用前后端单元/E2E、移动端、Docker、NAS、Linux desktop integration、iOS TestFlight 与 Microsoft Store 真机验收；本次工具隔离，未修改这些产品路径。
- Phase 2：Draft、正式资产接管/下载复核、发布审批、正式发布与已发布不可覆盖契约。
- Phase 3：Store/Docker Hub/NAS 分发与状态适配。

没有创建 Git 提交或推送；没有推送版本 Tag、创建/发布 GitHub Release、上传 Docker、TestFlight 或商店。保留工作区其他任务的修改。上线前先解决当前版本文件不一致和既有 macOS 发布测试失败，再审查安装专用 workflow 并执行真实调试构建验收。
