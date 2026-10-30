# Sync V2 永久删除契约：下一项 P1 修复设计

状态：**已实现源码修复与本地回归；部署和实机签核仍待完成，正式 NO-GO**。2026-10-16 后续实现见 [A01 修复与验证](../blocker-a01-sync-note-deletion.md)。以下保留原始复现与设计依据。

`evidence/sync-delete-audit-with-restore.json` 来自最终 `98d1ddf5` Docker 镜像的生产 API。活动笔记的 owner JWT 发出匹配 baseVersion 的 note/delete，返回 applied，随后 GET 404。HTTP 与 Native 防护均不能覆盖直接 Push 协议。

## 为什么不能只检查远端 isTrashed

离线“软删→永久删”的队列可能在发送前合并为一条 terminal delete，远端仍是活动状态；普通 delete payload 当前不携带正文。服务端突然拒绝所有 active delete，可能使旧客户端永久删除挂起；如果客户端已物理删本地正文，再拒绝也不能恢复那份本地副本。必须一起处理能力协商、旧 Outbox、ACK 前的可恢复快照及权限。

## 建议的最小完整协议

1. 登记永久删除为独立生命周期操作，服务端明确验证 manage、锁定、baseVersion 和回收站前置条件；保留 Sync V2 delete tombstone 对“已不存在”实体的幂等确认。
2. 协商生命周期能力；新客户端先发送并确认 soft-trash mutation，再允许 terminal permanent；Outbox 合并规则不能抹去必须确认的 trash 阶段。旧客户端未协商的 active delete 拒绝并返回明确错误，先进行兼容迁移与升级提示。
3. 本地在永久 ACK 前保留加密/受保护的删除恢复快照或墓碑正文，不能把未确认的删除当成已物理清理；失败、冲突、超时、切身份或重启均可读并可另存。不要清 Outbox 绕过拒绝。
4. 同一事务内完成服务端 ACL、版本、生命周期及数据库删除；附件清理、历史、知识树、Outbox、通知有明确失败策略，避免 Sync 直接 DELETE 绕过资源清理。已有缺失实体 delete 是幂等情况，不隐式恢复。
5. 对还没有服务器身份的本地空临时资源，使用受限取消创建事务，登记真正未发送条件；不建立通用 active-note 永久删除例外。

## 必须先失败后通过的回归

| 场景 | 核心断言 |
| --- | --- |
| owner 活动 note 的直接 Push delete | 明确拒绝；服务端正文、历史、附件、树、Outbox 不变 |
| 共享 editor 有 canDelete 无 manage、locked、restricted/deny | 授权负例不允许永久删除；不能只测 owner |
| 离线 soft→permanent，Outbox 合并，旧客户端升级 | trash 阶段不会丢；客户端明示迁移；旧未确认删除仍保留恢复副本 |
| 延迟/丢 ACK、Push 已提交后强杀、切账号、重试 | 同 mutationId 幂等；ACK 前副本可恢复；不存在跨身份写入 |
| 远端已删除、本地同时编辑、反向联网 | 双方意图有冲突/另存，不能静默复活或丢草稿 |
| 同 SHA 的 Web/Electron/Android | GUI 删除/恢复、正文与附件 SHA256、当前编辑收据及重启回读均有证据 |

升级与回滚：新服务端需识别旧删除请求并 fail closed，不能假定所有已安装客户端同时升级。数据库迁移应向前兼容保留恢复数据；降级到不识别生命周期的旧程序前，不可丢弃未确认 mutation 或新恢复快照。具体字段/迁移版本应在实现时沿现有 Native 和 Desktop Outbox 共用入口确定，本文件不创造另一套队列。
