# Native 个人文件夹写入与结构冲突恢复

后续个人文件夹离线创建已接入；当前状态与新增证据见[创建验收](sync-v2-native-folder-create-validation.md)。下文保留本批移动/冲突的验收范围。

2026-10-11，`codex/native-knowledge-tree-offline`，继续 Draft PR [#831](https://github.com/cropflre/nowen-note/pull/831)，目标 `release/v1.5.2`。本批基准 `24594972`；[上一批接收验收](sync-v2-native-tree-pull-validation.md)、[English](sync-v2-native-tree-writes-validation.en.md)。

## 已实现的闭环

已完成完整订阅的 Native 客户端，可以在个人空间移动普通文件夹、批量移动和排序，目标可以是根、普通文件夹或文档。整个本地批次的结构、兼容 notebook.parentId/sortOrder 与 Outbox 在同一事务中落库，任一入队或图校验失败均回滚；提交后才唤醒同步。已有服务端权限快照必须证明完整父链归属个人 owner 且无文件夹密码。结构表自身没有 ACL/密码，不作为授权证明；不足时走既有在线路径。存储提交失败直接报错，不重复发起另一个在线写入。

schema 7 在一个迁移事务内无损重建 Outbox/Conflict CHECK，保留 mutationId、版本、完整 payload、重试和已解决历史；失败保留旧表及版本。结构 Push 沿用服务端 baseParentId/baseSortOrder/baseIsDeleted，等待完整 Snapshot ACK 绑定后才发送。顺序移动不合并或改写已发送身份，丢失 ACK 重试仍使用原 mutationId。服务端文件夹结构 Apply 复用现有移动服务，同步物理容器与排序，避免下一次重命名把文档父节点或排序覆盖回旧值。

增量及全量重建保留未发送的本机位置；全量远端图先校验，再在同一事务内恢复并协调本机意图。中间已应用但 ACK 丢失的位置可识别为相同队列意图。并发移动进入已有冲突中心接口，保留双方结构；保留本机采用最新落库位置并基于最新远端 tuple 重新入队，保留服务器不再次上传。权限不足、缺失父节点或成环的选择保持失败和原记录。

若远端永久删除了仍有本机结构意图的目录，先持久化结构冲突，整页业务 Apply 和 ACK 暂停，避免 notebook DELETE 级联清掉子正文。不能以保留本机复活已不存在的资源；明确选择服务器可移除本地子树投影，随后重放原 Feed 的业务删除。子节点仍有待发送数据或未处理冲突时拒绝该选择，要求先保留并处理内容。全量个人 Snapshot 沿用既有业务资源保留策略，不把快照缺席直接作为物理删除。

## 当前验证

- 最终相关后端回归 316 项、前端去重回归 254 项（39 文件）通过，均无跳过。包括两库并发移动两种选择、冲突期间继续移动、丢失 ACK/中间回显、Snapshot 重建、循环/密码/未订阅拒绝、Outbox 插入失败、实际 SQLite schema 6→7 迁移及第二表失败回滚、远端目录删除保留子正文。
- 契约矩阵全部 8 个后端映射文件另跑 118 项通过、无跳过，含备份完整性/恢复回滚和工作区删除保护；与上项有重叠，不相加作为总数。
- 后端生产 build/build:tsc、前端 TypeScript/正常生产 build 通过；lint 1447 历史错误、0 新错误。正常 dist 不含 Android 同步验收入口。契约门禁 12 不变量、87 引用、8 后端文件、19 前端文件。
- 本机测试采用 Node 24；better-sqlite3 使用项目 Electron RunAsNode。Android Local-first CI 改为 Node 24 实际执行迁移用例；CI 状态须看最终 SHA，不把本地通过当作远端通过。

## Android 实测边界

隔离的只读 Pixel_8_API_35 模拟器、`com.nowen.note.syncacceptance` 独立包，API 35 / WebView 124.0.6367.219，崩溃缓冲 0 行。连接的 PJZ110 未安装或测试。前端及服务端验收源 `053b2ae1`，APK SHA256 `945c13887763dea695733833e706b0cc2f5dc4f52aadfdb98cc878c23645bc4a`；之后的永久删除竞争保护由真实多客户端 SQLite 回归覆盖，本 APK 不作为该新增保护的设备证明。

实际执行生产 knowledgeTreeApi Bridge：切断 adb reverse 后移动/排序文件夹，离线列表显示待发送位置，force-stop/reopen 后结构和队列保留，恢复网络自动上传；再制造与服务端并发移动并通过同一 Native 冲突服务保留本机，最终服务端和本机收敛。另复测根级 MD/富文本创建、正文双向更新/收据、通知丢失周期补偿与重连。没有清库或更换客户端 Outbox。

| 回环 30 次样本 | P50 / P95 / P99 |
| --- | --- |
| HTTP Push → Native API 读取 | 306 / 327 / 330 ms |
| Native 提交 → 服务端正文 + Native ACK | 493 / 510 / 544 ms |

远端文件夹创建/移动单次 301/267 ms。这些正文分位数和单次结构样本包含轮询/API 开销，不能代表公网、完整编辑器或文件夹写入的延迟分位数。[机器记录](test-results/sync-v2-native-tree-writes-2026-10-11.json)。

## 仍需后续阶段

本批只启用普通个人文件夹移动/排序。Native 主动文件夹创建、删除/恢复，文档/脑图/文件移动与正文/附件队列联动仍走既有在线路径；共享、密码目录与权限变更仍需专项验收。完整手机 ConflictCenter/EditorPane GUI、真实旧用户库升级、手机浏览器、附件 bytes、WAN、iOS/HarmonyOS、NAS/正式包均未由本轮证明。保留 Draft，不关闭 #829，不合并或发布。
