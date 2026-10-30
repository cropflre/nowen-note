# Sync V2 reliability validation / 同步可靠性验证

第三批更新：个人 Native 结构接收、REST 提交通知、根文档移动恢复，以及 Android 新包证据见 [Native tree Pull validation](sync-v2-native-tree-pull-validation.md)。完整本地结构写入与冲突操作尚未接入。

第二批更新：2026-10-11 的 Native 个人根级/普通文件夹 MD/富文本创建、已授权个人正文持久化，以及新包 API Bridge 强杀恢复证据见 [Native tree validation](sync-v2-native-tree-validation.md)。下文保留第一批的原始结果与当时缺口；完整 Native 树结构和浏览器 Local-first 仍未完成。

日期：2026-10-11。基准 `d95d3787`；开发分支 `codex/sync-v2-reliability`。所有笔记正文均为临时测试数据。

## Phase 0

审计交付：`docs/sync-v2-reliability-audit.md`，commit `bd26fabe`。已核查 Issue #829 和合并后的 PR #821。架构图、平台读写路径、实体矩阵、问题清单和缺口见审计文件。

## Phase 1：数据一致性修复

| 已复现问题 | 修复与执行链路 |
| --- | --- |
| 远端永久删除丢掉本机离线正文 | `mobileSyncEngine.ts`：删除也经过 pending/冲突保护；正文、mutation 与远端删除标记同时保留 |
| 旧离线更新复活已永久删除的服务器笔记 | `apply.ts`/`sync-v2.ts`：带已有基线的更新不再当创建；返回可恢复删除冲突；恢复须另存新身份 |
| 本机同时保存标题/正文丢掉先前修改 | `nativeLocalRepository.ts`：读取当前笔记/权限/版本、更新业务和插入 Outbox 同个串行事务 |
| 无效 ACK 显示云端已确认 | `mobileNoteSyncReceipt.ts`：必须有有效正整数版本；`mobileSyncEngine.ts` 在出队前验证当前批次和版本，非法 ACK 保留队列 |
| 在途切账号后 JSON 解码继续接受旧 ACK | `mobileSyncEngine.ts`：传输取消、重试发送前校验 AbortSignal，JSON 解码后再检查会话；旧会话不宣告状态变化 |
| ACK 等待期间继续编辑导致自身冲突 | ACK 事务校准后续 baseVersion；批次内同笔记按服务端应用顺序接续版本；自身回声只认精确 mutation ACK 且读取最新 pending payload |
| 未记录本地 ACK 时崩溃，重启 Snapshot 误判已创建实体为冲突 | 持久化 mutationId 先重放 Push，再做首次/恢复 Snapshot；duplicate 结果与原队列出队同事务落盘 |
| 解决冲突后版本基线分叉 | keep-local 以远端版本生成新修订；冲突查询限定 Profile；未解决冲突阻止同实体的新队列静默上传 |
| Desktop 合并离线创建和编辑后携带错误已有版本 | `push.ts`：保持最早的缺失 baseVersion，创建不会因后续编辑变成更新 |

未使用清库/删除全部 Outbox/覆盖真实用户笔记；没有 schema 迁移或新增依赖。冲突台账保留双方。拒绝旧身份更新会让过去悄悄“重新创建”的客户端产生明确冲突；这是预期保护。永久删除后的保留本地须另存为新笔记，不能复用旧 ID。

自动化结果：

- `sync-v2-mobile-multidevice.test.ts`：12/12。独立磁盘上的三客户端 SQLite + 独立服务器 SQLite，真实 HTTP/Hono Sync V2 路由；覆盖 Markdown/富文本、双向和三端收敛、并发、close/reopen、丢失 ACK、重复 mutationId、Apply/Outbox 失败、永久删除、自身回声、非法收据。
- 后端组合 `sync-v2-protocol.test.ts`、`sync-v2-engine.test.ts`、`sync-v2-mobile-multidevice.test.ts`、`encrypted-notes-sync.test.ts`：84/84。
- 前端目标组合 `mobileSyncEndpoint`、`mobileNativeReceiptIntegration`、`mobileSyncUnknownEntity`、`mobileSyncUnexpectedFailure`、`mobileNoteSyncReceipt`、`nativeLocalNoteList`：35/35；另一次含目录密码与 #829 既有 fallback 的组合：70/70。
- `node scripts/data-consistency-contract.mjs --verify`：12 条契约、56 个用例引用；新增 DCC-012 已进入既有门禁。
- 前端 `npm run build`：通过。此后源码变更仍须最终再构建；不能用该中间构建证明最终 APK。

