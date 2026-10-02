# Encrypted Notes M2：整篇文本编辑与密文持久化

状态：Web/桌面实验入口已接入，SQLite/Sync/完整 ZIP 恢复及 PostgreSQL 16 迁移已通过自动化验收；真实产品双设备、安装包与账号切换验收仍待完成，M2 保持实验性，不能据此关闭 #749 第 9 项。M0 移动端参数冻结、M3 完整验收、M4 旧笔记转换与 M5 跨端安全验收仍未完成；M5 的 Web/桌面闲置/后台自动锁定已接入。[用户说明](../user/encrypted-notes.md)、[Epic #796](https://github.com/cropflre/nowen-note/issues/796)、[envelope v1](./encrypted-notes-envelope-v1.md)。

## 已接入的路径

- 文档类型为 `encrypted-note-v1`，正文存原始 envelope 字符串，`contentText` 必须为空。知识树创建复用既有目录/根目录权限与事务；支持客户端 UUID，重复 ID 返回冲突，避免冲突副本重试生成重复笔记。
- `EditorPane` 外层按类型挂载专用 `EncryptedNotePane`，普通编辑器的自动保存、草稿、Yjs、附件上传、AI 与诊断快照不会挂载。独立 Markdown 文本编辑与 Tiptap 基础文字格式编辑仅持有内存明文；全局 Note 对象、API 与缓存只接收密文。
- 手动保存先经独立 Worker 加密，再提交 `updateNoteConfirmed` 与有效 revision/CAS。HTTP 错误不伪装为离线成功；网络中断才进入已有账号/服务器隔离队列，读回核对密文后才能锁定。待同步密文优先于旧远端/详情缓存；后续服务器确认保存清理旧队列。并发改变的队列保留。
- 队列冲突停止自动选择；即使后来出现另一条待保存记录，较早的未解决冲突也不能被绕过。重新打开使用最后一条待同步密文。显式冲突处理跳过普通草稿，只复制/覆盖密文；Sync V2 冲突中心保留两侧密文，拒绝智能合并与普通 JSON 手动编辑正文。改口令要求无未保存正文、无待同步队列且服务器确认成功。
- 切换笔记、标签页或视图及刷新/关闭页面保护未保存编辑；锁定销毁正文编辑器/撤销栈与口令引用。账号/服务器变化清理内存，账号内 token 续期保留会话。当前没有自动闲置锁定或崩溃前明文草稿恢复。
- HTTP 与 Sync 校验完整 envelope，拒绝参数越界、未知格式、明文正文/预览、对象身份或原格式更改；普通笔记不能直接转换。正文更新必须带明确加密类型；API 必须提供有效 version，Sync 复用 baseVersion 检查。首次 bootstrap 每页、增量/重建下载及冲突台账补全在持久化和推进游标/ACK 前校验；异常 Push 冲突响应不会清除本机密文，inflight 退回 pending。
- SQLite migration 117 提供持久写入/派生数据/历史触发器；旧客户端或绕开 API 的普通 SQL 写入不能把加密笔记降级为明文。PostgreSQL 0117 同步提供结构守卫；当前默认运行时仍为 SQLite，不代表已完成 PostgreSQL 产品运行时适配。
- 后端搜索提取、块索引和 embedding 处理跳过加密正文；公开分享、附件与 Yjs 写入被拒绝。历史、Sync outbox、冲突台账与完整 ZIP 备份保存 envelope，不做服务端解密。新进程/空数据库恢复会重新启用守卫，保留原 envelope 与加密历史。恢复路径补齐缺失的目标父目录，支持全新安装的 `plugins/installed` 布局。

数据库触发器检查结构/身份/固定 KDF/空预览，不执行 Argon2 或认证 GCM，也不代替入口完整的规范 base64 与长度校验。服务器没有解密密钥，不能识别结构正确但认证标签无效的密文；客户端解锁验证并保留原密文。旧数据库升级不会加密任何普通笔记。数据库降版本/恢复到不支持 migration 117 的旧应用不在支持范围内。

生产服务的 CSP 仅增加 `wasm-unsafe-eval` 以运行随包 WASM，不增加 JavaScript `unsafe-eval`。独立浏览器测试的页面与 Worker 在 CSP 下运行，Web 仍需安全上下文；安装包、移动端和反向代理覆盖 CSP 的部署需分别验收。

## 已验证与待验证

