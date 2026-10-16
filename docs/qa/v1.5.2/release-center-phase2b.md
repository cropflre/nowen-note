# Release Center Phase 2B：正式候选接管、Draft 与审批源码

日期：2026-10-16。开发分支 `codex/release-center-phase2b`，从已合入 `release/v1.5.2` 的 Phase 3 提交 `130c9bc6` 继续。用户明确选择“继续 Phase 2 开发，测试延后”。**本轮为源码实现与静态检查，所有新增功能、浏览器、构建、重启恢复和平台联调测试均未运行，不能视为验收通过或可发布。** 前轮 99/99、7/7 等结果只属于 Phase 3，不能作为本轮证据。

## 本次范围与兼容设计

旧 `release.sh` 仍是正式发布入口，`release-legacy.sh`、`release.yml`、Store 和 iOS workflow 均不修改。新控制台先接管**已经存在 Tag、已经成功结束的 `release.yml` push 构建**，不推新 Tag，不 dispatch，不调用旧脚本，不上传 Docker 或商店。因此本次不承诺消除旧流程自身在推 Tag 时触发 iOS 的副作用；这个动作已经在控制台之外发生，页面明确说明。

实际正式资产范围固定为 Windows x64 Full **和 Lite**、macOS Intel/Apple Silicon、Linux x64。该入口不提供部分平台选择，缺少任一平台、过期或重复 artifact 都阻断。调试 workflow 的 `workflow_dispatch`、调试 manifest、同名但不同 SHA/Tag/attempt 的构建不接受。正式构建编排仍是下一步工作，不能把已有调试 dispatch 改名冒充正式构建。

导入固定源码 SHA，要求 root/backend package/lockfile 与 Android 版本一致，并在导入、审批及发布前读取检查状态：Tag 必跑的 `rc1-security` 必须成功，其他已产生的检查也不能未完成或失败。`console-contracts` 受路径过滤，不保证每个发版 SHA 都有，出现时同样必须成功。正式 workflow 及已有资产/更新元数据校验模块与服务端审计版本不同则阻断；后续改动需先审阅更新服务端。

## 已编写流程

1. **接管并复核**：绑定 Tag、Run ID、run attempt 与完整 Commit；保存互斥任务，逐平台查询 GitHub artifact 元数据、下载 ZIP、验证 archive digest、限制解压，再使用既有更新校验模块核对内容与 SHA-512，并计算逐文件 SHA-256。Windows 必须同时包含 Full/Lite，metadata 不能交叉引用。文件内容校验不证明签名、公证、安装或设备验收。
2. **准备 Draft**：独立服务端开关和发布 Token、固定 GitHub 用户 ID、仓库写权限、准确 Tag 和明确 Draft 确认缺一不可。仅创建本工具自己的未发布 Draft；已有同版本 Draft/正式 Release 一律不接管、不覆盖。版本预留防止另一候选争用。重新下载复核同一批 archive 后只上传原始清单文件；同名文件必须摘要/大小完全匹配，否则阻断，永不删除或 clobber。
3. **正式审批**：再次核对来源 Run/Tag、Draft 身份、作者、说明、文件 ID/大小/digest 与原始证据，记录服务端 Token 的 GitHub User 主体，审批绑定全部远端证据并保留时间；相同未过期确认幂等。人工输入的用户名不作为身份。这里是本机维护者与服务端凭据主体的审批记录，**不是多人登录或四眼审批**。
4. **正式发布**：还需要独立发布开关、30 分钟内有效审批、同一维护者和第二次明确发布确认。源、文件或说明变化后拒绝；不能发布比当前 latest 更旧或相同版本。只将绑定 Draft 转正式，禁止覆盖既有正式 Release。GitHub Release 审批不授权 Store/Docker/NAS 分发。

以上写步骤只是源码能力；本轮未配置或启用发布凭据、未执行这些远端写操作。

## 持久化与异常处理

在工具 SQLite 增量创建 `release_candidates`、`release_reservations`；使用既有任务 UUID、幂等键、单 active 索引、worker 所有权、SSE、日志脱敏与审计。正式任务不会进入 debug dispatch 分支；取消正式候选操作也不取消其原始 GitHub 构建。

每次 Draft/asset/publish 请求前先持久化写入意图。断网、5xx 或服务重启后只读取远端对账，不自动再次 POST/PATCH。只允许**写请求本身**收到确定的 4xx 拒绝时清除意图；对账 GET 失败（包含 Token 失效/限流）不能清除未知写入，也不能释放互斥。限流有持久化退避。

