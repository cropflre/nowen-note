# 第三阶段缺陷处置

最终代码 `98d1ddf5`；以下编号与第二阶段保持连续。源码链接均指向本地候选文件，避免为尚未推送的提交生成不可访问的 GitHub 链接。

| Bug / 等级 | 根因、影响与处置 | 证据 / 回归要求 |
| --- | --- | --- |
| BUG-02 / P1 | [HTTP service](../../../../backend/src/services/trash/noteTrashAdapter.ts) 缺回收站前置条件。已增加同事务 ACL/锁定/isTrashed 检查；[route](../../../../backend/src/routes/notes.ts) 两个端点共用。正文、历史、独占附件、知识树、Outbox 在拒绝时完整保留 | before-notes、after-notes、后端全量；实际 JWT HTTP、Windows 包、Docker。跨端永久删除冲突完整 GUI 仍缺，不将所有删除入口一起宣布关闭 |
| BUG-06 / P2，有条件的安全门禁 | [projectPaths](../../../../backend/src/plugins/studio/projectPaths.ts) 原本只拒绝 symlink。现在拒绝多链接，read/export 核验句柄身份与路径；本地可写目录及同卷是原硬链接攻击前提。已阻断复现；恶意父目录写/rename 与部署 ACL 仍需收敛 | Windows 全量+实际链接/替换、Linux 文件系统核心、Docker 真正 API 读/export。没有证明普通远程 API 能建立链接，不能虚构匿名漏洞或整个沙箱已安全 |
| BUG-01 / 测试问题 | 生产已有 coverageTranslations；原测试未初始化 i18n。修正测试；产品翻译缺失结论撤销 | 原失败→生产初始化通过；前端全量 |
| BUG-03 / P2 | [notes route](../../../../backend/src/routes/notes.ts) 将全部 SQLITE_CONSTRAINT 当作 notes.id 冲突。增加 NOTEBOOK_ID_REQUIRED/400；只对确定 ID 唯一异常返回 NOTE_ID_CONFLICT/409，其余 NOTE_CONSTRAINT_VIOLATION/400 | 缺 notebook、合法与重复 ID、真实触发器约束负例，后端全量。不存在/无权限目标可能由上游能力 guard 拒绝，未虚构统一状态码 |
| BUG-07 / P2 | [ServerAddressInput](../../../../frontend/src/components/ServerAddressInput.tsx) 把 focus 当成实际编辑，阻止异步恢复 host。移除 focus 设置，保留真实 onChange dirty guard | 原失败、新异步恢复/迟到属性不覆盖真实输入、全量；真实客户端账号切换矩阵未全部覆盖 |
| BUG-04 / P3 | [OpenAPI](../../../../backend/src/services/openapi.ts) export GET 路由与真实作业契约不符。已改为 job/status/download 并登记显式 permanent/409 | 实际 job→ready→ZIP下载；不是只看文档字符串 |
| BUG-05 / P3 | 旧尾斜杠兼容性需求尚未明确；正式无尾斜杠路径可用，本阶段没有扩大路由政策 | 保留旧观察，不声称全路径兼容修复 |
| BUG-08 / P1，阶段三引入并修复 | [api.impl](../../../../frontend/src/lib/api.impl.ts) 新 permanent 路由未匹配旧队列 ACK 清理，可能保留并重放已删除笔记的冲突更新。扩充路径，仅明确 success=true 时清理 | queue-before 1 FAIL→queue-after 11 PASS；409/503/网络失败/缺 ACK 保留正文；DCC-007 |
| BUG-09 / P1，阶段三事务暴露并修复 | [deny policy](../../../../backend/src/services/knowledgeDenyPolicy.ts) / [access policy](../../../../backend/src/services/knowledgeAccessPolicy.ts) 在事务内首次建表后缓存初始化；拒绝回滚表，但缓存不回滚，后续 API 500。只有非事务初始化才缓存 | 实际 HTTP 日志 no such table；policy-before FAIL→policy-after PASS；343 文件；不以 warmed schema 代验冷启动 |
| BUG-10 / P1，已修复 | [Native Repository](../../../../frontend/src/lib/nativeLocalRepository.ts) 的 API Bridge 永久删除绕过 HTTP 契约。本地事务重读最新状态，活动/锁定拒绝；使用最新版本入队 | native-delete-before FAIL→after PASS；最终真机 activePermanentDeletionRefusedWithRetainedBodyAndOutbox=true，3,630 全量 |
| **BUG-11 / P1 OPEN** | [Sync applyNote](../../../../backend/src/sync/apply.ts) 独立 delete mutation 直接 DELETE FROM notes；[scope](../../../../backend/src/sync/scope.ts) 使用 canDelete，未共用 HTTP 回收站/manage/锁定契约。活动笔记可绕过 HTTP/Native 前置条件 | **最终 Docker：owner JWT，活动 note，baseVersion 匹配，Push 200/applied，GET 404**；sync-delete-audit-with-restore.json。未证明共享 editor/匿名越权，不能称 P0；但正式门禁不能关闭 |

BUG-11 复现：在隔离 Docker 注册 fixture owner、新笔记本与 Markdown；保持 isTrashed=0，GET 取得 version；POST /api/sync/v2/push，scopeKey=personal，operation=delete、entityId=该 ID、baseVersion=该 version；返回 applied，GET 404。该观察是安全契约失败，不是因脚本 exit=0 而计为 PASS。

BUG-11 建议与测试要求在 [协议设计](sync-delete-contract.md)。它有独立协议兼容风险，不能仅把 HTTP helper 塞入同步 apply，忽略合并 Outbox、ACK 与本地保留正文。当前只有明示、有权限的 fixture 调用被证明；未把来源不明的旧失败或共享权限推断写成事实。
