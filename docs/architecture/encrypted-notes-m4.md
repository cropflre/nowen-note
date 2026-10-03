# M4：既有明文笔记转换

当前实现了只读转换前检查及内部 SQLite 原子转换/逻辑清理事务。**未开放既有笔记或明文选区的产品转换入口，M4 未完成。** 原有 notes API 与 Sync 继续禁止直接转换；数据库仅对内部事务中的精确许可开放普通到密文的转换。

## 已实现的检查

普通笔记的桌面/移动端“更多 → 加密转换前检查”调用 `GET /api/notes/:id/encryption-preflight`。接口验证所有者及 manage 权限，返回 `Cache-Control: no-store`；在 SQLite 读取事务中统计关联记录，不生成口令、密钥、envelope 或转换授权，不执行更新、删除、Yjs flush、索引重建或数据库维护。前端直接请求检查接口，不使用普通笔记正文的离线回退与缓存写入路径。

| 类别 | 当前覆盖的来源 |
| --- | --- |
| 正文预览 | notes.contentText 是否存在，正文不会返回 |
| 历史 | note_versions |
| 块数据 | note_blocks_index、note_block_documents、note_block_records、note_block_operations、block_operations、note_block_attachment_refs |
| 协作 | note_yupdates、note_ysnapshots、note_y_subdocuments、note_y_subdocument_updates、note_y_subdocument_manifests、yjs_operation_receipts；内存房间连接数 |
| 搜索 | 两套 FTS 的 docsize 行，不以 external-content 虚表行数代替索引存在性 |
| 向量 | note_embeddings、embedding_queue，以及存在时的 vec_note_chunks 关联 rowid |
| 同步 | sync_outbox、sync_outbox_legacy_unbound、sync_conflicts 中 note 实体 |
| 外部关联 | attachments、attachment_references、attachment_embedding_queue、shares、share_comments、note_acl、note_templates、note_links、note_import_origins、folder_sync_files、sheets |
| AI 引用 | ai_chat_messages.referencesJson 中引用该笔记的记录；损坏 JSON 包含笔记 ID 时也按可能引用计数 |

数量是相关记录数，包含元数据、任务和引用，**不等于明文副本数**。固定来源表不存在时对应类别标记检查不完整；额外含 noteId/note_id/sourceNoteId/targetNoteId/entityId 的表有该笔记记录时列为待审计来源。缺列或查询失败直接失败，不返回“完整且为零”的成功结果。无结构化引用的 AI 摘录、已解除关联的模板/文件等无法可靠归属，不能用零计数证明不存在。

元数据表 notes、note_tags、favorites、workspace_journals、offline_sync_changes、sync_changes_v2、sync_v2_applied_mutations 和事务许可表 encrypted_block_write_permits、encrypted_note_conversion_permits 已在当前 schema 下排除额外内容审计。转换许可只保存目标密文与原版本/格式，不保存旧正文、口令、密钥或 sourceDigest；内部转换另行拒绝已存在的许可。后续迁移若向这些表加入正文载荷，应同步更新检查器及回归。

当前浏览器仅读取：全局笔记草稿是否存在、当前服务器/账号队列中该笔记的记录数、已初始化且账号匹配的离线 notes store 中该笔记是否存在，以及对应 Yjs IndexedDB 数据库名是否存在。不会打开/新建数据库、加载正文、清理过期草稿或队列。IndexedDB 枚举不受支持、缓存未初始化、队列损坏或读取失败时显示“未能确认”；全局旧草稿可能属于另一账号。此检查不覆盖旧版未绑定队列、其他账号/服务器缓存、离线附件缓存、其他浏览器配置或移动原生存储。

切换笔记时关闭弹窗；账号、服务器与跨窗口登录状态变化时取消结果。晚返回的旧请求不能填入当前检查。刷新请求失败会移除旧成功结果。产品界面只显示类别、计数和限制，不展示 SQL 表名、正文、引用内容或错误响应载荷。

## 内部原子转换（已实现，未接入 API/UI）

`convertEncryptedNoteStorage` 接受笔记 ID、所有者身份、预期版本、原正文 SHA-256、客户端生成的完整 envelope 和明确的 `discardHistory: true`。仅处理未配置任何同步 Profile 的 SQLite 数据库中的个人、未锁定/删除、没有局部加密区域的 Markdown 或基本富文本文本；媒体、附件、嵌入、不支持的富文本节点/标记、分享/评论/授权、模板、链接、文件夹同步、AI 引用、未审计关联存储、处理中向量任务以及活动/闲置协作房间均拒绝。删除或停用 Profile 不等于能撤回远端副本；数据库外的副本仍不在保证范围内。

调用必须独立于其他事务。`BEGIN IMMEDIATE` 内重新核对所有者、版本、正文摘要、格式和关联副本；任何失败均回滚。服务端只能验证 envelope 结构，不能认证 GCM 或证明客户端密文确实包含该正文；未来调用方必须完成本地加密、解密核对与来源确认，且 API 身份必须由认证层提供，不能信任请求中的 userId。