测试执行方式：Windows 的 `better-sqlite3` 是 Electron ABI，必须使用 `ELECTRON_RUN_AS_NODE=1` 的项目 Electron，参数为 `--import ./backend/node_modules/tsx/dist/loader.mjs --import ./backend/tests/setup-db-isolation.ts --test <目标文件>`。PowerShell 对 GUI exe 应使用 `Start-Process -WindowStyle Hidden -Wait -PassThru` 并检查 `ExitCode`。直接 Node 因 ABI 不符没有运行成功；未加载隔离 setup 的加密套件最初失败，补正确 setup 后已通过。新增测试最初确实出现删除丢正文、错误 confirmed、复活旧笔记、并行回写丢标题和延迟 ACK 假冲突的失败。

## Phase 2：通知、界面与恢复

| 根因 | 改动与新链路 |
| --- | --- |
| Native 无 `sync.changed` → Pull 接线 | `mobileSyncRealtime.ts`/runtime：复用既有 realtime；通知/重连/前台 → 150ms 合并唤醒 → 同一个引擎 Pull；30s 前台补偿 |
| 原生 Apply 后列表/打开正文没有明确提交事件 | `mobileSyncEngine` 提交后事件 → `OfflineSyncRuntime` 的 Native 刷新分支与 `EditorPane` 既有版本/未保存内容保护；旧引擎回调被当前 runtime 身份挡住 |
| 创建与永久删除在同 Feed 页使 Snapshot 缺项 | Native/Desktop 均按身份折叠最终操作；不跳过真正缺失的 upsert，不推进失败游标 |
| Native 全局事务标记误伤独立 UI 查询 | `nativeDatabase.ts`：外层请求进入既有串行队列等待提交/回滚；事务回调仍只能用 tx；保留失效 tx、嵌套事务、关闭连接与加密 DDL 检查 |
| Workspace Snapshot 清理级联删待同步子项/冲突/附件 | Native/Desktop 排除 unresolved 冲突并保护剩余父子关系；Native 保留未上传本地附件，只有元数据确实移除才删除文件 |
| 冲突后继续编辑，keep-local/fork 使用过期快照 | Native 选择时在事务内读最新本地实体，随后生成远端基线的新修订；原冲突两方台账不删除 |

对应失败测试先失败再修复；多库套件增至 14 项。前端包括 Native UI 刷新、通知调度、冲突“查看”/知识树安全选择、目录密码保护与 401 endpoint 恢复。Node 24 的真实 SQLite 本地账号导入/同步开关组合 16/16，覆盖附件复制失败可重试与模式切换不丢队列。旧同步开关 fixture 缺少成功 ACK `version`，已按真实 API 契约修正；没有放宽生产校验。

没有引入第三套同步协议、schema 迁移或新增依赖。父实体因受保护子项被保留是保守的数据保护，之后仍需用户处理冲突。Native 外层数据库队列不能在其自身事务回调内被 await，须使用 tx；本次修改及迁移调用链遵守该约束。

## 未验收与下一步

- #829 基准已有“本地缺失 → 服务端授权 → 远端完整读取”fallback；本次没有新复现日志。该 fallback 仍不等于刚创建的服务端树笔记已经持久化到 Native，不能宣称离线完整解决。
- Android 原生闪退：已读取连接设备 PJZ110 crash buffer，没有获得本次 Sync V2 的明确崩溃堆栈；原生列表预览限长与 Kotlin Filesystem 修复在基准里。新增源码验证不能替代新包设备验收。
- 知识树 Native V2 实体未实现，登录态仍服务端树；附件 bytes、完整 EditorPane 与树创建仍需新包专项验收。父实体增量删除与所有受保护后代的组合须继续扩展故障覆盖，不能用本次 Workspace Snapshot 回归替代。
- Phase 3 的最终构建、设备实测与完成度矩阵见后续记录；Docker/NAS、iOS/HarmonyOS/macOS/Linux 安装包仍需独立平台证据。

## Phase 3：本轮回归与设备证据（整体生产验收未完成）

生产源码提交：Phase 0 `bd26fabe`；Phase 1 `421d37eb`；Phase 2 `4588de41`。均在 `codex/sync-v2-reliability`，目标 `release/v1.5.2`。Phase 3 单独提交验收工具和记录。保留 Draft PR，不合并、不发布。

