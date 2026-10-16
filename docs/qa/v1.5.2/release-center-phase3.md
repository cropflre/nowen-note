# Release Center Phase 3：实现范围与回归记录

> 后续 [Phase 2B 源码实现](./release-center-phase2b.md)增加 GitHub 正式候选、Draft 和审批路径，但未进行运行验收、写开关关闭。GitHub Release 审批不授权渠道分发；本页保留 Phase 3 当时的验证范围与结果。

2026-10-16，基线 `release/v1.5.2` / `e249719c`，实现分支 `codex/release-center-phase3`。最初按“直接实现 Phase 3，后续再测试”只进行静态检查；在用户后续要求“根据你的建议实现”后，补齐本地功能回归、修复和截图。**本轮通过隔离供应商夹具的单元/API、真实 Chromium 与构建验证，不代表真实渠道联调或正式发布验收。** 不复用前轮 59/59、4/4 或真实调试包校验结果作为本轮通过证据。

## 本轮代码

| 入口 | 行为与边界 |
| --- | --- |
| `#channels` 渠道分发页面 | 版本选择、加载/错误/空状态、三渠道卡片、观察历史、计划生成/恢复/重新生成、JSON 导出与人工回执；已运行桌面及 390px 暗色浏览器验证 |
| `GET /api/channels?version=X.Y.Z` | 仅读取独立 SQLite 中该版本的观察、计划和回执，不发起平台查询 |
| `POST /api/channels/refresh` | 调用固定渠道 GET API；并发去重、60 秒观察缓存；每次观察追加保存并审计，失败不伪装成功 |
| `POST /api/distribution/plans` | 固定已正式发布 stable Release、完整 Tag Commit；按选择渠道生成持久化、幂等且不可执行的交接计划 |
| `POST /api/distribution/receipts` | 验证计划/版本/SHA/渠道和明确确认，追加未核实的人工回执；证据 URL 不由服务端访问 |

`server/channels.ts` 中的 `ChannelAdapter` 提供 `observe` / `prepare` 接口。新增渠道需要审阅并修改代码注册，网页不能上传适配器代码或填写 Shell。新增三张表只位于本工具数据库；旧数据保持兼容，旧发布/Store/iOS workflow 与 legacy 脚本本轮没有修改。

## 适配内容

- **Store**：复用保留 Store ID、package identity 与 Publisher。服务端可配置 `NOWEN_RELEASE_STORE_ACCESS_TOKEN`，读取应用当前待提交/已发布提交，每次响应 ID 必须与请求 ID 一致，仅将 `X.Y.Z.0` 包版本归入本次版本；匹配的已发布状态优先于待审修订并阻止覆盖。凭据未配置、权限失败、未知状态、其他版本分别呈现。交接来源必须是同 Commit 的独立 Microsoft Store AppX 工作流，不能把 GitHub EXE 当成 Store 包。Token 不写前端、数据库或导出文件；不读取/保存 API 返回的签名上传 URL。
- **Docker Hub**：固定公开仓库与 `vX.Y.Z` Tag，保存 manifest digest、架构和大小的观察，不声称镜像内容已验证。已有 Tag 阻断覆盖，错误/未知状态不会成为执行依据。没有 Docker 登录或 push。
- **NAS**：仅识别同版本正式 Release 的 FPK/UPK；保留文件大小、GitHub 摘要及未下载验证标记，附带 Docker digest 引用用于后续核对。包库存不等于飞牛/绿联商店上架，不伪造统一商店 API。
- **回执**：Store/NAS 提交编号与人工状态单独追加记录，始终标明来源为维护者、平台未核实；不能覆盖自动观察、变成产物校验或正式审批。更改回执字段会撤销前端确认；幂等键相同但内容不同会拒绝。

## 当前阻断与未实现部分

Phase 2 的正式身份审批、正式产物接管/验证及发布事务尚未完成，因此所有交接计划保持 `executable:false`、`approval:not_connected`；执行按钮可见且禁用，不提供实际上传/分发 API。这是 Phase 3 的追踪与交接适配实现，**不能称为渠道自动发布已完成**。

Store Token 获取/自动刷新、私有 Docker 仓库认证、NAS 商店自动提交和其他未注册渠道尚未实现。没有配置或校验真实 Partner Center 凭据，没有实际平台 GET 联调或真实上传操作。

## 后续修复与实测结果

两个新增 Store 回归先失败再修复：同版本 pending 提交遮蔽 Published，导致没有显示已发布阻断；接口返回另一条合法提交 ID 时仅做集合检查，未核对请求 ID。现在逐次核对 ID、优先 Published。失败证据保留在 `channels-before-fix.txt`；本轮全部最终测试通过。

RC1 原测试命令在静态 import 执行后才设置测试数据库路径，实际复现数据库保护拒绝打开 `backend/data/nowen-note.db`（在打开前拒绝，没有访问用户数据库）。工作流五个入口改为预加载既有 `tests/setup-db-isolation.ts`，保护规则未变。保留原命令失败证据和五组修复后结果。未推送，因此不能声明远端 CI 已恢复。

