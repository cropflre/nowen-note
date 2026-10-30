# 文件管理：移动、中文文件名与公开外链（#837）

需求来源：[Issue #837](https://github.com/cropflre/nowen-note/issues/837)。实现位于开发分支，尚未正式发布。

## 需求分析与使用方式

用户希望文件管理更接近文件柜 / 网盘，具体提出三个可验收的需求。本次沿用附件存储、文件夹和文件分享体系，不新增独立网盘或 OSS 后端；现有附件存储已支持本地磁盘、S3、R2 和 MinIO。

| 需求 | 现有问题 | 实现与入口 |
| --- | --- | --- |
| 文件在文件夹之间移动 | 仅上传时可指定目标文件夹，之后没有移动操作 | 文件详情 → 移动文件；列表 → 多选 → 移动文件。可选现有文件夹或“未归档文件”。 |
| 中文上传文件名 | 本机标准 multipart 上传未复现替换下划线；客户端 / 代理传输有待实际用户复测 | 上传时额外传递 UTF-8 原文件名，服务端优先采用它；移动端网络上传复用 WebView 原始 multipart fetch。保留旧客户端只传 multipart filename 的兼容路径。 |
| 敏感文件关闭外链 | 已有分享撤销接口，但再次复制能自动创建新链接，没有持续关闭开关 | 文件详情 → 外链分享 → 取消“允许公开外链访问”。设置持久化，阻止新建文件外链，并拒绝笔记分享与发布页的公开附件读取。 |

移动只修改文件夹归属，不移动实际二进制，也不修改附件 ID、笔记绑定、内容 hash 或引用关系。批量上限 200 项；任何文件不存在、权限不符或数据库写入失败，整批保持原位置。只有文件上传者且具备对应写权限时可移动或修改外链设置；工作区中的只读成员不能因持有上传者身份而绕过限制。

Android / iOS “仅此设备”模式沿用已有本地文件夹门面，通过本地事务完成移动，不发送远端请求。其本地文件夹组织没有新增 Sync V2 协议。真实移动设备仍需复测。

## 隐私、存储与兼容边界

- 关闭的是**当前服务实例的公开外链**：现有文件分享 token 被撤销，新链接创建被拒绝；笔记分享和笔记本发布的附件签名也逐请求检查该开关。缩略图、媒体 Range 和 ETag / 304 请求不能跳过检查。
- 重新开启后可创建新文件外链，已撤销的文件分享 token 不会复活。此前签发的笔记分享 / 发布签名仍遵循对应分享实体和开关的当前状态。
- 本人和有权限的成员仍可预览、下载。用于会话预览的 user/file 临时签名地址仍有效，持有该临时地址的人在其有效期内仍可能读取文件；不要将它作为公开外链转发。这不是文件加密，也不会收回已经下载的副本。
- 策略与现有 `file_shares` 一样属于服务实例；保存在 SQLite 的 `attachment_link_policies` 表中，附件删除时级联清除。未扩展 Sync V2、笔记导入导出或跨实例策略传播，另一服务实例的副本须单独设置。
- 原有文件默认保留公开分享能力。已有下划线文件名无法从丢失的信息自动恢复，可在文件详情重命名。内容去重命中的旧文件继续保留已存储名称，避免重新上传悄悄覆盖用户的重命名。
- 旧服务端不支持新增操作；旧客户端可继续读取与上传，服务端仍执行已关闭的外链策略。降级到未实现该策略的服务端将不再执行它。
- 若对象存储桶本身公开，本开关不会改变桶权限或撤销桶直链；需要在对象存储侧控制访问。

## 技术与数据一致性

`POST /api/files/batch-move` 接收 `{ ids, folderId }`，`folderId: null` 表示未归档；成功返回 `moved`、`folderId`、`folderName`。服务端校验目标文件夹归属与每个附件的写权限，再在同一 SQLite 事务中更新。

`PATCH /api/files/:id/external-access` 接收 `{ enabled: boolean }`。策略更新和全部文件分享撤销在同一事务内提交。`GET /api/files/:id` 下发 `canManage`、`externalAccessEnabled` 与完整文件夹信息。界面仅在接口成功后改变确认状态，迟到响应不能修改新打开文件的设置。

关联 DCC-006（身份 / 作用域隔离）、DCC-007（显式删除边界）：新操作不得改动正文、附件身份或生成删除意图。移动不代表跨设备同步完成；本次不修改 Outbox / ACK / 拉取游标，不能从 REST 成功推断第二设备已收到文件夹组织或访问策略。

## 本地验证（2026-10-14）

- 后端：新增 `file-manager-organization.test.ts` 10 项测试，覆盖中文 / emoji 名称及下载头、旧上传兼容、非法名称、移动后引用与内容身份、整批拒绝与数据库失败回滚、实例重启持久化、重新开启不复活旧 token、只读工作区成员、缺失隐藏占位笔记投影，以及公开音频 Range 撤销。
- 既有后端回归：`attachment-file-share`、`attachment-shared-access`、`attachment-cache-contract`、`file-manager-manual-upload-visibility`、`attachment-modern-media`，26 项通过。
- 前端：文件组织组件、剪贴板、设备本地文件夹桥接、上传传输和公共域名相关回归，30 项通过；命令如下。涵盖失败时保留确认状态、关闭复制入口、只读界面与切换文件后的迟到响应。
- 浏览器：Chromium 桌面 1280×800 与窄屏 390×844 的真实组件检查通过，验证选择目标、移动后更新、开关关闭、预览 / 下载入口保留、无横向溢出。使用隔离的模拟 API，不等同于完整应用或安装包验收。截图保存于 `frontend/node_modules/.cache/issue837/`（忽略的本地 QA 产物）。
- 前后端类型检查、前后端构建、DCC 矩阵映射校验与 `git diff --check` 通过。未执行真实 Android / iOS 设备、Electron 安装包、Docker、生产 OSS、外部 CI 或正式发布验收。

```bash
# 当前 better-sqlite3 为 Electron ABI，保留它，使用 Electron 的 Node 模式运行临时库测试。
cd backend
ELECTRON_RUN_AS_NODE=1 ../node_modules/.bin/electron --import tsx --import ./tests/setup-db-isolation.ts --test --test-concurrency=1 tests/file-manager-organization.test.ts tests/attachment-file-share.test.ts tests/attachment-shared-access.test.ts tests/attachment-cache-contract.test.ts tests/file-manager-manual-upload-visibility.test.ts tests/attachment-modern-media.test.ts
npx tsc --noEmit
npm run build
cd ../frontend
npm run test:run -- src/components/__tests__/FileOrganization.test.tsx src/lib/__tests__/apiFileUpload.test.ts src/lib/__tests__/fileShareClipboard.test.ts src/lib/__tests__/mobileLocalAttachmentFolderBridge.test.ts src/lib/__tests__/uploadRequest.test.ts src/components/__tests__/FileManagerPublicOriginContract.test.ts
npm run build
cd ..
node scripts/data-consistency-contract.mjs --verify
git diff --check
```
