# 缺陷复核与修复要求

> 最新修复状态、新增 BUG-08 至 BUG-11 见 [第三阶段缺陷记录](stage3/bugs.md)。下文为第二阶段原始证据与建议。

固定源码 SHA：`99dbdef9fa160ccce0f66aa0489dc964a28bc6cd`。本轮只提出方案，没有修改业务代码。数据安全失败不会因自动化 PASS、构建成功或 Windows 差异被降级为“无产品风险”。

## BUG-02 · P1 数据安全契约风险，已复现

源码：[`routes/notes.ts:1763`](https://github.com/cropflre/nowen-note/blob/99dbdef9fa160ccce0f66aa0489dc964a28bc6cd/backend/src/routes/notes.ts#L1763)、[`noteTrashAdapter.ts:13`](https://github.com/cropflre/nowen-note/blob/99dbdef9fa160ccce0f66aa0489dc964a28bc6cd/backend/src/services/trash/noteTrashAdapter.ts#L13)、[`acl.ts:147`](https://github.com/cropflre/nowen-note/blob/99dbdef9fa160ccce0f66aa0489dc964a28bc6cd/backend/src/middleware/acl.ts#L147)。适用条件是有 manage 权限的未锁定笔记；不是已证明的匿名或跨用户越权。

复现：在新临时数据库建 owner/other、笔记本、`isTrashed=0/version=4` 笔记、一条历史和独占附件；启用 ready SyncProfile 和本机 identity，先确认 Outbox gate=1。以 other DELETE 返回 403，锁定笔记 DELETE 返回 NOTE_LOCKED/403。以 owner DELETE 普通笔记返回 200。查 notes/history/attachments/tree 均为 0，物理附件不存在；Outbox 为 `note/delete/baseVersion=4/pending`。回收站为空；restore 返回 failures 内的 `TRASH_ITEM_NOT_FOUND`，HTTP 本身为 200，不能把它当恢复成功。重开数据库仍没有正文/历史。

实际 hardened bundle HTTP 也复现：仅伪造 `X-User-Id` 得 401；两个隔离账号实际登录后，other 得 403，owner 得 200，后续 GET 404，restore 明确失败。证据：[隔离实验](evidence/boundary-audit.json)、[真实 HTTP](evidence/http-bundle-proof.json)。

影响：应用内无法从回收站恢复该正文、历史和独占附件；触发器正确清理知识树并生成同步删除，不提供恢复能力。去重共享物理文件存在其他引用时应保留，既有 `note-delete-attachments` 第七例已通过。其他设备是否保留离线冲突副本、墓碑推送后的端到端行为本轮未实机验收；事前完整备份可能提供额外恢复来源，不能承诺已有备份或物理彻底擦除。

真实调用方：SDK `client.ts:222` 明确注释“删除笔记（永久）”，另有 `trashNote()`；MCP api-client `deleteNote()`、index.ts 的 `permanent` 参数默认 false；前端 `api.impl.ts` 仍暴露 DELETE，AndroidShareImportCenter `:359` 用于失败导入清理。不能把接口说成无人调用，也不能直接删接口或静默改 SDK 语义。

根因：通用 DELETE 直接进入永久删除 adapter。adapter 的权限解析可用于活动笔记，查询只检查 isLocked，既没有 `isTrashed=1` 前置条件，也没有将有效笔记永久删除作为独立、显式的高风险契约。

建议等级：**P1，发布阻断**。不可恢复删除后果确定，但 SDK/MCP 明确提供永久操作，尚未发现未经授权删除、普通主 UI 批量静默误删或广泛自动触发，所以不能仅凭可永久删除判为已证实 P0。若发现普通默认操作/自动调用可大规模误删、ACL/账号边界绕过或升级普遍丢数据，升级 P0；这不是将损失风险降为普通 P2。

建议方案：先登记所有调用方与临时资源清理需求，建立“普通删除→回收站”“已在回收站且 manage→永久删除”的外部契约；选用显式永久端点/参数和兼容期，SDK/MCP 清晰命名并迁移。需要活动临时资源清理的内部路径必须有限定，不可通过通用永久 API 形成任意活动笔记例外。服务层最终强制前置条件，不能只在 UI 加确认。

回归要求：普通/回收站/锁定/其他账号/共享 editor 与 owner/admin、restricted/deny、去重附件、历史/知识树、active SyncProfile 删除墓碑、SDK/MCP 两种删除、导入失败清理、在途编辑与删除冲突、重启和备份回读。必须断言恢复后正文/历史/附件字节，不能只验 HTTP 200 或不存在孤儿节点。

## BUG-06 · P2 文件隔离缺口；攻击前提未完全收敛

源码：[`projectPaths.ts:84`](https://github.com/cropflre/nowen-note/blob/99dbdef9fa160ccce0f66aa0489dc964a28bc6cd/backend/src/plugins/studio/projectPaths.ts#L84)、[`projectService.ts:155`](https://github.com/cropflre/nowen-note/blob/99dbdef9fa160ccce0f66aa0489dc964a28bc6cd/backend/src/plugins/studio/projectService.ts#L155) 及 `:239` 导出读取。

复现：只在隔离目录建立外部 JSON canary 文件；`fs.linkSync(external, project/hard.json)` 后 lstat.nlink=2。owner 的 Studio 文件读取 HTTP 200 返回外部 canary，项目导出 ZIP 也包含这些字节；另一个用户 403。默认/显式 file symlink 的 lstat 均为 true，访问返回 `PLUGIN_STUDIO_SYMLINK_REJECTED`/400；目录 junction 同样拒绝。路径遍历、禁止 .env 负例通过。证据：`boundary-audit.json.studio`。

原 symlink 测试本轮 5/5 PASS；原报告“Windows symlinkSync 没有真正创建 symlink”的根因在当前环境不成立。没有旧机器 lstat/reparse tag/读取结果，不能对历史失败作确定环境归因。

根因：逐层 lstat 只拒绝符号链接，未拒绝或验证硬链接；read/export 随后按路径打开。受影响字节必须是服务进程可读的文件，构造硬链接还要求同卷/文件系统支持及项目目录写权限。实验用本地 fs.linkSync 主动设置条件，**没有证明普通远程用户仅用 Studio API 能创建硬链接**。

已审查的 create/write/import 接口写普通文件；带 Unix symlink 属性的 ZIP entry 实验被写成普通文件，内容只是链接目标字符串，没有读出外部 canary。未审计所有可信 Node Action、部署卷权限与其他本地写入者，远程可达性不能声明已彻底排除。

另外，服务层受控插桩在 `resolveFile()` 检查后、`readFileSync()` 前替换为 symlink，成功读到外部 canary，证明检查/打开之间的边界。它是本地确定性插桩，不是实测并发利用成功；不能据此声称已经证明远程竞态漏洞。

建议：以 Windows/Linux 文件句柄、路径/身份核验及最小目录写权限共同收紧读取、导出、写入路径；硬链接拒绝可以补缺口，但 `nlink>1` 或单次 realpath 不是整个沙箱的安全证明。审计根目录/祖先替换和 check/open 时序，明确 Studio 与可信 Node Action 的威胁模型。若非受信任远程用户能写入这类链接/替换目录或由其他入口链式构造，至少升级 P1；当前 P2 是有前提的隔离缺陷，仍保持安全发布门禁未关闭。

回归：Windows/Linux 真实 symlink、junction（适用 Windows）、硬链接、路径遍历、ZIP entry、项目根/父目录替换、读取及 export 一致拒绝、并发目录替换、跨用户和 feature gate 关闭。Linux 和真实并发压力本轮 NOT_TESTED。

## BUG-01 · 原“缺少翻译”诊断被本轮证据否定

源码：`frontend/src/i18n/coverageTranslations.ts:171/189/779/797`、`i18n/index.ts` 的 mergeTranslationPatches。该补丁资源在引入翻译的 `8b0cb213` 就已存在，不能称为后来补齐。

复现区别：单跑 SyncStatusBadge/ServerConnectionSettings 测试输出 key；导入生产 i18n、设定语言后，原失败断言全通过。运行时资源探针直接检查 zh-CN/en 各命名空间，避免 fallback 掩盖英文缺项。仅搜索两个 locales JSON 不覆盖生产资源组合。

实际定性：**测试初始化问题**，撤销“P2 产品翻译缺失已确认”。证据：`production-i18n-render.json`、`production-i18n-resources.json`；两个组件原文件 7 个用例和新增资源用例共 8/8。

建议：统一测试 setup 使用生产 i18n，明确语言，或使用完整可核验的 I18nextProvider fixture；保留发布 i18n coverage。本轮现有 coverage 及相关行为共 42/42，通过不等于所有页面人工核验。不要为误诊重复添加覆盖已有翻译的业务补丁。

回归：中英真实渲染、状态计数插值、当前笔记收据、附件 pending、连接自动选择、切账号语言状态。原测试必须修至可独立运行，不能删关键文字断言。

## BUG-03 · P2 创建错误码误报，已确认原始 SQLite 类型

源码：[`notes.ts:768`](https://github.com/cropflre/nowen-note/blob/99dbdef9fa160ccce0f66aa0489dc964a28bc6cd/backend/src/routes/notes.ts#L768)。

复现：owner POST 普通笔记，给一个从未出现过的有效 UUID，但省略 notebookId；原始异常 `SQLITE_CONSTRAINT_NOTNULL / NOT NULL constraint failed: notes.notebookId`，返回却是 409 NOTE_ID_CONFLICT。带合法笔记本第一次 201，重复 ID 的真实异常 `SQLITE_CONSTRAINT_PRIMARYKEY / UNIQUE constraint failed: notes.id`，亦返回 409 NOTE_ID_CONFLICT。伪造 notebookId 在本轮裸 notes router 是 404“笔记本不存在”；全应用能力 guard 可在进入路由前返回 403，因此不能泛化为固定一个响应。

根因：将所有 SQLITE_CONSTRAINT* 统一解释为 ID 重复；缺少必填输入在入库前验证。证据：`boundary-audit.json.constraint`，只在临时 db.prepare 记录异常然后原样抛出，没有替换业务错误处理。

影响：客户端、SDK、离线创建把输入/模型错误误认为重复身份，可能无效重试；未证明每一种约束错误都已动态复现，不应虚构 FK/CHECK 实验。

建议：根据创建契约预校验 notebookId；仅确认 `notes.id` 的重复返回 409，其他约束按实际类型/字段映射安全错误。保留输入保护、事务回滚和调用方状态处理，不向用户直接泄露数据库结构。

回归：缺 notebookId、不存在/无权限/已删除笔记本、合法创建、同一 ID 重试、实际 FK/CHECK 负例、离线重复与队列行为、加密创建独立路径。

## BUG-07 · P2 登录地址恢复显示为空，新增真实 UI 缺陷

源码：[`ServerAddressInput.tsx:66`](https://github.com/cropflre/nowen-note/blob/99dbdef9fa160ccce0f66aa0489dc964a28bc6cd/frontend/src/components/ServerAddressInput.tsx#L66)、`:210`，[`LoginPage.tsx:856`](https://github.com/cropflre/nowen-note/blob/99dbdef9fa160ccce0f66aa0489dc964a28bc6cd/frontend/src/components/LoginPage.tsx#L856)。

复现：localStorage 保存 https://note.nowen.cn，mount `<LoginPage isClientMode>`；地址输入自动聚焦。父状态恢复公网 host、局域网发现正确消失，但输入仍为空。原用例三轮失败，补充纯组件在 blank→savedHost 更新也重现。证据：`login-address-dom.json`、`address-autofocus-observation.json`、`address-proof.json`。这是 React/jsdom DOM 复现，真实浏览器、Electron 页面和 Native WebView 本轮未人工验收。

根因：onFocus 就把 editingRef 设置为“正在修改”；value 同步 effect 因此不更新 displayText，把焦点存在与用户已经输入混为一谈。

影响：恢复的连接目标无法在地址框确认，用户可能以为空地址并重复填写；当前证据没有证明密码登录一定失败或连接目标被错改，因此定 P2，不扩大为 P1 数据泄露。

建议：把焦点与未提交的真实输入状态分开，未输入时接受外部恢复；保留用户实际正在键入、IME、光标位置和 blur 规范化的保护。不能简单取消全部 focus guard。

回归：autofocus + 异步恢复、记住账号/地址、切历史账号、用户先输入后迟到恢复、IME/IPv6/path-prefix/protocol、原 issue808 地址输入行为、真实桌面和移动页面。

## BUG-04/05 · P3 文档及路由兼容性

BUG-04 源码 `backend/src/services/openapi.ts:380` 宣告 `GET /api/export/{noteId}`，built hardened HTTP 实际 404；真实流程是 `POST /api/export/markdown-package/jobs`→ready→download。建议更新文档/SDK契约，使用正确 HTTP 方法逐路由探测，避免把 POST 端点 GET 404 误计成缺陷。回归需验证 schema、响应和真实下载，不只检查文档字符串。

BUG-05 历史“尾斜杠不一致”的全范围未重建；本轮直接 Hono 挂载实验 `/api/trash/` 404、`/api/trash` 200，保留了早期诊断失败日志。当前应用正式路径可用；若需要同时接受两种形式，应先明确路由兼容政策并覆盖两者，不能宣称它已造成所有客户端失败或已完整修复。

发布仍 NO-GO：删除契约、文件隔离、原套件失败收敛、原 crypto 失败定因及 Android/正式包证据都未完成。
