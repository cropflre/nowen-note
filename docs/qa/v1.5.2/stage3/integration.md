# 本地发布分支集成记录

2026-10-12，按用户“代码提交，然后合并到 1.5.2 分支”的授权，将 `codex/release-152-hardening` 的 7 个提交快进合并到本地 `release/v1.5.2`，从 `65eda826` 到 `5d2e5a48`。被测运行时代码仍为 `98d1ddf5`；集成及归档清单修正未改变 backend/frontend/packages 源码，原有用户未提交改动未纳入提交。

未跟踪的旧 QA 目录在合并前完整保存在 `C:/Users/cropf/.codex/merge-backups/nowen-note-release-152-0ad119e22aba/qa-before-merge/`；原有源码 patch 与文件哈希 snapshot 保存在同一备份目录。目标提交未涉及这些未提交源码路径。

合并后的独立检出发现，部分第二阶段文档/脚本的清单使用了提交前 CRLF 工作区 hashes，Git 中实际存的是 LF。已按实际检出字节修正清单，以 `preCommitCheckoutSha256` 保留旧值；原始测试日志、用户附件与第三阶段 206 份证据 bytes 没有改动。

集成验收：DCC 映射 12 个契约/116 个引用通过；两个 QA manifest 的 105 与 206 个文件 hashes 全部复核。保留前端 3,630 个真实通过、后端在 `d7e0f9f6` 上 343 文件通过的历史执行结果；本次集成未重新执行全量，也没有将用户当时未提交的同步改动算入原候选验收。

后续剩余改动复核更正了后端结果适用性：测试导入的 Native 前端源码在 `98d1ddf5` 中改变，backend tree 相同不能证明这些测试仍通过。干净 `f07fbe13` 的隔离复跑确认 4 个旧永久删除步骤被 `NOTE_NOT_TRASHED` 拒绝；对齐前置步骤并复测的证据见 [第四阶段](../stage4/README.md)。

**正式发版继续 NO-GO**：BUG-11 Sync V2 独立删除仍可绕过回收站且恢复失败；Studio 写入边界、Android 完整产品矩阵及正式安装升级等门禁尚未全部关闭。本操作是本地 Git 集成，没有推送、发布或对外回复。