只读复核被重启中断后重新下载校验，临时目录仅在系统临时目录创建并在结束/失败时清理。取消和超时停止下载；不明写入仍保持对账与互斥。已经确认发布成功时，即使收到并发取消也记录已发布，不能声称取消撤回了发布。已创建的 Draft/远端文件不自动删除回滚。外部维护者不得同时运行旧发布器或改动同一 Tag/Release；控制台的本地互斥不能约束外部发布者，GitHub API 不提供跨 Tag/Release 的原子事务。

## 页面与 API

新增“正式候选”页，导入表单、固定 SHA/证据、文件清单、阶段状态、错误、各步独立确认与禁用说明。正式任务在构建任务页展示审计与既有源 Run 的完成日志，重试导航返回正式候选页，不对 Tag 使用普通分支预检。

| API | 行为 |
| --- | --- |
| `GET /api/publication` | 本机候选与有效开关，不含 Token |
| `POST /api/publication/import` | 严格输入 version/runId/notes/key，建立完整桌面只读复核任务 |
| `POST /api/publication/:id/draft` | 精确 Tag、digest、幂等键和 `confirmDraft:true`，另需服务端开关与身份 |
| `POST /api/publication/:id/approve` | 精确 Tag/digest 和 `confirmApproval:true`，读远端后记录固定审批 |
| `POST /api/publication/:id/publish` | 精确 Tag/digest、幂等键和 `confirmPublish:true`，另需有效审批及发布开关 |

全部沿用 loopback Host/Origin/session/操作头保护；未增加网页 Token 表单、任意 Shell、可配置 API 域名或 Tag 写 API。旧 `/api/publish`、`/api/drafts` 仍不存在，现有调试接口不变。

服务端新配置默认均不启用：

| 配置 | 默认 | 用途 |
| --- | --- | --- |
| `NOWEN_RELEASE_PUBLISH_TOKEN` | 空 | 独立服务端 GitHub 用户 PAT；正式写操作使用 Contents 写权限，不借用调试 Token |
| `NOWEN_RELEASE_MAINTAINER_ID` | `0` | 固定获准 GitHub User 的数值 ID，需与 PAT `/user` 身份和仓库权限一致 |
| `NOWEN_RELEASE_DRAFTS` | 关闭 | 仅 `1` 才开放 Draft/审批路径；不能代替网页明确确认 |
| `NOWEN_RELEASE_PUBLISH` | 关闭 | 还需 Draft 开关、有效审批及网页再次确认才可能发布 |

测试和平台验收完成前保持开关关闭。某些目标 Commit 涉及 workflow 变更时，GitHub 可能额外要求 Workflows 写权限；本工具不会自动扩大权限。

## 本轮验证与后续验收

- 已执行：工具 `npm run typecheck`、新增 MJS `node --check`、`git diff --check`、文档相对链接检查；实际最终结果见交付消息及 `tools/release-center/docs/evidence/phase2b/`。
- 已编写但**未运行**：`tests/publication.test.ts`，覆盖导入来源/版本/关键 CI、完整平台、拒绝调试包、Full/Lite ZIP 校验、确认与身份开关、重复导入、已有正式版本、全局互斥、取消，以及不明写入限流后恢复和发布/取消竞态。
- **未运行**：新增/旧单元和集成回归、浏览器、生产构建、真实进程崩溃/恢复、平台 API 联调、实际 artifact 下载、Draft 创建/文件上传/审批/发布、签名与设备验收。本轮没有新运行截图，Phase 3 截图不能作为正式候选页面证据。
- 尚待实施：由独立受控 workflow 编排正式候选构建而无需先由外部创建通用 Tag；将其构建权限、签名凭据和平台副作用独立审计验证。Store/Docker/NAS 的内容验证、独立审批及上传仍不在本次 GitHub Release 链中。

| 风险 / 验收点 | 源码约束 | 运行验收 |
| --- | --- | --- |
| 未确认发布、已发布覆盖、旧版本成为 latest | 独立开关、身份、两步确认、证据/版本检查 | 未运行 |
| 部分平台或调试包成为正式资产 | 正式 Tag Run、三个固定 artifact、Full/Lite 严格清单 | 未运行 |
| 重复写入、服务重启后重发 | 持久化意图、只读对账、版本预留和全局互斥 | 未运行 |
| Token 失效、限流、下载超时/取消 | 脱敏、退避、AbortSignal、不明结果保持互斥 | 未运行 |
| 原正式流程被改变 | 不改旧发布脚本和三个已有渠道 workflow | 旧回归本轮未运行 |

API 依据：[GitHub Release 创建/更新](https://docs.github.com/en/rest/releases/releases)、[资产上传与 digest](https://docs.github.com/en/rest/releases/assets)、[认证用户](https://docs.github.com/en/rest/users/users)。文档查阅不等于平台调用验证。
