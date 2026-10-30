# Native personal tree creation / Native 个人知识树创建

2026-10-11，基准 `856d42bf`，分支 `codex/native-knowledge-tree-offline`，目标 `release/v1.5.2`。本轮是同步可靠性第二批，所有测试内容均为临时模拟数据。

后续第三批已接入个人树结构接收；本文件保留第二批当时的边界，最新能力与验收见 [Native tree Pull validation](sync-v2-native-tree-pull-validation.md)。

## 问题、决策与执行链路

Issue #829 的 Native 调用链存在可验证缺口：登录态知识树 `POST /knowledge-tree/nodes` 成功后，编辑器改从 Native Repository 读取。原 fallback 只返回远端正文，随后保存仍可能走远端，离线重开未具备持久化正文。手机浏览器也在 Issue 的报告范围内，但本轮不宣称其 IndexedDB/REST 路径已修复。

最小方案复用既有 `notebook`/`note` Sync V2 与 `note:<id>` 树投影，不增加协议、依赖或 schema。完整 `knowledge_tree_node` 结构版本、移动、跨文档父子关系及共享 ACL 仍未进入 Native V2。

| 入口 | 修改前 | 修改后 |
| --- | --- | --- |
| 个人根级 MD/富文本创建 | 远端树创建 → 等待 Native Pull；断网失败 | 客户端 UUID → 同事务创建隐藏根容器、正文、创建来源和 Outbox → 立即读取 → 既有 Push/Pull/ACK |
| 个人普通文件夹内 MD/富文本创建 | 始终调用远端树 API | 校验缓存的真实父链、无密码、canCreate 与本机拥有的父文件夹 → 本地事务；缓存缺失、受保护/共享/跨文档目录继续服务端检查 |
| 本机尚无的已授权个人正文 | 远端授权/读取 → 返回临时正文 | 远端授权/读取 → Native 父容器和正文事务落盘，不插入创建 Outbox → 重新校验目录密码/会话 → 本地保存进入既有版本队列 |
| 在线树尚无本机新文档 | 服务端列表无法显示它 | 只补本机创建事务记录的个人文档；真实服务端节点出现后接管结构与权限，不投影其他远端缓存 |

本机创建来源放在已有 `native_runtime_meta`，不把一次发送当作数据来源改变。服务端确认后若在线授权树省略该文档，不允许用来源记录重新构造无保护节点。树列表只跨 Native bridge 返回元数据，不桥接正文或大预览。隐藏根容器复用 `__nowen_root_documents__:personal:<userId>`，不会显示成普通文件夹。

## 已执行回归

- 后端全部 `sync-v2-*.test.ts`、加密同步及 Native 加密存储：**267/267**，独立临时数据库、串行执行；多库套件 **17/17**。新增根级两格式创建/关闭重开/第二设备收敛/服务器树 ID、创建失败整体回滚、授权落盘/保留新编辑/删除不复活/他人身份拒绝。
- 契约映射的前端 17 文件：**141/141**。另 4 文件的真实 SQLite 账号迁移、Guest Runtime、知识树 Bridge、根文档策略：**27/27**，合计 21 个不同文件 **168/168**，无 skip。
- 前端正常 `npm run build`、TypeScript：通过；历史大 chunk 警告保留。lint 基线 **1447 historical / 0 new errors**。
- `node scripts/data-consistency-contract.mjs --verify`：**12 invariants / 66 references / 7 backend files / 17 frontend files**。

Windows 后端依赖是 Electron ABI，使用 `ELECTRON_RUN_AS_NODE=1` 的项目 Electron + tsx + `setup-db-isolation.ts`。初始 HTTP 用例在网络沙箱内失败，隔离回环测试经授权运行后通过；不是源码失败。Windows 契约 `--frontend` 入口存在既有 `spawnSync npx.cmd EINVAL`，已直接用 Node 24 执行其完整映射文件，未修改无关启动脚本。Vitest 的沙箱 realpath 限制同样通过批准的测试执行解决。

## Android 新包证据

生产源码提交 `f6915749`。只读启动 `Pixel_8_API_35`，`emulator-5580`，API 35 / WebView 124.0.6367.219；独立包名 `com.nowen.note.syncacceptance`，JDK 21 的 `assembleDebug` 通过。APK SHA256 `0953a8e9eb2c3c40da3a4b5b2f26454f15162ed89c507340b40707e1dc6cbf72`。

这次测试页安装真实 `installMobileLocalFirstBridge`，通过 `knowledgeTreeApi.create` 创建两个根文档，通过 `api.getNote/updateNote` 读取和编辑。移除 adb reverse 确认 HTTP 服务器不可达 → 创建 MD/富文本并立即打开 → `am force-stop` → 离线重开同 ID、正文及待同步收据 → 恢复网络自动上传并记录 ACK：**通过**。实际 WS/Pull、双向更新、30 秒漏通知补偿、重连：**通过**。测试模拟器 native crash buffer 为 0 行；不等于已复现/修复原先报告的任意原生闪退。