2026-10-02 补充：完整源码桌面 Lite 工作台的整篇创建/保存、真实注销、账号历史切换与生产 IPC 已纳入 5 项 [工作台验收](./encrypted-notes-app-acceptance.md)。尚未覆盖 Full 内置后端、签名安装包、真实双设备及全部账号/服务器组合，M2 保持实验性。

本地 2026-10-01：

- 102 项 Vitest：加密核心、Worker、类型/文本范围、离线队列失败/读回、最新待同步密文选择、旧冲突不可绕过、普通与加密缓存/冲突回归，以及 Sync V2 冲突中心拒绝加密正文手动/智能合并。
- 85 项后端测试（9 个文件）：其中 14 项加密专项覆盖创建、索引跳过、CAS/历史、旧写入与附件/分享/Yjs 拒绝、客户端 ID、严格 wire、两份独立数据库分页 bootstrap、真实 Sync V2 路由/Engine 离线冲突及显式解决、异常下载/Push 拒绝、完整 ZIP 在新进程/空库恢复；其余覆盖既有 bootstrap、Engine、冲突历史和备份完整性/回滚。
- PostgreSQL 16 独立本地 Docker 容器实测通过：真实迁移及正文/格式/历史/派生写入守卫和 revision 保留；只使用显式测试连接与随机 schema，测试后已清理容器。
- 10 项 Chromium 153：真实 bundled Worker/Web Crypto/WASM、失败关闭、MD/RT 创建/解锁/保存/锁定、改口令、冲突、离线刷新恢复与转在线队列清理；扫描测试请求、全局 Note、local/sessionStorage、所有 IndexedDB stores、SQLite tables、数据库文件/WAL，无公开测试正文或口令标记。
- 前后端及验收页 TypeScript、前端生产构建；6 个既有后端回归测试文件：根目录、目录权限、搜索、版本格式、知识树 Sync、本地 embedding 队列。

浏览器验收页挂载真实加密编辑/创建组件，使用独立轻量 AppContext fixture 与临时数据库的真实 notes 路由；未使用真实用户数据。它验证组件/持久化链路，不替代整个产品知识树、AppContext、账号切换、安装包或跨设备操作验收。同步测试使用真实 Sync V2 路由和 Engine，两份独立 SQLite 数据库及不同本机账号，经注入的 Hono request transport 请求协议；不是两台实体设备。完整 ZIP 使用产品 BackupManager 和生产流式恢复补丁，在新进程/空数据库恢复，通过公开独立向量认证解密并扫描 ZIP、恢复数据库及历史；不是产品备份 UI 的双设备验收。

`Encrypted Notes CI` 新增 PostgreSQL 16 独立服务，运行真实迁移与写入/历史/派生守卫测试。无显式 `TEST_PG_DATABASE_URL` 时该项跳过；本地专用 PostgreSQL 16 实测通过，远端 CI 仍须提交后确认。M2 的自动化同步和备份恢复链路已补齐；剩余为真实产品双设备、账号切换/注销及安装包验收。局部加密和 Web/桌面自动锁定已提供 [M3 验收记录](./encrypted-notes-m3.md)；移动真机性能和数据转换继续按 Epic 后续里程碑推进。

## 复验

后端测试使用 Node ABI 的 better-sqlite3。若当前安装的是 Electron ABI，先在 `backend` 执行 `npm rebuild better-sqlite3`，测试完成后仓库根目录 `npm run rebuild:native` 恢复本地开发所需 ABI。

```sh
# frontend
npx vitest run src/lib/encryptedNotes/__tests__ src/lib/__tests__/conflictResolution.test.ts src/lib/__tests__/noteLoadSource.test.ts src/lib/__tests__/syncConflictAutoMerge.test.ts src/components/__tests__/ConflictCenterBulkResolve.test.tsx
npx tsc -b --pretty false
npx tsc --project tsconfig.encrypted-notes.json --pretty false
npm run test:encrypted-notes:browser
npm run build

# backend
npx tsc --noEmit --pretty false
node --import tsx --import ./tests/setup-db-isolation.ts --test tests/encrypted-notes-storage.test.ts tests/encrypted-notes-sync.test.ts tests/encrypted-notes-backup.test.ts
# 专用 PostgreSQL 测试连接，不使用产品数据库；测试创建并清理随机 schema
node --import tsx --test tests/encrypted-notes-postgres.test.ts
```
