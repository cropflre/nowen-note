# v1.5.2 第四阶段：剩余同步改动提交复核

**可以提交本次限定修复；正式发版仍为 NO-GO。** 被测代码为 `91973d5a473ce2eab0eee41d5220e3d8e9bcc411`，基线为 `f07fbe1345b4c86ced4bfe22b7043bd20fb07055`。本轮没有推送、发布，也没有将自动化结果当成 Android 真机验收。

## 修复及回归证据

远端知识树移动原来只修改 `notes.notebookId/workspaceId`，没有推进正文版本。旧设备带着原目录和原 `baseVersion` 推送离线正文时，服务端会接受该正文并把笔记移回旧目录。隔离基线稳定复现该问题，以及移动后版本未增加的问题：`isolated-document-move-before-fix.log` 中两个命名用例失败，其余 52 个用例因筛选未执行。

最小修复位于 `backend/src/services/knowledgeTreeCore.ts::syncBusinessParent`：实际容器或工作区改变时增加版本，同一父级的排序不增加版本。回归覆盖个人/共享工作区、越权拒绝时数据不变、移动时正文不变，以及真实多库 HTTP 同步：旧正文进入冲突，远端新目录和本地离线正文同时保留，显式选择远端后收敛。关联 DCC-004、DCC-012。

另外，干净基线的四个旧 Native 永久删除测试步骤被新增防护正确拒绝，错误码为 `NOTE_NOT_TRASHED`。已改为先通过 Native 更新进入回收站；跨端删除场景先同步软删，再永久删除。仍然保留本地离线正文、待发送 mutation、冲突双方及防止旧更新复活笔记的原断言；补充活动笔记删除拒绝后正文和队列保留的断言。没有放宽永久删除保护，也没有修改尚未解决的 Sync V2 独立删除协议。

| 验证 | 实际结果 | 证据 |
| --- | --- | --- |
| 干净基线旧删除前置步骤 | 4 FAIL / 47 因筛选未执行 | `evidence/isolated-baseline-deletion-contract.log` |
| 干净基线移动缺陷 | 2 FAIL / 52 因筛选未执行 | `evidence/isolated-document-move-before-fix.log` |
| 正确隔离初始化的基线个人实体测试 | 23 PASS / 0 FAIL / 0 SKIP | `evidence/isolated-baseline-personal-entities.log` |
| 最终限定后端回归 | **21 文件 / 193 PASS / 0 FAIL / 0 SKIP** | `evidence/isolated-backend-results.json`、每文件 TAP 日志 |
| DCC 映射 | **12 契约 / 117 个不同用例引用通过** | `evidence/dcc-verify.log`；包括全部 10 个后端契约文件的上述真实执行 |

执行运行时为仓库 Electron Node 20.18.0 / ABI 130。最终执行使用仓库 `backend/scripts/run-tests-serial.mjs::runTestFile`，每个文件加载 `tests/setup-db-isolation.ts`，SQLite 位于系统临时目录。用例与运行器 snapshot、原始日志和清单见本目录；没有再运行前后端全量、正式客户端构建、真机 GUI 或 WAN 验收。

## 更正旧报告与执行失误

第三阶段后端全量真实执行于 `d7e0f9f6`，当时 343 文件通过；之后虽然整个 backend tree 相同，`98d1ddf5` 修改了后端测试会导入的前端 Native 代码。仅比较 backend tree 不能证明最终代码下的测试仍全绿。本轮干净基线的四个失败证明了这一点，已更正第三阶段 README、结果 JSON、集成记录和汇总脚本。历史原始全量日志保持原样，本次 193 用例通过不等于重新完成 343 文件全量。

本轮首次扩展测试漏载隔离初始化，访问了仓库根目录的 `data/nowen-note.db`；该轮结果不计入提交验收。用户已明确确认该库为测试库、没有需要保留的数据。保留误操作日志，并把该库及隔离工作区默认库的快照保存在仓库之外的 `C:/Users/cropf/.codex/merge-backups/nowen-note-release-152-0ad119e22aba/remaining-code-review/`，未以删除数据库或清空 Outbox 处理此失误。默认库上出现的 `NOTEBOOK_PARENT_NOT_FOUND` 在干净基线也出现；正确加载标准隔离初始化后，基线该文件 23 例全部通过。最终所有验收结果均来自之后的隔离复测。

同时归档之前未提交的 [Android 模拟器文件夹删除/恢复结果](../../../test-results/sync-v2-native-folder-trash-2026-10-11.json)。该文件记载旧源码 `bf105299`、设备 `emulator-5580`，仅作为历史记录，不是本次修复或当前 Android 真机的通过证据。

## 集成范围与限制

本次代码提交仅包含知识树容器版本修复、两份后端测试、DCC 映射。依赖锁文件的版本/peer 元数据变化、两份 Android 生成配置的行尾状态，以及三份 `.tmp-native-restore-read-*.json` 未纳入提交，原内容保留。

NO-GO 原因继续成立：BUG-11 Sync V2 独立 delete 可绕过回收站；Studio 写入竞态/部署 ACL、Android 完整产品矩阵、正式安装升级与部署升级回滚尚未关闭。此处只接受本次同步移动与受影响测试契约的限定源码验证。
