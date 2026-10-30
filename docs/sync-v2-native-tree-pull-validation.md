# Native 个人知识树结构接收与恢复

本页保留第三批接收验收；后续文件夹主动写入和结构冲突证据见[下一批记录](sync-v2-native-tree-writes-validation.md)。

2026-10-11，同步可靠性第三批，基准 `1b5b0c79`；分支 `codex/native-knowledge-tree-offline`，继续 PR #831，目标 `release/v1.5.2`。[English](sync-v2-native-tree-pull-validation.en.md)。

## 问题与实际调用链

Native 原先只支持旧协议 10 类实体，收到 `knowledge_tree_node` 会拒绝；业务 `notebooks.parentId` 无法表达文件夹挂在文档下。只开启协议枚举会继承旧游标并漏掉历史结构。本批先接入个人空间接收基线，为后续本地结构写入提供可靠依据。

`MobileSyncEngine → /plan 协商完整既有实体集与 deviceId → 分页 /snapshot（业务资源先行）→ 整份结构事务校验/保存 → ACK → 本地订阅标记和游标 → /changes + /snapshot → 同批业务/结构 Apply → ACK`。工作区保留旧协议；新 Profile 遇到旧服务端可继续旧协议，已接收树的 Profile 不静默降级。

Native schema 6 新增 `native_knowledge_tree_nodes`，保存完整 parentId、顺序、回收状态与稳定资源身份；不改 Outbox/Conflict 的旧实体约束，不清除业务数据。完整树替换及 `pending:` 订阅意图同事务提交；首次 ACK 丢失时重启重新 Snapshot，避免继承旧协议高水位。DDL 失败回滚且不推进 user_version。

结构 Apply 校验账号、空间、资源身份、业务依赖、节点类型、整数顺序、完整最终父链和循环。同批非法结构回滚正文与结构，客户端/服务端游标不提前推进；先校验最终图允许合法的祖先反转。Snapshot 替换只清理远端结构元数据，不删除本地正文、附件或 Outbox。首次 Bootstrap 的业务分页仍分别提交，整份树在最后一次事务提交；不宣称整份业务 Snapshot 为单事务。

Android 首次验收发现 REST 树移动已提交但没有 `sync.changed`，客户端只等前台 30 秒补偿。`knowledge-tree` 路由现在在成功请求提交后，按新结构 Feed 所属空间复用既有通知器；通知只含 type/scope/fingerprint/sequence，失败和权限拒绝不发送。后续验收又复现 `NOTEBOOK_PARENT_NOT_FOUND`：移入根文档时隐藏笔记本未激活。移动入口现在复用创建入口的激活/隐藏事务，保留原 ACL、空间和循环校验，个人/工作区均有回归。

## 验证证据

| 验证 | 最终结果 |
| --- | --- |
| 后端全部 Sync V2、知识树、加密 Sync/Native 存储 | 308/308，0 skip；从 backend 目录执行 |
| 前端契约映射、完整 Voice CI 套件、Native SQLite 开关/迁移等 32 文件 | 243/243，0 skip；Node 24.19.0 |
| 结构专项 | 多设备、重开、旧游标升级、ACK 丢失、错误回滚、非法 scope/identity、父链反转、文件 metadata、230 文件夹分页及增量删除 |
| 构建 | 正常前端/后端、双方 TypeScript、Capacitor 测试包 Gradle 均通过 |
| lint / 契约 | 1447 历史问题，0 新增；12 invariants / 82 references / 8 backend files / 18 frontend files |
| Android | API 35，WebView 124.0.6367.219，独立包 com.nowen.note.syncacceptance；崩溃缓冲 0 行 |

Windows 后端采用项目 Electron RunAsNode，以匹配 better-sqlite3 ABI；不重装共享依赖。前端调用 Node 24 的 Vitest 实际运行 SQLite 用例，不以旧 Node 跳过代替通过。扩大后端回归首次从仓库根目录运行，两个启动用例因 cwd/tsx 解析失败；改用 backend 目录后完整通过。PR #831 旧 `1b5b0c79` 的 Voice CI mock 缺少 getBaseUrl，已复现并补齐，完整语音套件包含在最终前端回归中。旧 i18n 基准缺键见上一批记录；新 SHA 的 CI 以 GitHub 实际结果为准。

设备验收使用原临时服务数据库和原测试账号 Outbox 连续重试，保留两次失败日志，没有清库。最终包前端源 `0e5b2e71`、服务端源 `5428b6d7`；APK SHA256 `e63ff8d48d10e1489257fea167ef132620f441ec6b420103a5ccae82612fe0e3`。测试专用入口不进入正常 Vite 构建；连接的 PJZ110 没有安装或测试。

实际验证：离线根级 Markdown/富文本立即读取、强制关闭恢复、双向正文与收据、通知丢失补偿、重连；通过生产 REST 创建文件夹于根文档下，接收移动到根及再次移回文档，切断通知后等待同一引擎周期 Pull，断网强制关闭后读取已持久化结构。schema 5→6 迁移由单测校验；本轮不宣称真实旧用户库的设备升级验收。

| 回环样本 | P50 / P95 / P99 |
| --- | --- |
| HTTP Push → Native API 读取，30 次 | 303 / 394 / 406 ms |
| Native 编辑 → 服务端正文 + Native ACK，30 次 | 449 / 509 / 540 ms |

远端文件夹创建和移动各测一次，为 284 ms、262 ms；不将两个样本描述为结构延迟分位数。30 次的小样本 P99 为最大值，包含 API 权限查询和轮询开销，不代表公网或完整编辑器延迟。[机器记录](test-results/sync-v2-native-tree-pull-2026-10-11.json)。

## 提交与下一步

- `a732b22e`：个人结构订阅、schema 6、事务 Apply 与对应回归/CI。
- `0e5b2e71`：REST 提交通知、首次树 ACK 持久化保护及补偿验收。
- `5428b6d7`：根文档下移动时隐藏容器校验修复。

本轮完成接收基础。该结构表不含 ACL/密码证明，不用于授权、更新离线权限快照或显示云端写入收据；知识树列表仍使用既有服务端/权限缓存 Bridge。Native 主动文件夹创建、移动/排序/删除/恢复及结构冲突 UI 尚未接入；下一批应复用现有服务端 baseParentId/baseSortOrder/baseIsDeleted 冲突契约，补原子 Outbox 与本地/远端选择，再做手机编辑器验收。共享/密码、新旧权限变化、手机浏览器、附件 bytes、WAN、iOS/HarmonyOS、NAS 与正式包仍需专项覆盖；不关闭 #829，不合并或发布。