事务清理旧历史、块索引/快照/操作、Yjs 主文档与子文档数据、向量及队列、导入来源和本笔记的旧同步载荷；向量表存在时先按关联 embedding ID 删除 vec0 行。插入精确的事务许可后替换正文、清空 contentText 并增加版本。普通防丢失触发器会在正文更新前产生旧明文历史，事务在更新后再次清理这份预像；最终只写入一份可解密的密文历史。FTS 外部内容索引与归一化索引均从当前投影重建，删除可能不匹配旧 contentText 的过期词条，保留其他笔记的正文与检索能力。许可在提交前删除，错误或进程中断不会通过正常事务留下已提交的许可。

v119 迁移保留 v117 的 envelope/身份/降级守卫，转换必须匹配旧版本/格式、目标密文、新版本和个人身份；普通 PUT/Sync 仍无法申请许可。补齐块操作、协作回执、导入来源和向量队列的持久化禁止写入守卫。启动时重建的向量入队触发器与回填也跳过加密笔记，避免新建或重启时破坏边界。PostgreSQL 0119 提供相同目标/版本/身份及 txid 许可守卫，但没有启用 PostgreSQL 转换运行时。

内部返回 `logicalCleanup: true` 和 `physicalErasure: not_verified`，**不能解释为物理擦除或完整 M4 完成**。同步 Profile 的转换协议、浏览器缓存清理、跨窗口/其他设备和旧备份仍待闭环。现有只读接口继续 `canConvert: false`；不存在公开转换端点。

## 开放转换之前的剩余要求

1. 明确可转换的个人文本范围与关联处理策略。共享、附件、嵌入、模板、文件夹同步和 AI 引用须处理或阻止；禁止隐式删除其他对象。停止或拒绝在途协作和旧客户端写入。
2. 已实现上述本地存储事务。接入客户端来源/版本确认与解密核对；多设备需要独立转换协议和密文同步事件，不能复用普通 PUT 绕过守卫。
3. SQLite 存储阶段已有逐阶段失败、两连接隔离、v118 升级、旧 PUT/Sync/数据库/Yjs 写入保护及重启/备份守卫回归。仍需产品转换流程及真实多设备验收。
4. 客户端清理必须覆盖已声明的草稿、队列、正文/附件缓存和协作存储，并处理跨窗口、错误及确认策略；不能将清理失败当成成功。
5. 独立验证 SQLite FTS 内部页、WAL 和空闲页。逻辑删除或一次 checkpoint/VACUUM 不足以承诺物理擦除；文件系统快照、备份、用户导出和其他设备必须明示为无法自动撤回的副本。

接口目前始终返回 `canConvert: false` 和 `conversion_not_enabled`。即便来源记录为零，或检查响应被修改，UI 也不会提供可用的转换动作。不存在产品转换成功或物理擦除成功状态。

## 回归

后端 `encrypted-notes-conversion-preflight.test.ts` 在隔离 SQLite 中验证所有者权限、关联计数、损坏 AI 引用、缺表/新增存储、协作连接和检查前后写入计数/正文/历史一致。已有 encrypted-notes-storage 回归继续验证普通转换与降级被拒绝。

前端 encryption 专项包含只读浏览器检查与弹窗的存储失败、账号隔离、延迟响应、刷新失败、禁止转换和焦点/Esc 回归。真实生产 AppShell 的桌面及移动布局入口由 `encrypted-notes-conversion-preflight.spec.ts` 验证；移动布局不等同原生移动平台验收。

本轮本机验证：后端存储与前检查回归 13 项、前端加密专项 115 项、真实 AppShell 桌面/移动布局 1 项回归通过；前后端类型检查及前端生产构建通过。CI 已纳入后端前检查测试、源码变更触发路径及前端专项测试；AppShell 测试使用本机 Electron 隔离验收入口，未声称 CI 或原生移动验收完成。

内部转换追加 32 项 SQLite 实测，涵盖独立 OpenSSL 解密、16 张关联表清理、逐阶段 SQL 失败回滚、防丢失历史预像、精确许可、另连接读取/写入隔离、过期 FTS 词条、真实 sqlite-vec 行、v118 守卫升级和备份/重启。与既有加密/同步/备份及相关迁移验收合跑 75 项：74 通过，1 项历史任务迁移兼容测试在 v106 重放 `entitySet` 列时失败；移除本轮 v119 注册后仍复现相同错误，未修改该无关迁移。PostgreSQL 新增守卫测试已纳入既有 CI PostgreSQL job；本机无显式测试连接且 Docker 服务未运行，3 项 PG 测试跳过，不能称为已实测。

本轮产品回归：源码 Lite 桌面连接隔离生产后端，AppShell 账号/整篇/区域/原生 HTTP 及只读前检查 6 项通过；前端加密专项 115 项、前后端源码/转换测试类型检查与前端生产构建通过。公开转换入口仍禁用；这 6 项不包含尚未接通的用户转换流程。