| 检查 | 最终结果与边界 |
| --- | --- |
| backend 全部 `sync-v2-*.test.ts` + encrypted sync + backup integrity + existing-tree migration + native encrypted storage | **272/272**；Electron RunAsNode、隔离 SQLite，串行 test runner。新增多库测试 **14/14** |
| frontend 15 个目标文件 | **121/121**；Node 24 + Vitest；真实 SQLite migration/sync-switch 套件没有 skip；含音频 ACK 兼容 |
| consistency gate | **12 invariants / 59 references**；新增 Native 事务并发、删除折叠、Snapshot 保留均在门禁 |
| frontend `npm run build`、backend `npm run build` | 通过；已有大 chunk 警告仍在 |
| frontend `npm run lint:baseline` | **1447 historical errors / 0 new errors**；不声称全仓无 lint 历史错误 |
| Android `assembleDebug` | 通过；JDK 21、API 35 emulator，独立包名 `com.nowen.note.syncacceptance`；不覆盖正式包 |
| Android SQLite / 强杀 / 同步 | 真正 Native 插件；移除 adb reverse 验证服务器不可达 → MD/富文本创建立即读取 → `am force-stop` → 离线重开同 ID/正文/Outbox → 恢复网络自动上传/ACK；通过 |
| Android 通知/恢复 | HTTP 客户端 Push → 实际 WS → Native Pull；双向、主动断开通知后的 30s 补偿、重连；通过。测试期间该包 PID crash buffer 0 行 |
| Docker/NAS、其他系统安装包 | 本地 **未运行**；本机无 Docker CLI/runtime；远端生产 image/plugin smoke 见下段；没有 NAS/其他平台设备证据 |

PR #830 的 `6b4c5949` 远端 Data Consistency Contract CI（三个 job）、Android Local-first、Knowledge Tree、Data Protection CI 已通过；Docker Plugin Artifacts CI 已真正构建生产镜像并在镜像内执行 plugins smoke，通过，但不等于 NAS/完整同步镜像验收。Voice Memo 最初有 3 条失败：旧 fixture 成功 ACK 缺少 `version`、未模拟后续 Outbox baseVersion 更新，按真实协议补齐后本地 3/3。I18n Release CI 的 16 个 `encryptedConversion.*` 缺失键在原始 `d95d3787` 再跑也失败（23 pass / 1 fail），属于基准问题，未混入同步修复。后续提交的 CI 须以对应 SHA 查询，不能把旧 SHA 的通过状态套用到新提交。

Android 源码来自 `4588de41`，测试工具另在本阶段。隔离 APK SHA256：`4399aefd46c818de3eba68f8c19e7d2e77887de51a14cb572b1c79535b7f9622`。模拟器 `Pixel_8_API_35`，API 35，WebView 124.0.6367.219；只读启动现有 AVD，不改正式 App 数据。真实连接的 PJZ110 上安装未返回，本次没有真机验收通过证据。

最终机器记录：[Android report](test-results/sync-v2-android-2026-10-11.json)。各方向 30 次、同一 host 的 adb reverse 回环网络，计时包括轮询观察开销：

| 链路 | P50 | P95 | P99（30 样本取最大值） |
| --- | ---: | ---: | ---: |
| HTTP Push 发出 → Android Native Pull 提交后读到正文 | 337ms | 348ms | 768ms |
| Android edit 发出 → 服务端正文 + Native ACK 落盘 | 375ms | 394ms | 429ms |

这不是公网 P95/P99，也不是 PC GUI 或完整 EditorPane 的端到端指标；样本数不足以估计生产尾延迟。目标 P95≤3s/P99≤10s 仍须实际部署网络验收。WebSocket 只传唤醒通知，测量没有主动调用每次 sync 来替代自动链路。

失败记录：最初设备脚本通过 Chromium CDP 连接不兼容 WebView context 管理，改用 Playwright Android API；localStorage 测试 ID 标记强杀未及时落盘，改为 SQLite 测试元数据；真实 Native 并发查询错误已补失败测试并修复；超过 15 分钟的旧 fixture JWT 导致 ACK 等待失败，队列保留，修正测试工具每轮签发后通过。没有对生产 Token/ACK 校验放宽。日志保留在工作树忽略的 `sync-*.log`，只含临时测试数据；提交的 report 没有 Token、正文或密钥。

### 完成度矩阵（代码支持不等于平台验收）

