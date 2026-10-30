# v1.5.2 修复兼容性与威胁模型

本阶段在 `codex/release-152-hardening` 的独立检出实施，起点为 `99dbdef9`；原回归报告、失败 JSON、TAP 与附件原字节单独归档，原用户工作区不纳入本阶段修复。

后续已对齐发布 HEAD `65eda826`，最终被测代码 `98d1ddf5`。Native Repository 同样强制回收站/锁定条件。但 Sync V2 delete mutation 的协议仍可直接删除活动笔记，已动态复现并列为 P1 OPEN，不能把下面的 HTTP 外部契约泛化为全部同步入口。详见 [本阶段结果](README.md) 与 [协议设计](sync-delete-contract.md)。

## 删除契约

| 调用方 | 旧行为 | 本阶段行为及迁移 |
| --- | --- | --- |
| 普通 UI、CLI/MCP 默认删除 | 软删/回收站 | 保持软删；正文、历史、附件可恢复 |
| DELETE /api/notes/:id | 直接永久删除活动或回收站笔记 | 保留永久语义，但活动笔记返回 409 NOTE_NOT_TRASHED；先显式软删，再永久删除 |
| DELETE /api/notes/:id/permanent | 无 | 显式永久端点，与旧入口共用服务层前置条件/ACL/锁定检查 |
| SDK deleteNote | 文档明确“永久”，方法名容易混淆 | deprecated alias → permanentlyDeleteNote；不自动软删；已有调用方需先 trashNote |
| SDK permanentlyDeleteNote | 无 | 仅删除已在回收站的笔记；拒绝响应原样交给调用方 |
| MCP permanent=true / CLI --permanent | 永久删除活动笔记 | 迁移到显式端点，参数说明要求先在回收站；不自动增加隐式 PUT |
| Android 失败导入的空占位笔记 | 通用 DELETE 清理 | 先显式 isTrashed=1，再尝试永久删除；失败保留可恢复资源，不放宽服务层规则 |

这是有意收紧的安全兼容变更：旧客户端直接永久删除活动笔记不再成功。返回稳定错误码和升级步骤，而不是悄悄把显式永久调用变成另一种删除；旧回收站永久操作继续可用。需要调用者更新，不能宣称完全无行为变化。

服务层从权限/回收站状态检查到数据库删除持有 SQLite immediate 写事务，拒绝在清理附件前发生。提交后再做 Y.Doc 清理、空间回收和通知；没有引入活动笔记的“内部清理例外”。对应 DCC-007、DCC-002/004/012。文件删除仍不是数据库事务可回滚的物理操作，永久删除/恢复边界不得被描述为备份或安全擦除保证。

## Plugin Studio

已确认前提：硬链接需要同卷、受信任服务可读的文件及项目目录写权限；Studio create/write/import API 没有创建硬链接能力。需要同时保护用户选择的项目 ACL，不能把同一 OS 账号任意写入者等同于纯远程 Studio 用户。

修复：逐层路径验证拒绝硬链接；read/export 共用文件句柄读取。打开前记录 dev/ino，打开后 fstat 与路径身份比较，在读取前后重新验证路径、nlink、大小和修改时间；POSIX 使用 O_NOFOLLOW，Windows 依靠实际句柄身份。读取上限 2 MiB，避免手工放入超限文件被完整读入。write 的原子 rename 前再次验证目标。

这些措施覆盖已复现的硬链接以及叶文件/父目录在检查和打开之间被替换的读取缺口，不宣称完整 OS 沙箱。仍要求数据根/项目目录仅由服务账号及受信任 Node Action 写入；有任意本地写权限者能直接复制文件或持续替换目录，Node 跨平台路径 API 不能提供 openat/renameat 同等的整个目录事务隔离。写入创建/rename 的全部恶意父目录竞态、部署 ACL、可信 Node Action 边界需要单独记录，不能仅凭 nlink 或 realpath 宣告全部安全。

Windows 服务/SQLite 回归与 Linux 真实文件系统路径核心验证分开报告。安装包、容器和设备结果还需绑定最终源码 SHA，不能借源码测试通过代填。