各方向 30 次，计时包括 API 目录授权和轮询观察开销：

| 回环链路 | P50 | P95 | P99（30 样本取最大值） |
| --- | ---: | ---: | ---: |
| HTTP Push → Native Pull 后通过笔记 API 读到正文 | 291ms | 304ms | 371ms |
| Native API 编辑 → 服务端正文及本机 ACK 落盘 | 447ms | 484ms | 529ms |

机器记录：[本轮 Android report](test-results/sync-v2-native-tree-2026-10-11.json)。没有完整 EditorPane GUI、密码/共享/跨文档树结构、附件 bytes、生产 JWT 全套中间件或公网网络验收；仍不是手机浏览器证据。连接的 PJZ110 未参与本轮安装与测试。

失败及保留日志：第一次恢复网络时 helper 的树入口少了正式 `index.ts` 使用的尾斜杠挂载，404；修正后第二次因测试页自动恢复旧令牌、driver 又写入新令牌，触发正确的 `AUTH_SESSION_CHANGED` 保护。去掉测试页自动会话恢复，由 driver 每次明确初始化后通过。原测试库、正文及队列保留，无清库、无放松生产会话或 ACK 检查。忽略的 `sync-tree-device-failed404.log`、`sync-tree-device-failed-session.log` 保留失败记录。测试后已关闭 helper/只读模拟器并恢复生成的 Gradle 文件。

重跑命令与上一轮一致：Vite `--config vite.android-sync.config.ts` → Capacitor sync → `gradlew -I <scripts/android-sync-acceptance.init.gradle> :app:assembleDebug` → 隔离设备安装 → `node scripts/android-sync-acceptance.mjs emulator-5580`。正常前端构建不包含测试入口；helper 只监听 127.0.0.1。

## 数据安全与兼容性

- 业务、创建来源、Outbox 同事务成功才返回；任一插入失败全部回滚。既有保存检查保持开启。
- 已存在的本地正文优先，不覆盖本地后续编辑；存在本机删除/冲突/待处理意图时不从远端重新创建。只持久化当前账号拥有的个人正文；共享与工作区沿用原授权远端读取。
- 目录密码不降级为无保护投影；完整真实父链缺失/循环/权限不足拒绝本地创建，保护目录继续服务端检查。落盘后再次检查密码与会话，旧账号回包不能返回新会话。
- 读取落盘不产生第二个 creation mutation，不修改同步 Cursor，不伪造 mutation ACK 或其他设备收据。标签与附件仍由既有 Pull/transfer 获取，不宣称仅正文落盘代表完整附件同步。
- 无迁移、无清库、无删除真实数据、无 main 修改、无强推或发布。原有 `backend/package-lock.json` 修改不纳入本轮提交。

## 完成度与下一步

| 能力 | 本轮范围 | 剩余限制 |
| --- | --- | --- |
| Native 个人根级 Markdown/富文本离线创建 | 已实现、独立 SQLite 与 Android 新包 API Bridge 验收通过 | 完整 EditorPane 视觉/编辑生命周期单独验收 |
| Native 普通个人文件夹内离线创建 | 已实现、Bridge 回归通过 | 父文件夹须已同步，真实服务端树/密码元数据已缓存 |
| #829 个人已授权正文持久化 | 已实现、回归通过 | 手机浏览器、共享/工作区正文与完整结构同步未完成；不关闭 Issue |
| Native 文件夹创建、任意节点移动/排序/删除冲突 | 既有远端路径 | 完整 Native `knowledge_tree_node` 能力继续下一批 |
| 密码目录、共享 ACL、附件 bytes | 保持原有检查 | 完整新包场景尚需专项验收 |
| Web、iOS、HarmonyOS、Docker/NAS、公网延迟 | 本轮无新增验收 | 沿用上一轮未完成清单，不能套用 Native/回环结论 |

English: Personal native Markdown/rich-text root and ordinary-folder creation now commits content, provenance and the existing Sync V2 Outbox atomically. A live-authorized personal body missing locally is hydrated without a duplicate creation, with local edits/deletes and session/password guards preserved. This is a bounded legacy-entity bridge, not complete native tree-structure synchronization or mobile-browser acceptance.

Android API 35 emulator acceptance now exercises the actual personal knowledge-tree create and note API bridges, including unreachable-network creation, force-stop/reopen and automatic ACK recovery. Thirty loopback samples per direction measured P50/P95/P99 291/304/371ms for remote Push to native API read, and 447/484/529ms for native API editing to server content plus persisted ACK. Full editor GUI, protected/shared tree operations, attachment bytes and WAN acceptance remain pending.
