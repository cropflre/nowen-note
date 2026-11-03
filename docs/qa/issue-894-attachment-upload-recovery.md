# Issue #894：附件已上传但正文未插入链接

反馈：https://github.com/cropflre/nowen-note/issues/894

## 复现与范围

普通中文名 PDF 上传在当前分支的富文本、Markdown 浏览器入口均通过，未直接复现用户 Edge 环境的原始异常。已使用真实服务、临时数据库与 Chromium 复现一条和反馈一致的失败链路：

1. 从带表格的笔记上传中文名 PDF。
2. 浏览器测试等待真实上传请求返回 201，随后中断该响应。
3. 修复前，前端提示附件上传失败，正文没有新增链接，但附件记录及文件已经存在。
4. 再次上传同一文件，服务端复制新附件元数据，首次上传记录没有正文引用。

该实验确认响应丢失能产生 Issue 中的现象；没有用户现场日志，不能认定它是现场唯一原因。

## 修复

- 上传前生成 UUID，服务端以它标识该次附件写入；旧客户端不传时继续由服务端生成。
- 网络错误、超时、5xx 或缺失附件身份的响应出现后，前端按本次 UUID 查询已完成结果，不重新发送文件。恢复成功后沿用编辑器原有插入与保存流程。
- 查询要求当前账号对指定笔记有写权限，且附件上传者、笔记、UUID 均匹配；附件已回收或物理文件缺失时不能恢复。响应禁止缓存，不返回存储路径。
- 元数据 UUID 与新上传对象的物理路径分离，拒绝身份冲突并保护并发写入时原件字节。
- 查询失败、旧服务器没有恢复接口或身份/服务器变化时保留原始失败，不伪造成功。

关联契约：DCC-003（异常结果不能当成确定失败后盲目重复写入）、DCC-006（账号、服务器与笔记隔离）。没有修改正文保存事务、Outbox、同步游标或数据库结构。

## 自动化验收

- 前端：上传响应中断、超时、5xx、损坏 JSON；401/403/413 不恢复；旧服务器 404；返回错误 UUID；恢复前/期间切换账号、切换服务器。
- 后端：普通和 hash 去重上传的身份恢复、签名 URL、越权/错笔记/不存在/回收站/物理文件缺失拒绝、无效或冲突 UUID、并发同 UUID 原件保护。
- 浏览器：富文本、Markdown × 响应中断、损坏 JSON，共 4 个真实端到端场景；每个上传约 3.4 MB 中文名 PDF，确认仅一次 POST、一个附件记录、正文保存并重开仍有引用、下载字节一致、匿名恢复请求 401。

命令：

```sh
npm --prefix frontend run test:run -- src/lib/__tests__/attachmentUploadRecovery.test.ts src/lib/__tests__/uploadRequest.test.ts src/lib/__tests__/apiFileUpload.test.ts
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import ./backend/node_modules/tsx/dist/loader.mjs --test backend/tests/attachment-upload-recovery.test.ts
npm --prefix frontend run build
npm --prefix backend run build
(cd frontend && npx playwright test --config playwright.attachment-upload.config.ts)
node scripts/data-consistency-contract.mjs --verify
```

浏览器测试使用隔离 QA 服务，不访问现有私人笔记。未做真实 Edge、用户反向代理或生产部署验收；已有未引用的重复附件不会自动删除。恢复查询本身不可达或上传尚未落库时仍会保留失败提示。
