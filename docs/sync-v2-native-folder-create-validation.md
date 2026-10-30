# Native 个人文件夹离线创建验收

2026-10-11，`codex/native-knowledge-tree-offline`，继续 Draft PR [#831](https://github.com/cropflre/nowen-note/pull/831)，目标 `release/v1.5.2`。创建代码 `61ca1f03`，Snapshot 竞态修复 `c3d9b9ff`，基准 `8119a34c`；[上一批移动/冲突验收](sync-v2-native-tree-writes-validation.md)、[English](sync-v2-native-folder-create-validation.en.md)。

## 本批闭环

已完成个人完整树订阅并保存权限快照的 Native 客户端，可以在根级、普通文件夹或已有文档下离线创建普通文件夹，继续创建嵌套文件夹，以及在新文件夹内创建 Markdown/富文本。稳定资源 ID、业务资源、结构投影、创建来源和两个 Outbox 意图在同一个 SQLite 事务中保存；结构入队失败全部回滚。沿用现有 Sync V2 和 schema 7，不增加平行同步协议或清空旧数据。

业务 notebook 意图先于知识树意图入队，结构 tuple 的基准对应服务端业务创建生成的投影。根文档的隐藏兼容容器已软删除，不能作为旧版业务创建的父节点；先创建根级业务资源，再用服务端已有容器感知的移动服务挂到文档下。后续业务重命名保留既有隐藏容器父节点，避免 UPSERT 重跑新建守卫。普通新资源的父节点/空间守卫仍执行。

创建来源只记录本机新建的个人普通文件夹，不能从整个 Native 结构表推断 ACL。继续写入要求原始权限快照和本机意图覆盖后的完整父链均为 owner、可见、无文件夹密码，且后一条链与 Native 图一致；尚未上传完的新文件夹可以作为嵌套父节点。在线树接管真实 ACL/密码元数据，已 ACK 但被在线树省略的资源不会通过创建来源重新投影。离线列表和重启恢复保留尚未完成在线交接的创建来源。缺少订阅/证明、共享或密码路径走原在线入口；存储失败直接报错，不重发另一个在线创建。

## 本地验证

全量 Snapshot 的最后一页返回期间新建文件夹/嵌套目录及正文，原快照不会包含它们。创建来源保存原始业务 mutationId；只有该原始创建意图仍在队列时，快照缺席才保留为未上传创建，不合成为远端墓碑。后续业务更新不能借旧来源掩盖远端删除。该竞态先复现结构冲突，再通过真实多库回归验证修复。

- 最终相关后端回归 323 项、前端去重回归 257 项（39 文件）通过，均无跳过。新增覆盖嵌套资源和第二个独立 SQLite 客户端、文档父节点、重启和 mutationId、全量重建期间创建、完整/仅结构 ACK 丢失、Push 中继续创建与移动、100 条分页依赖、整事务回滚、未订阅/缺父/异用户/密码父链拒绝、在线证明接管和工作区回退。
- 契约矩阵全部 8 个后端映射文件另跑 125 项通过，无跳过，与上一项重叠；门禁 12 不变量、97 引用、8 后端文件、20 前端文件。
- 后端生产 build/build:tsc、前端 TypeScript/正常生产 build 通过；lint 基线 1447 历史错误、0 新错误。Node 24 执行前端 SQLite 用例；better-sqlite3 使用项目 Electron RunAsNode。
- 另核查 [I18n CI](https://github.com/cropflre/nowen-note/actions/runs/38139639518)：覆盖套件 39 项中 1 项失败，与[改动前的 8119a34c](https://github.com/cropflre/nowen-note/actions/runs/38137818852)同样缺少 16 个 encryptedConversion 键。生产 index 已合并该翻译模块，既有测试装配漏合并；相关组件与 i18n 目录相对 release 基准均未改动。本地复现同一失败，该套件不计入上面的 257 项；保留 Draft，不宣称全部 CI 通过。

## Android 验收

使用只读 Pixel_8_API_35 模拟器、API 35 / WebView 124.0.6367.219，独立包 `com.nowen.note.syncacceptance`。最终 APK 与后端均为 `c3d9b9ff`，APK SHA256 `80897d65fd8007a92fda9b7bcc7ff3cb9a9b146aa414600c3c11c502581e6713`。移除 adb reverse 确认 Android 无法访问隔离服务，然后通过生产 API Bridge 创建根文件夹、嵌套文件夹、已有文档下文件夹和新目录内 Markdown，立即读取列表与正文。强制停止重开后层级、正文与全部 mutationId 保留；恢复网络自动上传，服务端层级/正文与 Native ACK 一致，Outbox 清空、无结构冲突。创建批次从恢复同步到确认完成单次 2002 ms。该值不是文件夹写入延迟分位数。

同一 APK 重跑个人文件夹移动/排序、丢通知轮询、重连和 Native 冲突保留本机，以及根级 Markdown/富文本双向正文/回执。30 个 loopback 正文样本：HTTP Push→Native API 读取 P50/P95/P99 为 350/378/1161 ms；Native 提交→服务端正文+Native ACK 为 339/362/369 ms。远端目录创建/移动单次为 66/217 ms。这些结果包含 API/轮询开销，不代表 WAN 或完整编辑器。最终同步 lastError=null，Android crash buffer 0 行。[机器记录](test-results/sync-v2-native-folder-create-2026-10-11.json)。

连接的 PJZ110 真实手机未安装或验收。隔离后端和只读模拟器均已停止，正常前端 dist 与 Android 打包 assets 已恢复且不含验收入口。第二设备接收由上述独立 SQLite 客户端证明；这里未测试第二台实体 Android 设备。Snapshot 最后一页并发创建的特定竞态由多库测试证明，Android 驱动未注入该页内竞态。

## 当前边界与下一阶段

继续保留 Draft。普通个人文件夹创建和移动/排序已启用；文件夹删除/恢复，以及文档/脑图/文件移动与正文、附件队列的联动仍走既有在线路径。没有证明共享/密码目录、完整手机编辑器和冲突中心 GUI、真实旧用户库、WAN、附件 bytes、iOS/HarmonyOS、NAS 或正式发布。建议下一阶段接入个人文件夹回收站/恢复，重点保护子节点正文和待发送队列；不关闭 #829、不合并或发布。