| 命令 / 场景 | 本轮结果 | 证据（工具目录相对路径） |
| --- | --- | --- |
| `npm test` | 99/99；其中新增渠道用例 40 项，含真实 15 秒超时中止、原子回滚与新进程恢复 | `docs/evidence/phase3/unit-tests.txt` |
| `npm run build` | TypeScript `tsc --noEmit` + Vite 生产构建通过 | `docs/evidence/phase3/build.txt` |
| `npm run test:browser` | 7/7；新增渠道 3 项，保留旧控制台 4 项 | `docs/evidence/phase3/browser-tests.txt` |
| 根目录 `npm run test:update-release` | 33/33 | `docs/evidence/phase3/existing-release-tests.txt` |
| 根目录 `npm run test:microsoft-store` | 13/13 | `docs/evidence/phase3/existing-store-tests.txt` |
| RC1 五组测试 + 预加载 | 19/19（7+4+2+5+1） | `docs/evidence/phase3/extension-*.txt`、`plugin-update-recovery-matrix.txt` |
| `node --test scripts/tests/official-registry-trust-roots.test.mjs` | 通过 | `docs/evidence/phase3/registry-tooling-tests.txt` |
| `node scripts/generate-plugin-host-api.mjs --check` | 通过 | `docs/evidence/phase3/host-api-contract.txt` |
| backend `npm run build:tsc` | 通过 | `docs/evidence/phase3/backend-typecheck.txt` |

工具及根脚本使用本机 Node 24.18.0。RC1 安全测试使用已有 Electron-as-Node 20.18.0 / ABI 130，与已安装 `better-sqlite3` 匹配；没有切换或重建项目原生模块。修复后的 GitHub CI 配置仍使用 Node 22，本轮没有运行远端 Ubuntu CI，不能将本机结果当作相同环境证明。所有数据库均为系统临时目录中的隔离夹具。

浏览器采用真实 HTTP、SQLite、React 和 Chromium，GitHub / Store / Docker 查询由固定夹具替代，未调用真实平台。截图为实际渲染的**夹具界面**，不是实际商店状态或实际提交：

- [桌面](../../../tools/release-center/docs/screenshots/phase3-channels-desktop-fixture.jpg)
- [390px 暗色](../../../tools/release-center/docs/screenshots/phase3-channels-mobile-dark-fixture.jpg)
- [窄屏交接计划](../../../tools/release-center/docs/screenshots/phase3-handoff-mobile-dark-fixture.jpg)
- [错误状态](../../../tools/release-center/docs/screenshots/phase3-channels-error-fixture.jpg)

覆盖矩阵：

| 项目 | 必须覆盖的行为 | 当前状态 |
| --- | --- | --- |
| 平台读取 | Store 401/403/429、错误应用/提交身份、版本不符、未知状态、Published 优先；Docker 404/429、错误 Tag/缺 digest；NAS 缺包、错误版本文件名 | 夹具通过；真实平台未联调 |
| 发布隔离 | Draft/未发布来源拒绝，AppX 与 EXE 不混用，已有 Docker Tag 不可覆盖；所有执行/上传接口 404 | 通过；未执行任何真实发布 |
| 幂等和恢复 | 重复点击、同键不同内容、刷新并发、新进程恢复计划/观察/回执；已有计划表兼容、失败事务回滚 | 通过；临时 SQLite |
| 安全与审计 | 旧 Host/Origin/session 与新增渠道路由保护、Token 脱敏、证据 URL 不发请求、固定 API 域、真实截止中止、响应体上限、未知字段拒绝 | 通过；供应商网络边界为夹具 |
| 页面 | 移动端、暗色、空状态、错误状态、迟到响应、导出 JSON、回执确认失效与重载恢复 | Chromium 通过；其他浏览器未运行 |

未运行：真实 GitHub/Partner Center/Docker Hub API 联调、真实商店提交/镜像上传/NAS 分发、签名包安装和设备验收、远端 Ubuntu CI；没有本次真实构建包。Phase 2 的正式链仍未实现，控制台实际分发继续禁用。本轮没有提交、推送、Tag、Release 或上传操作。

## 文件与接口依据

主要实现：`tools/release-center/server/channels.ts`、`src/components/ChannelsPanel.tsx`、`shared.ts`、`server/app.ts`、`server/index.ts`、`src/main.tsx` 和 README。新增测试：`tests/channels.test.ts`、`tests/channels-fixture.ts`、`tests/channels-restart-fixture.ts`、`tests/browser/channels.spec.ts`，并接入浏览器服务夹具；CI 修复仅修改 `.github/workflows/extension-ecosystem-rc1-ci.yml` 的五条测试入口。完整本任务文件清单见 `tools/release-center/docs/evidence/phase3/file-list.txt`，无关 MCP lockfile 与工作记录不属于本任务。

接口按官方文档编写，文档查阅不等于实际调用验证：[Microsoft 应用查询](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-an-app)、[Microsoft 提交查询](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-an-app-submission)、[Docker Hub Tag 查询](https://docs.docker.com/reference/api/hub/latest/operations/GetRepositoryTag/)。