| 能力/实体 | Desktop | Android Native | Web/移动浏览器 | 本轮证据/剩余工作 |
| --- | --- | --- | --- | --- |
| 正文、标题、格式、元数据；MD/富文本 | V2 + SQLite | V2 + SQLite | REST + cache/queue | 独立多库双向/三端；Native 设备两格式；完整 GUI 跨端未验收 |
| 本地保存 + Outbox 原子性 | 事务触发器 | 同事务读/写/Outbox | **统一原子 Local-first 未实现** | 失败入队回滚、并发保存；浏览器仍是部分离线链路 |
| mutationId 幂等 / ACK / 自身回声 | 实现 | 修复并回归 | 分入口实现 | 丢 ACK 重放、连续编辑、非法 ACK；另一设备收据未实现 |
| 自动实时 / 重连 / 前台补偿 | 既有 backend engine | 新接线，设备通过 | 既有 realtime/queue | Android 30s 漏通知补偿；系统强杀后后台实时不支持 |
| 离线重启恢复 | 磁盘 SQLite | 实际强杀通过 | 缓存/草稿，部分 | Native 新建/编辑持久化；PC 强杀与浏览器事务故障专项未运行 |
| 并发冲突、查看、选择、另存为 | 已有台账/UI | 最新编辑/版本基线修复 | 已有 draft/conflict | 双方保留/keep-local/fork；树结构选择现有测试通过；完整手机 UI 未验收 |
| 笔记本、文件夹、排序 | legacy V2 | legacy V2 | REST | 代码/协议回归；不是完整知识树离线能力 |
| 知识树节点、移动、结构冲突 | 协商的 V2 实体 | **Native V2 节点未实现**，登录态 server-first | REST | #829 已有授权 fallback；树创建后离线立即打开仍缺口 |
| 标签、收藏、关联 | V2 | V2 | REST/queue | 后端实体回归；Native 设备关联专项未运行 |
| 任务、状态、提醒 | legacy V2 | legacy V2 | REST | 代码/协议回归；Native 设备专项未运行 |
| 日记、思维导图 | legacy V2 | legacy V2 | REST | 同上；新模型/复合资源不冒充全覆盖 |
| 附件元数据 | V2 | V2 | REST/cache | 当前 metadata 与 bytes 分开；受保护元数据/本地文件清理测试通过 |
| 附件 bytes/hash/失败恢复 | 独立 transfer | 独立 transfer | offline attachment jobs | 路由/迁移已有回归；跨端新包 bytes 设备专项未运行，不宣称整篇附件完成 |
| 回收站、恢复、永久删除 | 已有 + 版本保护 | note fields/delete + 本地保护 | REST | 永久删除/旧更新不复活通过；回收站往返设备专项未运行 |
| Tombstone / Snapshot 历史清理 | reset/Snapshot | reset/Snapshot，保留冲突/子项 | 旧 snapshot/cache | 本次同页折叠与 pruning 回归；无基线旧 ID 的长期 tombstone 策略仍需评估 |
| 账号 / Profile / 服务器隔离 | Profile/scope | 旧会话取消/响应检查 | scoped cache | 延迟切账号负例；完整双服务器 GUI 切换未验收；不清未同步数据 |
| Workspace / ACL / 撤权 | scope/fingerprint | plan/freeze/guard | server ACL | 后端权限负例；设备完整撤权/密码目录验收仍需补齐 |
| V2 加密正文安全 | 密文验证/guard | guard + 密文同步 | 客户端加密 | encrypted sync/native storage 回归通过；加密+附件设备专项未运行 |
| iOS / HarmonyOS | — | iOS 部分共享；Harmony 缺 Native V2 bridge | — | **均未等价验收**；不能套用 Android 结论 |

后续阻断生产验收的工作：Web 统一 IndexedDB 事务/Local-first；Native 知识树离线创建及 #829 原路径；父实体增量删除与所有受保护后代组合；无基线旧 ID tombstone；完整移动 EditorPane/冲突/附件/权限设备场景；公网长时稳定性与真实 P99；Docker/NAS/macOS/Linux/iOS/HarmonyOS 验收。不能将本轮修复或 CI 当作这些项已经完成。

### 重跑隔离 Android 验收

入口只由 `vite.android-sync.config.ts` 打进测试包，正常 `npm run build` 不包含测试 HTML/工具接口。后端 helper 只监听 127.0.0.1，不部署到生产。

1. 根目录：配置临时 `SYNC_ACCEPTANCE_DIRECTORY`，用项目 Electron RunAsNode + tsx 启动 `backend/tests/sync-v2-android-server.ts`；端口 47831。不要使用生产 DB。
2. frontend：`npx vite build --config vite.android-sync.config.ts`；Node≥22 运行 Capacitor `sync android`；JDK21 执行 `gradlew -I <absolute scripts/android-sync-acceptance.init.gradle> :app:assembleDebug`。
3. 只向隔离设备安装 APK，`adb -s <serial> reverse tcp:47831 tcp:47831`，启动 `com.nowen.note.syncacceptance/com.nowen.note.MainActivity`。
4. 根目录：`node scripts/android-sync-acceptance.mjs <serial>`。只操作这个测试包；关闭其网络转发来模拟离线，恢复后测量。report 写到 `docs/test-results/`。结束后关闭 helper、移除转发并关闭测试模拟器。
