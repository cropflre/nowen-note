# 功能与风险追踪

本轮为失败复核，以下是已核查的模块入口与证据映射，不是从 README 推导的全功能覆盖证明。固定 Git 树有 82 个 `backend/src/routes/` 代码文件、342 个后端测试文件和 657 个前端测试文件；代码文件数量不等于 82 个独立功能。完整库存路径在 `source-inventory.json`。

状态“具备代码”只表示当前路由/组件存在，不表示所有支持平台已经验收。iOS/HarmonyOS、PostgreSQL 不套用 Web/Android/SQLite 的测试结论。

| 编号/域 | 入口与源码 | 后端或数据路径 | 风险 | 本轮证据 / 缺口 |
| --- | --- | --- | --- | --- |
| F-AUTH 登录/账号 | LoginPage.tsx、AccountLoginHistory.tsx、NavRail.tsx | auth.ts、users/user_sessions | 高 | 实际 HTTP/JWT；地址恢复 BUG-07；账号 UI 全链缺失 |
| F-CONN 连接设置 | ServerConnectionSettings、serverEndpointState/serverUrl | health、CORS/proxy aliases | 中 | 合并 i18n 与相关 DOM；WAN/IPv6/设备切网未测 |
| F-TREE 知识树 | Sidebar、knowledgeTree/native tree modules | knowledge-tree.ts、knowledge_tree_nodes/ACL | 高 | 删除 projection 清理；真实离线结构/共享/密码矩阵缺失 |
| F-NOTE 笔记 CRUD | EditorPane、api.impl、SDK/MCP | notes.ts、noteTrashAdapter、note_versions | 最高 | BUG-02/03 实验及真实授权 API；复杂正文 UI未重跑 |
| F-TRASH 回收站 | DataManager / RestoreCenter、trash API | trash.ts/trashService | 最高 | 10 现有用例、软删/恢复对照；页面端到端缺失 |
| F-MD Markdown | MarkdownEditorImpl.tsx | notes/附件/搜索派生 | 高 | 标签键盘 DOM/源码契约诊断；编辑保存/互转完整闭环缺失 |
| F-RICH 富文本 | TiptapEditor.tsx / Runtime、EditorTagInput | Yjs、notes、block writer | 高 | 焦点保持对照；复杂文档互转、撤销/重开未重跑 |
| F-ATTACH 附件/媒体 | Attachment render hooks、AndroidShareImportCenter | attachments.ts、media variant、storage adapter | 高 | 媒体 8/8、删除附件 7/7；Native 权限 Mock 缺项，正式包/真机字节未测 |
| F-SYNC 同步/收据 | mobileSyncEngine、nativeLocalRepository、SyncStatusBadge | sync-v2、outbox capture/delete triggers | 最高 | active profile 删除墓碑、旧模拟器明确边界；最终真机多端/ACK/冲突缺失 |
| F-ENCRYPT 加密 | lib/encryptedNotes、Encrypted* 组件 | encrypted guards/migrations/conversion | 最高 | crypto 文件三轮 11/11、fixture 旧库升级；历史原失败名不明，设备不扩展支持宣称 |
| F-EXPORT 导出/导入 | Export flows、DataTransferCenter | export.ts、markdownExportJobs/reliableExportJobs | 高 | actual ZIP 下载实检、8 现有用例；UI下载与再导入缺失 |
| F-BACKUP 备份/恢复 | BackupCenter、RestoreCenter、WebDAV bridge | backups、backup-webdav、restore wrappers | 最高 | fixture 全备份双版本恢复；大型/NAS/WebDAV/正式升级未测 |
| F-PLUGIN 插件 | Studio UI / 插件平台 | plugin-studio.ts、projectPaths/projectService、runner children | 最高 | traversal/symlink/junction/hardlink/ZIP/check-open；Linux/威胁模型/正式包缺口 |
| F-AI AI/RAG | AIWritingAssistant、AI chat | ai routes、outbound proxy | 高 | 旧布局转述非当前浏览器证据；真实流式/替换/键盘未测 |
| F-AUTO 自动化/任务 | AutomationCenter、任务组件 | automation runtime/eventPublisher/workflowRunner、tasks | 高 | 新 HEAD automation 4/4；完整任务/日历/时区/原生通知本轮未测 |
| F-SEARCH 搜索/标签 | Sidebar/tagSearch、search inputs | search.ts、tags.ts | 中 | 旧过滤转述；真实输入→打开命中→返回上下文本轮未测 |
| F-PLATFORM 安装/部署 | Electron/Capacitor、builder configs | bundle external packages、Docker | 最高 | Windows ABI、backend build + real HTTP；正式安装包/设备/Docker均缺 |

需求→源码→用例→结果的具体追踪见 `test-cases.md` 与 `frontend-failure-review.md`，可执行原始证据见 manifest。尚未纳入本轮的日记、思维导图、表格、分享、评论、Webhook、开放 Token 等代码库存仍属于完整回归范围，不能因为本轮聚焦失败项就声明它们已通过。
